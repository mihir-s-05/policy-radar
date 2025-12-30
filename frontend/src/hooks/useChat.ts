import { useState, useCallback, useRef } from "react";
import { chatStream, chat, stopChat } from "../api/client";
import type { Message, Step, SourceItem, SourceSelection, ApiMode, CustomModelConfig, ModelProvider, EmbeddingConfig } from "../types";

interface UseChatOptions {
  sessionId: string | null;
}

export function useChat({ sessionId }: UseChatOptions) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentSteps, setCurrentSteps] = useState<Step[]>([]);
  const [currentSources, setCurrentSources] = useState<SourceItem[]>([]);
  const [reasoningSummary, setReasoningSummary] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const activeRequestIdRef = useRef<string | null>(null);
  const activeAssistantIdRef = useRef<string | null>(null);
  const stopRequestedRef = useRef(false);
  const cancelledMessage = "*Request cancelled by user.*";

  const markCancelledSteps = (steps: Step[]) =>
    steps.map((step) => {
      if (step.status !== "running") return step;
      const label = step.label ? `${step.label} (cancelled)` : "Cancelled";
      return {
        ...step,
        status: "error",
        label,
        result_preview: {
          ...(step.result_preview || {}),
          cancelled: true,
        },
      };
    });

  const handleStop = useCallback(async () => {
    if (!activeRequestIdRef.current) return;
    stopRequestedRef.current = true;
    abortRef.current?.abort();
    const requestId = activeRequestIdRef.current;
    try {
      await stopChat(requestId);
    } catch (err) {
      console.warn("Failed to stop chat:", err);
    } finally {
      activeRequestIdRef.current = null;
    }

    if (activeAssistantIdRef.current) {
      const assistantId = activeAssistantIdRef.current;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? {
              ...m,
              content: m.content.trim() ? m.content : cancelledMessage,
              isStreaming: false,
            }
            : m
        )
      );
    }
    setCurrentSteps((prev) => markCancelledSteps(prev));
    setIsLoading(false);
  }, []);

  const sendMessage = useCallback(
    async (
      content: string,
      sources: SourceSelection,
      days: number,
      model?: string,
      overrideSessionId?: string,
      apiMode?: ApiMode,
      customModel?: CustomModelConfig,
      apiKey?: string,
      provider?: ModelProvider,
      embeddingConfig?: EmbeddingConfig
    ) => {
      const effectiveSessionId = overrideSessionId || sessionId;
      if (!effectiveSessionId || !content.trim()) return;

      setError(null);
      setIsLoading(true);
      setCurrentSteps([]);
      setCurrentSources([]);
      setReasoningSummary(null);
      stopRequestedRef.current = false;

      const userMessage: Message = {
        id: `user-${Date.now()}`,
        role: "user",
        content: content.trim(),
      };
      setMessages((prev) => [...prev, userMessage]);

      const assistantId = `assistant-${Date.now()}`;
      activeAssistantIdRef.current = assistantId;
      const assistantMessage: Message = {
        id: assistantId,
        role: "assistant",
        content: "",
        isStreaming: true,
        steps: [],
        sources: [],
      };
      setMessages((prev) => [...prev, assistantMessage]);

      try {
        const requestId =
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `req-${Date.now()}`;
        activeRequestIdRef.current = requestId;
        abortRef.current = new AbortController();

        let finalContent = "";
        let finalSources: SourceItem[] = [];
        let finalSteps: Step[] = [];
        let finalReasoning: string | null = null;
        let finalModel: string | undefined = model;

        for await (const event of chatStream({
          session_id: effectiveSessionId,
          message: content,
          sources,
          days,
          model: customModel?.model_name || model,
          provider,
          api_mode: apiMode,
          custom_model: customModel,
          api_key: apiKey,
          request_id: requestId,
          embedding_config: embeddingConfig,
        }, abortRef.current.signal)) {
          if (stopRequestedRef.current) {
            break;
          }
          switch (event.type) {
            case "step": {
              const stepData = event.data;
              setCurrentSteps((prev) => {
                const existing = prev.find((s) => s.step_id === stepData.step_id);
                if (existing) {
                  return prev.map((s) =>
                    s.step_id === stepData.step_id
                      ? {
                        ...s,
                        ...stepData,
                        label: stepData.label ?? s.label,
                        tool_name: stepData.tool_name ?? s.tool_name,
                        args: stepData.args ?? s.args,
                      }
                      : s
                  );
                }
                return [
                  ...prev,
                  {
                    step_id: stepData.step_id,
                    status: stepData.status,
                    label: stepData.label || "",
                    tool_name: stepData.tool_name || "",
                    args: stepData.args || {},
                    result_preview: stepData.result_preview,
                  },
                ];
              });
              break;
            }

            case "reasoning_summary":
              setReasoningSummary(event.data.text);
              finalReasoning = event.data.text;
              break;

            case "assistant_delta":
              finalContent += event.data.delta;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId ? { ...m, content: finalContent } : m
                )
              );
              break;

            case "done":
              finalContent = event.data.answer_text;
              finalSources = event.data.sources;
              finalModel = event.data.model;
              setCurrentSources(finalSources);
              break;

            case "error":
              throw new Error(event.data.message);
          }
        }

        if (stopRequestedRef.current) {
          stopRequestedRef.current = false;
          setCurrentSteps((current) => {
            const updated = markCancelledSteps(current);
            finalSteps = updated;
            return updated;
          });
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? {
                  ...m,
                  content: finalContent.trim() ? finalContent : cancelledMessage,
                  sources: finalSources,
                  steps: finalSteps,
                  reasoning_summary: finalReasoning || undefined,
                  isStreaming: false,
                  model: finalModel,
                }
                : m
            )
          );
          return;
        }

        setCurrentSteps((current) => {
          finalSteps = current;
          return current;
        });

        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                ...m,
                content: finalContent,
                sources: finalSources,
                steps: finalSteps,
                reasoning_summary: finalReasoning || undefined,
                isStreaming: false,
                model: finalModel,
              }
              : m
          )
        );
      } catch (e) {
        const isAbort =
          e instanceof DOMException && e.name === "AbortError";

        if (isAbort || stopRequestedRef.current) {
          stopRequestedRef.current = false;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? {
                  ...m,
                  content: m.content.trim() ? m.content : cancelledMessage,
                  isStreaming: false,
                }
                : m
            )
          );
          setCurrentSteps((prev) => markCancelledSteps(prev));
          return;
        }

        console.error("Streaming failed, trying non-streaming:", e);

        try {
          const response = await chat({
            session_id: effectiveSessionId,
            message: content,
            sources,
            days,
            model: customModel?.model_name || model,
            provider,
            api_mode: apiMode,
            custom_model: customModel,
            api_key: apiKey,
            request_id: activeRequestIdRef.current || undefined,
            embedding_config: embeddingConfig,
          });

          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? {
                  ...m,
                  content: response.answer_text,
                  sources: response.sources,
                  steps: response.steps,
                  reasoning_summary: response.reasoning_summary,
                  isStreaming: false,
                  model: response.model,
                }
                : m
            )
          );
          setCurrentSteps(response.steps);
          setCurrentSources(response.sources);
          setReasoningSummary(response.reasoning_summary || null);
        } catch (fallbackError) {
          const errorMessage =
            fallbackError instanceof Error
              ? fallbackError.message
              : "An error occurred";
          setError(errorMessage);
          setMessages((prev) => prev.filter((m) => m.id !== assistantId));
        }
      } finally {
        setIsLoading(false);
        activeRequestIdRef.current = null;
        activeAssistantIdRef.current = null;
        abortRef.current = null;
      }
    },
    [sessionId]
  );

  const clearMessages = useCallback(() => {
    setMessages([]);
    setCurrentSteps([]);
    setCurrentSources([]);
    setReasoningSummary(null);
    setError(null);
  }, []);

  const loadMessages = useCallback((history: Message[], sources?: SourceItem[]) => {
    setMessages(history);
    setCurrentSteps([]);
    setCurrentSources(sources || []);
    setReasoningSummary(null);
    setError(null);
  }, []);

  const updateMessageContent = useCallback((messageId: string, content: string) => {
    setMessages((prev) =>
      prev.map((message) =>
        message.id === messageId ? { ...message, content } : message
      )
    );
  }, []);

  return {
    messages,
    isLoading,
    error,
    currentSteps,
    currentSources,
    reasoningSummary,
    sendMessage,
    stopChat: handleStop,
    clearMessages,
    loadMessages,
    updateMessageContent,
  };
}
