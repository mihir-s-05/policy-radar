import { useEffect, useState, useRef, useMemo } from "react";
import { useSession } from "./hooks/useSession";
import { useChat } from "./hooks/useChat";
import { getSessionMessages, updateMessage, getConfig } from "./api/client";
import { ChatInput, ChatSidebar, MessageList, WorkLog, SourceCards, loadSourcesFromStorage, SettingsModal, loadSettings } from "./components";
import type { UserSettings } from "./components";
import { FoxingOverlay } from "./components/FoxingOverlay";
import type { Message, SourceSelection, SourceItem, ProviderInfo } from "./types";
import { PanelLeft, PanelRightClose } from "lucide-react";
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

  const [sources, setSources] = useState<SourceSelection>(loadSourcesFromStorage());
  const [days, setDays] = useState(30);
  const [model, setModel] = useState("gpt-5.2");
  const [availableModels, setAvailableModels] = useState<string[]>(["gpt-5.2", "gpt-5-mini", "gpt-5.1", "o3"]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(false);
  const [rightSidebarCollapsed, setRightSidebarCollapsed] = useState(false);
  const isNewSessionRef = useRef(false);
  const [providers, setProviders] = useState<Record<string, ProviderInfo>>({});
  const [userSettings, setUserSettings] = useState<UserSettings>(() => loadSettings());

  useEffect(() => {
    getConfig()
      .then((config) => {
        setAvailableModels(config.available_models);
        setModel(config.model);
        setUserSettings((prev) => ({
          ...prev,
          model: prev.model || config.model,
        }));
        if (config.providers) {
          setProviders(config.providers);
        }
      })
      .catch((err) => console.error("Failed to load config:", err));
  }, []);

  const isChatBusy = isLoading || historyLoading || sessionLoading;

  const combinedAvailableModels = useMemo(() => {
    const provider = userSettings.provider || "openai";
    if (provider === "custom") {
      return userSettings.customModels.map(m => m.model_name);
    }
    const userModels = userSettings.providerModels?.[provider as keyof typeof userSettings.providerModels];
    if (userModels && userModels.length > 0) {
      return userModels;
    }
    const providerInfo = providers[provider];
    return providerInfo?.models || availableModels;
  }, [providers, availableModels, userSettings.provider, userSettings.customModels, userSettings.providerModels]);

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

  const handleSendMessage = async (message: string, nextSources: SourceSelection, nextDays: number, nextModel: string) => {
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

    const provider = userSettings.provider || "openai";
    const customModel = provider === "custom"
      ? userSettings.customModels.find(m => m.model_name === nextModel)
      : undefined;
    const apiMode = provider === "openai" ? userSettings.apiMode : "chat_completions";
    const apiKey = userSettings.apiKeys?.[provider as keyof typeof userSettings.apiKeys] || undefined;

    await sendMessage(
      message,
      nextSources,
      nextDays,
      nextModel,
      currentSessionId,
      apiMode,
      customModel,
      apiKey,
      provider
    );
    isNewSessionRef.current = false;
    await refreshSessions().catch(() => undefined);
  };

  useEffect(() => {
    if (!combinedAvailableModels.length) return;
    if (!combinedAvailableModels.includes(model)) {
      const nextModel = combinedAvailableModels[0];
      setModel(nextModel);
      setUserSettings((prev) => ({ ...prev, model: nextModel }));
    }
  }, [combinedAvailableModels, model]);

  useEffect(() => {
    if (userSettings.model && userSettings.model !== model) {
      setModel(userSettings.model);
    }
  }, [userSettings.model, model]);

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
      <div className="flex h-screen w-screen items-center justify-center">
        <div className="parchment-bg aged-edge flex flex-col items-center gap-4 rounded-lg p-8">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-sepia-brown border-t-transparent" />
          <p
            className="ink-faded"
            style={{ fontFamily: "'IM Fell English', serif", fontStyle: "italic" }}
          >
            Opening the archives...
          </p>
        </div>
      </div>
    );
  }

  if (sessionError) {
    return (
      <div className="flex h-screen w-screen items-center justify-center">
        <div className="parchment-bg aged-edge flex flex-col items-center gap-4 rounded-lg p-8 max-w-md">
          <h2
            className="text-xl font-bold ink-text"
            style={{ fontFamily: "'IM Fell English SC', serif" }}
          >
            Connection Error
          </h2>
          <p
            className="text-center ink-faded"
            style={{ fontFamily: "'IM Fell English', serif" }}
          >
            {sessionError}
          </p>
          <Button
            onClick={() => window.location.reload()}
            className="btn-wax"
          >
            <span style={{ fontFamily: "'IM Fell English SC', serif" }}>Retry</span>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden font-body">
      <FoxingOverlay />
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
        <div className="relative flex flex-col overflow-hidden rounded-xl border border-sepia-light/40 parchment-bg shadow-document">
          <MessageList
            messages={messages}
            isLoading={historyLoading}
            onEditMessage={handleEditMessage}
            isBusy={isChatBusy}
          />
          {historyError && (
            <div className="mx-4 mb-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              <p style={{ fontFamily: "'IM Fell English', serif" }}>{historyError}</p>
            </div>
          )}
          {error && (
            <div className="mx-4 mb-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              <p style={{ fontFamily: "'IM Fell English', serif" }}>{error}</p>
            </div>
          )}
          <ChatInput
            onSend={handleSendMessage}
            isLoading={isChatBusy}
            sources={sources}
            days={days}
            model={model}
            availableModels={combinedAvailableModels}
            onSourcesChange={setSources}
            onDaysChange={setDays}
            onModelChange={(nextModel) => {
              setModel(nextModel);
              setUserSettings((prev) => ({ ...prev, model: nextModel }));
            }}
            settingsModal={
              <SettingsModal
                settings={userSettings}
                onSettingsChange={setUserSettings}
                providers={providers}
                defaultApiMode="responses"
              />
            }
          />
        </div>

        <aside className="hidden flex-col gap-4 overflow-hidden rounded-xl border border-sepia-light/40 parchment-bg shadow-document lg:flex transition-all duration-300">
          <div className="flex items-center justify-between border-b border-sepia-light/30 bg-card px-4 py-3">
            {!rightSidebarCollapsed && (
              <h3
                className="text-sm font-semibold ink-text"
                style={{ fontFamily: "'IM Fell English SC', serif", letterSpacing: "0.05em" }}
              >
                Particulars
              </h3>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 ink-faded hover:ink-text"
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
