import type {
  SessionResponse,
  ChatRequest,
  ChatResponse,
  StepEvent,
  ReasoningSummaryEvent,
  AssistantDeltaEvent,
  DoneEvent,
  ErrorEvent,
  SessionListResponse,
  MessagesResponse,
  FetchContentRequest,
  FetchContentResponse,
  UpdateMessageRequest,
  UpdateMessageResponse,
  ConfigResponse,
  ValidateModelRequest,
  ValidateModelResponse,
  OAuthStartResponse,
  OAuthTokenResponse,
  OAuthCallbackRequest,
  OAuthCallbackResponse,
  OAuthRefreshResponse,
  OAuthLogoutResponse,
} from "../types";

const API_BASE = import.meta.env.VITE_API_BASE ?? (import.meta.env.DEV ? "http://localhost:8000" : "");
const BROWSER_TOKEN_KEY = "policy-radar-browser-token";
let browserToken: string | undefined;
let browserExecution = false;
export const isBrowserExecution = () => browserExecution;
export const apiTransport = (path: string, options?: RequestInit) => apiFetch(`${API_BASE}${path}`, options);

function apiFetch(url: string, options: RequestInit = {}): Promise<Response> {
  if (!browserToken) {
    try {
      const stored = localStorage.getItem(BROWSER_TOKEN_KEY);
      if (stored && /^[a-f0-9]{64}$/.test(stored)) browserToken = stored;
    } catch { /* Keep this browser capability in memory if storage is unavailable. */ }
    if (!browserToken) {
      browserToken = Array.from(crypto.getRandomValues(new Uint8Array(32)),
        byte => byte.toString(16).padStart(2, "0")).join("");
      try { localStorage.setItem(BROWSER_TOKEN_KEY, browserToken); } catch { /* In-memory fallback. */ }
    }
  }
  const headers = new Headers(options.headers);
  headers.set("X-Session-Token", browserToken);
  return fetch(url, { ...options, headers });
}

export async function createSession(): Promise<SessionResponse> {
  const response = await apiFetch(`${API_BASE}/api/session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) throw new Error(`Failed to create session: ${response.statusText}`);
  return response.json();
}

export async function deleteSession(sessionId: string): Promise<void> {
  const response = await apiFetch(`${API_BASE}/api/sessions/${sessionId}`, {
    method: "DELETE",
  });

  if (!response.ok) {
    throw new Error(`Failed to delete session: ${response.statusText}`);
  }
  if (browserExecution) await (await import("../lib/browserEmbeddings")).deleteDocumentIndex(sessionId);
}

export async function getConfig(): Promise<ConfigResponse> {
  const response = await apiFetch(`${API_BASE}/api/config`, {
    method: "GET",
  });

  if (!response.ok) {
    throw new Error(`Failed to load config: ${response.statusText}`);
  }

  const config = await response.json() as ConfigResponse;
  browserExecution = config.execution_mode === "browser";
  return config;
}

export async function listSessions(): Promise<SessionListResponse> {
  const response = await apiFetch(`${API_BASE}/api/sessions`, {
    method: "GET",
  });

  if (!response.ok) {
    throw new Error(`Failed to load sessions: ${response.statusText}`);
  }

  return response.json();
}

export async function getSessionMessages(
  sessionId: string
): Promise<MessagesResponse> {
  const response = await apiFetch(`${API_BASE}/api/sessions/${sessionId}/messages`, {
    method: "GET",
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(error.detail || `Failed to load messages: ${response.statusText}`);
  }

  return response.json();
}

export async function fetchContent(
  request: FetchContentRequest
): Promise<FetchContentResponse> {
  if (browserExecution) {
    const document = await (await import("./browserDocuments")).readDocument(request.url, apiTransport, undefined, request.max_length || 500_000);
    return { url: request.url, title: document.title, full_text: document.full_text };
  }
  const response = await apiFetch(`${API_BASE}/api/content/fetch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(error.detail || `Content fetch failed: ${response.statusText}`);
  }

  return response.json();
}

export async function updateMessage(
  sessionId: string,
  messageId: number,
  request: UpdateMessageRequest
): Promise<UpdateMessageResponse> {
  const response = await apiFetch(
    `${API_BASE}/api/sessions/${sessionId}/messages/${messageId}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    }
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(error.detail || `Failed to update message: ${response.statusText}`);
  }

  return response.json();
}

export async function chat(request: ChatRequest): Promise<ChatResponse> {
  if (browserExecution) return (await import("./browserChat")).browserChatOnce(request, apiTransport);
  const response = await apiFetch(`${API_BASE}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(error.detail || `Chat request failed: ${response.statusText}`);
  }

  return response.json();
}

export async function validateModel(
  request: ValidateModelRequest
): Promise<ValidateModelResponse> {
  const response = await apiFetch(`${API_BASE}/api/validate-model`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(error.detail || `Validation request failed: ${response.statusText}`);
  }

  return response.json();
}

export async function stopChat(request_id: string): Promise<void> {
  const response = await apiFetch(`${API_BASE}/api/chat/stop`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ request_id }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(error.detail || `Stop request failed: ${response.statusText}`);
  }
}

export type SSEEvent =
  | { type: "step"; data: StepEvent }
  | { type: "reasoning_summary"; data: ReasoningSummaryEvent }
  | { type: "assistant_delta"; data: AssistantDeltaEvent }
  | { type: "done"; data: DoneEvent }
  | { type: "error"; data: ErrorEvent };

export async function* chatStream(
  request: ChatRequest,
  signal?: AbortSignal
): AsyncGenerator<SSEEvent, void, unknown> {
  if (browserExecution) {
    yield* (await import("./browserChat")).browserChat(request, apiTransport, signal);
    return;
  }
  const response = await apiFetch(`${API_BASE}/api/chat/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
    },
    cache: "no-store",
    body: JSON.stringify(request),
    signal,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(error.detail || `Stream request failed: ${response.statusText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("No response body");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  const abortReader = () => {
    try {
      reader.cancel();
    } catch {
    }
  };

  if (signal?.aborted) {
    abortReader();
    return;
  }
  signal?.addEventListener("abort", abortReader, { once: true });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      let currentEvent = "";
      let currentData = "";

      for (const line of lines) {
        if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          currentData = line.slice(5).trim();

          if (currentEvent && currentData) {
            try {
              const data = JSON.parse(currentData);
              yield { type: currentEvent, data } as SSEEvent;
            } catch {
              console.error("Failed to parse SSE data:", currentData);
            }
            currentEvent = "";
            currentData = "";
          }
        }
      }
    }
  } finally {
    signal?.removeEventListener("abort", abortReader);
    reader.releaseLock();
  }
}

// OAuth API Functions

export async function startOAuthFlow(): Promise<OAuthStartResponse> {
  const response = await apiFetch(`${API_BASE}/api/oauth/openai/start`, {
    method: "GET",
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(error.detail || `Failed to start OAuth flow: ${response.statusText}`);
  }

  return response.json();
}

export async function getOAuthStatus(): Promise<OAuthTokenResponse> {
  const response = await apiFetch(`${API_BASE}/api/oauth/openai/status`, {
    method: "GET",
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(error.detail || `Failed to get OAuth status: ${response.statusText}`);
  }

  return response.json();
}

export async function submitOAuthCallback(
  request: OAuthCallbackRequest
): Promise<OAuthCallbackResponse> {
  const response = await apiFetch(`${API_BASE}/api/oauth/openai/callback`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(error.detail || `OAuth callback failed: ${response.statusText}`);
  }

  return response.json();
}

export async function refreshOAuthToken(): Promise<OAuthRefreshResponse> {
  const response = await apiFetch(`${API_BASE}/api/oauth/openai/refresh`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(error.detail || `Failed to refresh OAuth token: ${response.statusText}`);
  }

  return response.json();
}

export async function logoutOAuth(): Promise<OAuthLogoutResponse> {
  const response = await apiFetch(`${API_BASE}/api/oauth/openai/logout`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(error.detail || `Failed to logout: ${response.statusText}`);
  }

  return response.json();
}
