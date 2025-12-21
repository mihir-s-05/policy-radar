import { useEffect, useState } from "react";
import { useSession } from "./hooks/useSession";
import { useChat } from "./hooks/useChat";
import { getSessionMessages, updateMessage } from "./api/client";
import { ChatInput, ChatSidebar, MessageList, WorkLog, SourceCards } from "./components";
import type { Message, SearchMode, SourceItem } from "./types";

function App() {
  const {
    sessionId,
    sessions,
    isLoading: sessionLoading,
    error: sessionError,
    refreshSessions,
    createNewSession,
    selectSession,
    removeSession,
  } = useSession();
  const {
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
  } = useChat({ sessionId });

  const [mode, setMode] = useState<SearchMode>("both");
  const [days, setDays] = useState(30);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const isChatBusy = isLoading || historyLoading || sessionLoading;

  const aggregateSources = (historyMessages: Message[]): SourceItem[] => {
    const seen = new Set<string>();
    const aggregated: SourceItem[] = [];

    for (const message of historyMessages) {
      if (!message.sources) continue;
      for (const source of message.sources) {
        const key = source.url || source.id;
        if (seen.has(key)) continue;
        seen.add(key);
        aggregated.push(source);
      }
    }

    return aggregated;
  };

  const handleNewChat = async () => {
    clearMessages();
    try {
      await createNewSession();
    } catch (err) {
      console.error("Failed to create new session:", err);
    }
  };

  const handleSelectSession = (nextSessionId: string) => {
    if (nextSessionId === sessionId || isChatBusy) {
      return;
    }
    clearMessages();
    selectSession(nextSessionId);
  };

  const loadHistoryForSession = async (
    targetSessionId: string,
    clearExisting: boolean = true
  ) => {
    setHistoryLoading(true);
    setHistoryError(null);
    if (clearExisting) {
      loadMessages([]);
    }

    try {
      const response = await getSessionMessages(targetSessionId);
      const historyMessages: Message[] = response.messages.map((item) => ({
        id: `history-${item.id}`,
        db_id: item.id,
        role: item.role,
        content: item.content,
        created_at: item.created_at,
        sources: item.sources || undefined,
      }));

      const aggregatedSources = aggregateSources(historyMessages);
      loadMessages(historyMessages, aggregatedSources);
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : "Failed to load history");
    } finally {
      setHistoryLoading(false);
    }
  };

  const handleSendMessage = async (message: string, nextMode: SearchMode, nextDays: number) => {
    await sendMessage(message, nextMode, nextDays);
    if (sessionId) {
      await loadHistoryForSession(sessionId, false);
    }
    await refreshSessions().catch(() => undefined);
  };

  useEffect(() => {
    if (!sessionId) return;

    const loadHistory = async () => {
      await loadHistoryForSession(sessionId);
    };

    loadHistory();
  }, [sessionId]);

  const handleEditMessage = async (messageId: string, dbId: number, content: string) => {
    if (!sessionId) return;

    try {
      await updateMessage(sessionId, dbId, { content });
      updateMessageContent(messageId, content);
      await refreshSessions();
    } catch (err) {
      console.error("Failed to update message:", err);
      throw err;
    }
  };

  if (sessionLoading) {
    return (
      <div className="app-loading">
        <div className="loading-spinner" />
        <p>Initializing session...</p>
      </div>
    );
  }

  if (sessionError) {
    return (
      <div className="app-error">
        <h2>Connection Error</h2>
        <p>{sessionError}</p>
        <button onClick={() => window.location.reload()}>Retry</button>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background font-sans text-foreground">
      <main className="grid flex-1 grid-cols-1 overflow-hidden p-4 gap-4 md:grid-cols-[280px_1fr] lg:grid-cols-[280px_1fr_340px]">
        <ChatSidebar
          sessions={sessions}
          activeSessionId={sessionId}
          isLoading={sessionLoading}
          isBusy={isChatBusy}
          onSelect={handleSelectSession}
          onNewChat={handleNewChat}
          onDeleteSession={removeSession}
        />
        <div className="relative flex flex-col overflow-hidden rounded-xl border bg-card shadow-sm">
          <MessageList
            messages={messages}
            isLoading={historyLoading}
            onEditMessage={handleEditMessage}
            isBusy={isChatBusy}
          />
          {historyError && (
            <div className="mx-4 mb-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              <p>{historyError}</p>
            </div>
          )}
          {error && (
            <div className="mx-4 mb-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              <p>{error}</p>
            </div>
          )}
          <ChatInput
            onSend={handleSendMessage}
            isLoading={isChatBusy}
            mode={mode}
            days={days}
            onModeChange={setMode}
            onDaysChange={setDays}
          />
        </div>

        <aside className="hidden flex-col gap-4 overflow-y-auto rounded-xl border bg-card p-4 shadow-sm lg:flex">
          <div className="flex flex-col gap-4">
            <WorkLog steps={currentSteps} reasoningSummary={reasoningSummary} />
          </div>
          <div className="flex flex-col gap-4">
            <SourceCards sources={currentSources} />
          </div>
        </aside>
      </main>
    </div>
  );
}

export default App;
