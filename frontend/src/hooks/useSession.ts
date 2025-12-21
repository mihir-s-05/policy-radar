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
    setSessionId(nextSessionId);
    localStorage.setItem(SESSION_KEY, nextSessionId);
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
      const storedSessionId = localStorage.getItem(SESSION_KEY);
      const existingSessions = await refreshSessions();
      const hasStored =
        storedSessionId &&
        existingSessions.some((s) => s.session_id === storedSessionId);

      if (hasStored) {
        setSessionId(storedSessionId);
        return;
      }

      if (existingSessions.length > 0) {
        selectSession(existingSessions[0].session_id);
        return;
      }

      await createNewSession();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create session");
    } finally {
      setIsLoading(false);
    }
  }, [createNewSession, refreshSessions, selectSession]);

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
