import { useEffect, useState, useRef } from "react";
import { useSession } from "./hooks/useSession";
import { useChat } from "./hooks/useChat";
import { getSessionMessages, updateMessage, getConfig } from "./api/client";
import { ChatInput, ChatSidebar, MessageList, WorkLog, SourceCards } from "./components";
import type { Message, SearchMode, SourceItem } from "./types";
import { PanelLeftClose, PanelLeft, PanelRightClose, PanelRight } from "lucide-react";
import { Button } from "./components/ui/Button";

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
  const [model, setModel] = useState("gpt-5.2");
  const [availableModels, setAvailableModels] = useState<string[]>(["gpt-5.2", "gpt-5.1", "gpt-5", "o3", "gpt-5-mini"]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(false);
  const [rightSidebarCollapsed, setRightSidebarCollapsed] = useState(false);
  const isNewSessionRef = useRef(false);

  useEffect(() => {
    getConfig()
      .then((config) => {
        setAvailableModels(config.available_models);
        setModel(config.model);
      })
      .catch((err) => console.error("Failed to load config:", err));
  }, []);

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

  const handleNewChat = () => {
    clearMessages();
    selectSession("");
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

  const handleSendMessage = async (message: string, nextMode: SearchMode, nextDays: number, nextModel: string) => {
    let currentSessionId = sessionId;

    if (!currentSessionId) {
      try {
        isNewSessionRef.current = true;
        currentSessionId = await createNewSession();
      } catch (err) {
        isNewSessionRef.current = false;
        console.error("Failed to create session:", err);
        return;
      }
    }

    await sendMessage(message, nextMode, nextDays, nextModel, currentSessionId);
    isNewSessionRef.current = false;
    await refreshSessions().catch(() => undefined);
  };

  useEffect(() => {
    if (!sessionId || isNewSessionRef.current) return;

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
        <p>Loading...</p>
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
      <main
        className="grid flex-1 overflow-hidden p-4 gap-4 transition-all duration-300"
        style={{
          gridTemplateColumns: `${leftSidebarCollapsed ? "48px" : "280px"} 1fr ${rightSidebarCollapsed ? "48px" : "340px"}`,
        }}
      >
        <ChatSidebar
          sessions={sessions}
          activeSessionId={sessionId}
          isLoading={sessionLoading}
          isBusy={isChatBusy}
          onSelect={handleSelectSession}
          onNewChat={handleNewChat}
          onDeleteSession={removeSession}
          isCollapsed={leftSidebarCollapsed}
          onToggleCollapse={() => setLeftSidebarCollapsed(!leftSidebarCollapsed)}
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
            model={model}
            availableModels={availableModels}
            onModeChange={setMode}
            onDaysChange={setDays}
            onModelChange={setModel}
          />
        </div>

        <aside className="hidden flex-col gap-4 overflow-hidden rounded-xl border bg-card shadow-sm lg:flex transition-all duration-300">
          <div className="flex items-center justify-between border-b bg-card px-4 py-3">
            {!rightSidebarCollapsed && (
              <h3 className="text-sm font-semibold">Details</h3>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setRightSidebarCollapsed(!rightSidebarCollapsed)}
              aria-label={rightSidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              {rightSidebarCollapsed ? (
                <PanelLeft className="h-4 w-4" />
              ) : (
                <PanelRightClose className="h-4 w-4" />
              )}
            </Button>
          </div>
          {!rightSidebarCollapsed && (
            <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
              <WorkLog steps={currentSteps} reasoningSummary={reasoningSummary} />
              <SourceCards sources={currentSources} />
            </div>
          )}
        </aside>
      </main>
    </div>
  );
}

export default App;
