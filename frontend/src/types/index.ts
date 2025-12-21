export type SourceType =
  | "regulations_document"
  | "regulations_docket"
  | "govinfo_result"
  | "govinfo_package";

export interface SourceItem {
  source_type: SourceType;
  id: string;
  title: string;
  agency: string | null;
  date: string | null;
  url: string;
  excerpt: string | null;
}

export interface Step {
  step_id: string;
  status: "running" | "done" | "error";
  label: string;
  tool_name: string;
  args: Record<string, unknown>;
  result_preview?: Record<string, unknown>;
}

export type SearchMode = "regulations" | "govinfo" | "both";

export interface ChatRequest {
  session_id: string;
  message: string;
  mode: SearchMode;
  days: number;
}

export interface ChatResponse {
  answer_text: string;
  sources: SourceItem[];
  reasoning_summary?: string;
  steps: Step[];
}

export interface SessionResponse {
  session_id: string;
}

export interface SessionInfo {
  session_id: string;
  created_at: string;
  last_message: string | null;
  last_message_at: string | null;
  title: string | null;
}

export interface SessionListResponse {
  sessions: SessionInfo[];
}

export interface MessageItem {
  id: number;
  role: "user" | "assistant";
  content: string;
  created_at: string;
  sources?: SourceItem[] | null;
}

export interface MessagesResponse {
  session_id: string;
  messages: MessageItem[];
}

export interface FetchContentRequest {
  url: string;
  max_length?: number;
  full_text?: boolean;
}

export interface FetchContentResponse {
  url: string;
  title?: string | null;
  full_text?: string | null;
  error?: string | null;
}

export interface UpdateMessageRequest {
  content: string;
}

export interface UpdateMessageResponse {
  updated: boolean;
}

export interface ConfigResponse {
  model: string;
}

export interface StepEvent {
  step_id: string;
  status: "running" | "done" | "error";
  label?: string;
  tool_name?: string;
  args?: Record<string, unknown>;
  result_preview?: Record<string, unknown>;
}

export interface ReasoningSummaryEvent {
  text: string;
}

export interface AssistantDeltaEvent {
  delta: string;
}

export interface DoneEvent {
  answer_text: string;
  sources: SourceItem[];
  response_id: string;
}

export interface ErrorEvent {
  error: string;
  message: string;
  retry_after?: number;
  status_code?: number;
}

export interface Message {
  id: string;
  db_id?: number;
  role: "user" | "assistant";
  content: string;
  created_at?: string;
  sources?: SourceItem[];
  steps?: Step[];
  reasoning_summary?: string;
  isStreaming?: boolean;
}

export interface ChatState {
  messages: Message[];
  isLoading: boolean;
  error: string | null;
  currentSteps: Step[];
  currentSources: SourceItem[];
  reasoningSummary: string | null;
}
