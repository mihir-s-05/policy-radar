import { useEffect, useRef, useState, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { User, Feather } from "lucide-react";
import { Button } from "./ui/Button";
import { Textarea } from "./ui/Textarea";
import type { Message } from "../types";
import { cn } from "../lib/utils";

function QuillIcon({ className }: { className?: string }) {
  return (
    <Feather className={className} />
  );
}

function ManuscriptStreamingText({ content, isStreaming }: { content: string; isStreaming: boolean }) {
  if (isStreaming && !content) {
    return (
      <div className="typing-indicator flex items-center gap-1 py-3">
        <span />
        <span />
        <span />
      </div>
    );
  }

  return (
    <div className={cn(
      "manuscript-unfurl-wrapper scroll-top-curl relative",
      isStreaming && "scroll-curl"
    )}>
      <div className={cn(
        "streaming-text relative px-5 py-4",
        isStreaming && "manuscript-unfurl"
      )}>
        <div className="prose-manuscript max-w-none">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ href, children }) => (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium underline underline-offset-4 decoration-dotted hover:decoration-solid"
                  style={{ color: "hsl(30, 60%, 35%)" }}
                >
                  {children}
                </a>
              ),
              p: ({ children }) => (
                <p className="mb-3 last:mb-0">{children}</p>
              ),
              ul: ({ children }) => (
                <ul className="ml-5 list-disc space-y-1.5 mb-3">{children}</ul>
              ),
              ol: ({ children }) => (
                <ol className="ml-5 list-decimal space-y-1.5 mb-3">{children}</ol>
              ),
              h1: ({ children }) => (
                <h1 className="text-2xl font-display font-bold mb-3 text-parchment-900">{children}</h1>
              ),
              h2: ({ children }) => (
                <h2 className="text-xl font-display font-semibold mb-2 text-parchment-900">{children}</h2>
              ),
              h3: ({ children }) => (
                <h3 className="text-lg font-display font-medium mb-2 text-parchment-800">{children}</h3>
              ),
              strong: ({ children }) => (
                <strong className="font-semibold" style={{ color: "hsl(25, 40%, 15%)" }}>{children}</strong>
              ),
              blockquote: ({ children }) => (
                <blockquote className="border-l-3 border-sepia-accent pl-4 italic text-muted-foreground my-3">
                  {children}
                </blockquote>
              ),
            }}
          >
            {content}
          </ReactMarkdown>
          {isStreaming && <span className="streaming-cursor" />}
        </div>
      </div>
    </div>
  );
}

interface MessageListProps {
  messages: Message[];
  isLoading?: boolean;
  isBusy?: boolean;
  onSuggestedInquiry?: (suggestion: string) => void;
  onEditMessage?: (
    messageId: string,
    dbId: number,
    content: string
  ) => Promise<void> | void;
  onSendMessage?: (content: string) => void;
}

const SUGGESTED_INQUIRIES = [
  "Summarize recent EPA rulemakings on emissions.",
  "Find Federal Register notices about AI safety from last week.",
  "What are the latest DHS updates on border security?",
  "Search for new SEC regulations regarding cryptocurrency.",
  "What are the recent FDA guidelines on food safety?",
  "List Department of Energy notices from the past 30 days.",
  "Show me OSHA updates related to workplace heat safety.",
  "Find recent FAA rulemakings on commercial drone use.",
  "What are the latest FTC actions on consumer privacy?",
  "Summarize recent Department of Education policy changes.",
  "Find USDA notices about agricultural subsidies this month.",
  "What are the latest DOI updates on tribal land management?",
];


export function MessageList({
  messages,
  isLoading,
  isBusy,
  onSuggestedInquiry,
  onEditMessage,
  onSendMessage,
}: MessageListProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const randomSuggestions = useMemo(() => {
    return [...SUGGESTED_INQUIRIES]
      .sort(() => Math.random() - 0.5)
      .slice(0, 3);
  }, []);


  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (editingId && !messages.some((message) => message.id === editingId)) {
      setEditingId(null);
      setDraft("");
      setEditError(null);
    }
  }, [messages, editingId]);

  if (messages.length === 0) {
    if (isLoading) {
      return (
        <div className="flex h-full flex-col items-center justify-center p-8 text-center">
          <div className="flex flex-col items-center gap-4">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <p className="text-muted-foreground manuscript-font">Loading previous session...</p>
          </div>
        </div>
      );
    }

    return (
      <div className="flex h-full flex-col items-center justify-center p-8 text-center">
        <div className="parchment-bg aged-edge flex max-w-lg flex-col gap-6 rounded-lg p-8">
          <div className="flex flex-col items-center gap-3">
            <div className="flourish-divider w-full mb-2">
              <span className="px-4 text-2xl" style={{ fontFamily: "'IM Fell English SC', serif" }}>
                ❦
              </span>
            </div>
            <h2
              className="text-3xl font-bold tracking-wide ink-text"
              style={{ fontFamily: "'IM Fell English SC', serif", letterSpacing: "0.15em" }}
            >
              Policy Archives
            </h2>
            <p
              className="text-sm ink-faded mt-1"
              style={{ fontFamily: "'IM Fell English', serif" }}
            >
              Track federal regulatory activity, analyze rulemakings, and search
              official documents with AI assistance.
            </p>
          </div>

          <div className="flourish-divider w-full">
            <span className="px-3 text-lg">✦</span>
          </div>

          <div className="flex flex-col gap-3 text-left">
            <p
              className="font-medium ink-text text-sm"
              style={{ fontFamily: "'IM Fell English SC', serif", letterSpacing: "0.05em" }}
            >
              Suggested Inquiries:
            </p>
            <div className="flex flex-col gap-2">
              {randomSuggestions.map((suggestion, i) => (
                <button
                  key={i}
                  onClick={() => !isBusy && onSendMessage?.(suggestion)}
                  disabled={isBusy}
                  className="w-full text-left cursor-pointer rounded-md px-3 py-2 text-sm transition-colors hover:bg-parchment-300/50 ink-text active:bg-parchment-400/50 disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{
                    fontFamily: "'IM Fell English', serif",
                    borderLeft: "2px solid hsl(30, 40%, 55%)",
                    background: "none",
                  }}
                >
                  "{suggestion}"
                </button>
              ))}
            </div>

          </div>

          <div className="flourish-divider w-full">
            <span className="px-4 text-2xl" style={{ fontFamily: "'IM Fell English SC', serif" }}>
              ❧
            </span>
          </div>
        </div>
      </div>
    );
  }

  const startEditing = (message: Message) => {
    setEditingId(message.id);
    setDraft(message.content);
    setEditError(null);
  };

  const cancelEditing = () => {
    setEditingId(null);
    setDraft("");
    setEditError(null);
  };

  const saveEdit = async (message: Message) => {
    if (!onEditMessage || !message.db_id) return;
    const nextContent = draft.trim();
    if (!nextContent) {
      setEditError("Message cannot be empty.");
      return;
    }

    setIsSaving(true);
    setEditError(null);
    try {
      await onEditMessage(message.id, message.db_id, nextContent);
      setEditingId(null);
      setDraft("");
    } catch (error) {
      setEditError(
        error instanceof Error ? error.message : "Failed to save edit."
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-4 md:p-6">
      {messages.map((message) => {
        const isUser = message.role === "user";
        return (
          <div
            key={message.id}
            className={cn(
              "flex w-full max-w-3xl gap-4 md:gap-6 message-bubble items-start",
              isUser ? "ml-auto flex-row-reverse" : "mr-auto"
            )}
          >
            <div
              className={cn(
                "flex h-9 w-9 shrink-0 items-center justify-center rounded-full border shadow-sm",
                isUser
                  ? "btn-wax border-none"
                  : "parchment-bg border-sepia-light/50"
              )}
            >
              {isUser ? (
                <User className="h-4 w-4" />
              ) : (
                <QuillIcon className="h-4 w-4 ink-text" />
              )}
            </div>

            <div
              className={cn(
                "flex min-w-0 flex-1 flex-col",
                isUser ? "items-end" : "items-start"
              )}
            >
              <div
                className={cn(
                  "relative max-w-full",
                  isUser && "parchment-bg rounded-2xl rounded-br-sm px-5 py-3 border border-sepia-light/30 shadow-parchment"
                )}
              >
                {editingId === message.id ? (
                  <div className="flex w-full min-w-[300px] flex-col gap-2">
                    <Textarea
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      rows={3}
                      disabled={isSaving}
                      className="bg-parchment-100/50 text-inherit border-sepia-light/50"
                    />
                    {editError && (
                      <div className="text-xs text-destructive">{editError}</div>
                    )}
                    <div className="flex gap-2">
                      <Button
                        onClick={() => saveEdit(message)}
                        disabled={isSaving}
                        size="sm"
                        className="btn-wax"
                      >
                        Save
                      </Button>
                      <Button
                        onClick={cancelEditing}
                        disabled={isSaving}
                        size="sm"
                        variant="ghost"
                        className="hover:bg-parchment-300/50"
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="break-words text-sm leading-relaxed">
                    {message.role === "assistant" ? (
                      message.isStreaming ? (
                        <ManuscriptStreamingText
                          content={message.content}
                          isStreaming={true}
                        />
                      ) : (
                        <div className="manuscript-unfurl-wrapper scroll-top-curl">
                          <div className="px-5 py-4">
                            <div className="prose-manuscript max-w-none">
                              <ReactMarkdown
                                remarkPlugins={[remarkGfm]}
                                components={{
                                  a: ({ href, children }) => (
                                    <a
                                      href={href}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="font-medium underline underline-offset-4 decoration-dotted hover:decoration-solid"
                                      style={{ color: "hsl(30, 60%, 35%)" }}
                                    >
                                      {children}
                                    </a>
                                  ),
                                  p: ({ children }) => (
                                    <p className="mb-3 last:mb-0">{children}</p>
                                  ),
                                  ul: ({ children }) => (
                                    <ul className="ml-5 list-disc space-y-1.5 mb-3">{children}</ul>
                                  ),
                                  ol: ({ children }) => (
                                    <ol className="ml-5 list-decimal space-y-1.5 mb-3">{children}</ol>
                                  ),
                                  strong: ({ children }) => (
                                    <strong className="font-semibold" style={{ color: "hsl(25, 40%, 15%)" }}>{children}</strong>
                                  ),
                                }}
                              >
                                {message.content}
                              </ReactMarkdown>
                            </div>
                          </div>
                        </div>
                      )
                    ) : (
                      <div
                        className="whitespace-pre-wrap ink-text"
                        style={{ fontFamily: "'IM Fell English', serif" }}
                      >
                        {message.content}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {!editingId && isUser && onEditMessage && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => startEditing(message)}
                  disabled={isBusy || isSaving}
                  className="mt-1 h-6 px-2 text-xs hover:bg-transparent hover:underline"
                  style={{ fontFamily: "'IM Fell English SC', serif", color: "hsl(25, 40%, 25%)" }}
                >
                  Edit
                </Button>
              )}

              {!isUser && message.model && !message.isStreaming && (
                <span
                  className="mt-1.5 text-[10px] ink-faded"
                  style={{ fontFamily: "'IM Fell English SC', serif", letterSpacing: "0.05em" }}
                >
                  {message.model}
                </span>
              )}
            </div>
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
