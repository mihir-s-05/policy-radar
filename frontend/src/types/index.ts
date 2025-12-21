export type SourceType =
  | "regulations_document"
  | "regulations_docket"
  | "govinfo_result"
  | "govinfo_package"
  | "congress_bill"
  | "congress_vote"
  | "federal_register"
  | "usaspending"
  | "fiscal_data"
  | "datagov"
  | "doj_press_release"
  | "searchgov";

export interface SourceItem {
  source_type: SourceType;
  id: string;
  title: string;
  agency: string | null;
  date: string | null;
  url: string;
  excerpt: string | null;
  pdf_url?: string | null;
  content_type?: string | null;
}

export interface SourceSelection {
  govinfo: boolean;
  regulations: boolean;
  congress: boolean;
  federal_register: boolean;
  usaspending: boolean;
  fiscal_data: boolean;
  datagov: boolean;
  doj: boolean;
  searchgov: boolean;
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
  mode?: SearchMode;
  sources?: SourceSelection;
  days: number;
  model?: string;
  provider?: ModelProvider;
  api_mode?: ApiMode;
  custom_model?: CustomModelConfig;
  api_key?: string;
}

export type ModelProvider = "openai" | "anthropic" | "gemini" | "custom";

export type ApiMode = "responses" | "chat_completions";

export interface CustomModelConfig {
  base_url: string;
  model_name: string;
  api_key?: string;
}

export interface ChatResponse {
  answer_text: string;
  sources: SourceItem[];
  reasoning_summary?: string;
  steps: Step[];
  model?: string;
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

export interface ProviderInfo {
  name: string;
  display_name: string;
  base_url: string;
  models: string[];
  api_key_detected: boolean;
  api_mode: ApiMode;
}

export interface ConfigResponse {
  model: string;
  available_models: string[];
  default_api_mode: ApiMode;
  providers: Record<string, ProviderInfo>;
}

export interface ValidateModelRequest {
  provider: ModelProvider;
  model_name: string;
  api_key?: string;
  base_url?: string;
}

export interface ValidateModelResponse {
  valid: boolean;
  message: string;
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
  model?: string;
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
  model?: string;
}

export interface ChatState {
  messages: Message[];
  isLoading: boolean;
  error: string | null;
  currentSteps: Step[];
  currentSources: SourceItem[];
  reasoningSummary: string | null;
}
