import { useState, useEffect, useCallback } from "react";
import { createSession, listSessions, deleteSession } from "../api/client";
import type { SessionInfo } from "../types";

const SESSION_KEY = "policy_radar_session_id";

export function useSession() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshSessions = useCallback(async () => {
    const response = await listSessions();
    setSessions(response.sessions);
    return response.sessions;
  }, []);

  const selectSession = useCallback((nextSessionId: string) => {
    if (nextSessionId) {
      setSessionId(nextSessionId);
      localStorage.setItem(SESSION_KEY, nextSessionId);
    } else {
      setSessionId(null);
      localStorage.removeItem(SESSION_KEY);
    }
  }, []);

  const createNewSession = useCallback(async () => {
    const response = await createSession();
    selectSession(response.session_id);
    await refreshSessions();
    return response.session_id;
  }, [refreshSessions, selectSession]);

  const removeSession = useCallback(async (targetId: string) => {
    try {
      await deleteSession(targetId);
      if (sessionId === targetId) {
        setSessionId(null);
        localStorage.removeItem(SESSION_KEY);
      }
      await refreshSessions();
    } catch (err) {
      console.error("Failed to delete session:", err);
    }
  }, [sessionId, refreshSessions]);

  const initSession = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      await refreshSessions();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load sessions");
    } finally {
      setIsLoading(false);
    }
  }, [refreshSessions]);

  useEffect(() => {
    initSession();
  }, [initSession]);

  return {
    sessionId,
    sessions,
    isLoading,
    error,
    refreshSessions,
    createNewSession,
    selectSession,
    removeSession,
  };
}
