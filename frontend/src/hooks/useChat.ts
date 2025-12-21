import { useState, useCallback } from "react";
import { chatStream, chat } from "../api/client";
import type { Message, Step, SourceItem, SearchMode } from "../types";

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

  const sendMessage = useCallback(
    async (content: string, mode: SearchMode, days: number, model?: string, overrideSessionId?: string) => {
      const effectiveSessionId = overrideSessionId || sessionId;
      if (!effectiveSessionId || !content.trim()) return;

      setError(null);
      setIsLoading(true);
      setCurrentSteps([]);
      setCurrentSources([]);
      setReasoningSummary(null);

      const userMessage: Message = {
        id: `user-${Date.now()}`,
        role: "user",
        content: content.trim(),
      };
      setMessages((prev) => [...prev, userMessage]);

      const assistantId = `assistant-${Date.now()}`;
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
        let finalContent = "";
        let finalSources: SourceItem[] = [];
        let finalSteps: Step[] = [];
        let finalReasoning: string | null = null;
        let finalModel: string | undefined = model;

        for await (const event of chatStream({
          session_id: effectiveSessionId,
          message: content,
          mode,
          days,
          model,
        })) {
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
        console.error("Streaming failed, trying non-streaming:", e);

        try {
          const response = await chat({
            session_id: effectiveSessionId,
            message: content,
            mode,
            days,
            model,
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
    clearMessages,
    loadMessages,
    updateMessageContent,
  };
}
