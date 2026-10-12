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
      try{localStorage.setItem(SESSION_KEY, nextSessionId);}catch{/* The conversation itself is stored in IndexedDB. */}
    } else {
      setSessionId(null);
      try{localStorage.removeItem(SESSION_KEY);}catch{/* Selection can stay in memory. */}
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
        try{localStorage.removeItem(SESSION_KEY);}catch{/* Selection can stay in memory. */}
      }
      await refreshSessions();
    } catch (err) {
      setError(err instanceof Error?err.message:"Failed to delete session");
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

  useEffect(()=>{
    const changed=()=>{selectSession("");setError(null);void refreshSessions().catch(err=>setError(err instanceof Error?err.message:"Failed to refresh saved conversations"));};
    window.addEventListener("policy-data-changed",changed);
    return ()=>window.removeEventListener("policy-data-changed",changed);
  },[refreshSessions,selectSession]);

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
