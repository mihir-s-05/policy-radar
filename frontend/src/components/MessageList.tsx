import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { User, Bot } from "lucide-react";
import { Button } from "./ui/Button";
import { Textarea } from "./ui/Textarea";
import type { Message } from "../types";
import { cn } from "../lib/utils";

interface MessageListProps {
  messages: Message[];
  isLoading?: boolean;
  isBusy?: boolean;
  onEditMessage?: (
    messageId: string,
    dbId: number,
    content: string
  ) => Promise<void> | void;
}

export function MessageList({
  messages,
  isLoading,
  isBusy,
  onEditMessage,
}: MessageListProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

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
            <p className="text-muted-foreground">Load previous session...</p>
          </div>
        </div>
      );
    }

    return (
      <div className="flex h-full flex-col items-center justify-center p-8 text-center text-muted-foreground">
        <div className="flex max-w-md flex-col gap-6">
          <div className="flex flex-col items-center gap-2">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Bot className="h-6 w-6" />
            </div>
            <h2 className="text-2xl font-bold tracking-tight text-foreground">
              Policy Radar
            </h2>
            <p className="text-sm">
              Track federal regulatory activity, analyze rulemakings, and search
              official documents with AI assistance.
            </p>
          </div>
          <div className="flex flex-col gap-2 rounded-lg border bg-card/50 p-4 text-left text-sm">
            <p className="font-medium text-foreground">Try asking:</p>
            <ul className="flex flex-col gap-2">
              <li className="cursor-pointer rounded px-2 py-1 hover:bg-accent hover:text-accent-foreground">
                "Summarize recent EPA rulemakings on emissions."
              </li>
              <li className="cursor-pointer rounded px-2 py-1 hover:bg-accent hover:text-accent-foreground">
                "Find Federal Register notices about AI safety from last week."
              </li>
              <li className="cursor-pointer rounded px-2 py-1 hover:bg-accent hover:text-accent-foreground">
                "What are the latest DHS updates on border security?"
              </li>
            </ul>
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
              "flex w-full max-w-3xl gap-4 md:gap-6",
              isUser ? "ml-auto flex-row-reverse" : "mr-auto"
            )}
          >
            <div
              className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border shadow-sm",
                isUser
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-muted text-muted-foreground border-border"
              )}
            >
              {isUser ? (
                <User className="h-4 w-4" />
              ) : (
                <Bot className="h-4 w-4" />
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
                  "relative max-w-full rounded-2xl px-5 py-3 shadow-sm",
                  isUser
                    ? "bg-primary text-primary-foreground rounded-br-sm"
                    : "bg-card text-card-foreground border rounded-bl-sm"
                )}
              >
                {editingId === message.id ? (
                  <div className="flex w-full min-w-[300px] flex-col gap-2">
                    <Textarea
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      rows={3}
                      disabled={isSaving}
                      className="bg-background/50 text-inherit"
                    />
                    {editError && (
                      <div className="text-xs text-destructive">{editError}</div>
                    )}
                    <div className="flex gap-2">
                      <Button
                        onClick={() => saveEdit(message)}
                        disabled={isSaving}
                        size="sm"
                        variant={isUser ? "secondary" : "default"}
                      >
                        Save
                      </Button>
                      <Button
                        onClick={cancelEditing}
                        disabled={isSaving}
                        size="sm"
                        variant="ghost"
                        className={isUser ? "hover:bg-primary-foreground/10 hover:text-primary-foreground" : ""}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="break-words text-sm leading-relaxed">
                    {message.role === "assistant" ? (
                      <div className="prose prose-invert max-w-none hover:prose-a:text-blue-400">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            a: ({ href, children }) => (
                              <a
                                href={href}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="font-medium underline underline-offset-4 hover:text-accent-foreground"
                              >
                                {children}
                              </a>
                            ),
                            p: ({ children }) => (
                              <p className="mb-2 last:mb-0">{children}</p>
                            ),
                            ul: ({ children }) => (
                              <ul className="ml-4 list-disc space-y-1 mb-2">{children}</ul>
                            ),
                            ol: ({ children }) => (
                              <ol className="ml-4 list-decimal space-y-1 mb-2">{children}</ol>
                            )
                          }}
                        >
                          {message.content}
                        </ReactMarkdown>
                      </div>
                    ) : (
                      <div className="whitespace-pre-wrap">{message.content}</div>
                    )}
                    {message.isStreaming && !message.content && (
                      <span className="ml-1 animate-pulse">...</span>
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
                  className="mt-1 h-6 px-2 text-xs opacity-0 transition-opacity group-hover:opacity-100 hover:bg-transparent hover:underline"
                >
                  Edit
                </Button>
              )}
            </div>
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
