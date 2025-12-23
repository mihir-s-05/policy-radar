import { z } from "zod";

// ============================================================================
// Source Types
// ============================================================================

export const SourceTypeSchema = z.enum([
    "regulations_document",
    "regulations_docket",
    "govinfo_result",
    "govinfo_package",
    "congress_bill",
    "congress_vote",
    "federal_register",
    "usaspending",
    "fiscal_data",
    "datagov",
    "doj_press_release",
    "searchgov",
]);

export type SourceType = z.infer<typeof SourceTypeSchema>;

export const SourceItemSchema = z.object({
    source_type: SourceTypeSchema,
    id: z.string(),
    title: z.string(),
    agency: z.string().nullable().optional(),
    date: z.string().nullable().optional(),
    url: z.string(),
    excerpt: z.string().nullable().optional(),
    pdf_url: z.string().nullable().optional(),
    content_type: z.string().nullable().optional(),
    raw: z.record(z.unknown()).nullable().optional(),
});

export type SourceItem = z.infer<typeof SourceItemSchema>;

// ============================================================================
// Source Selection
// ============================================================================

export const SourceSelectionSchema = z.object({
    auto: z.boolean().default(true),
    govinfo: z.boolean().default(true),
    regulations: z.boolean().default(true),
    congress: z.boolean().default(true),
    federal_register: z.boolean().default(true),
    usaspending: z.boolean().default(true),
    fiscal_data: z.boolean().default(true),
    datagov: z.boolean().default(true),
    doj: z.boolean().default(true),
    searchgov: z.boolean().default(true),
});

export type SourceSelection = z.infer<typeof SourceSelectionSchema>;

// ============================================================================
// Custom Model Config
// ============================================================================

export const CustomModelConfigSchema = z.object({
    base_url: z.string(),
    model_name: z.string(),
    api_key: z.string().nullable().optional(),
});

export type CustomModelConfig = z.infer<typeof CustomModelConfigSchema>;

// ============================================================================
// Step
// ============================================================================

export const StepStatusSchema = z.enum(["running", "done", "error"]);

export const StepSchema = z.object({
    step_id: z.string(),
    status: StepStatusSchema,
    label: z.string(),
    tool_name: z.string(),
    args: z.record(z.unknown()).default({}),
    result_preview: z.record(z.unknown()).nullable().optional(),
});

export type Step = z.infer<typeof StepSchema>;

// ============================================================================
// Chat Request/Response
// ============================================================================

export const ChatRequestSchema = z.object({
    session_id: z.string(),
    message: z.string(),
    mode: z.enum(["regulations", "govinfo", "both"]).nullable().optional(),
    sources: SourceSelectionSchema.nullable().optional(),
    days: z.number().int().min(7).max(90).default(30),
    model: z.string().nullable().optional(),
    provider: z.enum(["openai", "anthropic", "gemini", "custom"]).nullable().optional(),
    api_mode: z.enum(["responses", "chat_completions"]).nullable().optional(),
    custom_model: CustomModelConfigSchema.nullable().optional(),
    api_key: z.string().nullable().optional(),
});

export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const ChatResponseSchema = z.object({
    answer_text: z.string(),
    sources: z.array(SourceItemSchema).default([]),
    reasoning_summary: z.string().nullable().optional(),
    steps: z.array(StepSchema).default([]),
    model: z.string().nullable().optional(),
});

export type ChatResponse = z.infer<typeof ChatResponseSchema>;

// ============================================================================
// Session Types
// ============================================================================

export const SessionResponseSchema = z.object({
    session_id: z.string(),
});

export type SessionResponse = z.infer<typeof SessionResponseSchema>;

export const SessionInfoSchema = z.object({
    session_id: z.string(),
    created_at: z.string(),
    last_message: z.string().nullable().optional(),
    last_message_at: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
});

export type SessionInfo = z.infer<typeof SessionInfoSchema>;

export const SessionListResponseSchema = z.object({
    sessions: z.array(SessionInfoSchema).default([]),
});

export type SessionListResponse = z.infer<typeof SessionListResponseSchema>;

export const DeleteSessionResponseSchema = z.object({
    session_id: z.string(),
    deleted: z.boolean(),
});

export type DeleteSessionResponse = z.infer<typeof DeleteSessionResponseSchema>;

// ============================================================================
// Message Types
// ============================================================================

export const MessageItemSchema = z.object({
    id: z.number(),
    role: z.enum(["user", "assistant"]),
    content: z.string(),
    created_at: z.string(),
    sources: z.array(SourceItemSchema).nullable().optional(),
});

export type MessageItem = z.infer<typeof MessageItemSchema>;

export const MessagesResponseSchema = z.object({
    session_id: z.string(),
    messages: z.array(MessageItemSchema).default([]),
});

export type MessagesResponse = z.infer<typeof MessagesResponseSchema>;

// ============================================================================
// Content Fetch Types
// ============================================================================

export const FetchContentRequestSchema = z.object({
    url: z.string(),
    max_length: z.number().int().min(1).max(500000).default(15000),
    full_text: z.boolean().default(false),
});

export type FetchContentRequest = z.infer<typeof FetchContentRequestSchema>;

export const FetchContentResponseSchema = z.object({
    url: z.string(),
    title: z.string().nullable().optional(),
    full_text: z.string().nullable().optional(),
    error: z.string().nullable().optional(),
});

export type FetchContentResponse = z.infer<typeof FetchContentResponseSchema>;

// ============================================================================
// Update Message Types
// ============================================================================

export const UpdateMessageRequestSchema = z.object({
    content: z.string(),
});

export type UpdateMessageRequest = z.infer<typeof UpdateMessageRequestSchema>;

export const UpdateMessageResponseSchema = z.object({
    updated: z.boolean(),
});

export type UpdateMessageResponse = z.infer<typeof UpdateMessageResponseSchema>;

// ============================================================================
// Config Types
// ============================================================================

export const ProviderInfoSchema = z.object({
    name: z.string(),
    display_name: z.string(),
    base_url: z.string(),
    models: z.array(z.string()).default([]),
    api_key_detected: z.boolean().default(false),
    api_mode: z.enum(["responses", "chat_completions"]).default("chat_completions"),
});

export type ProviderInfo = z.infer<typeof ProviderInfoSchema>;

export const ConfigResponseSchema = z.object({
    model: z.string(),
    available_models: z.array(z.string()).default([]),
    default_api_mode: z.enum(["responses", "chat_completions"]).default("responses"),
    providers: z.record(ProviderInfoSchema).default({}),
});

export type ConfigResponse = z.infer<typeof ConfigResponseSchema>;

// ============================================================================
// Validate Model Types
// ============================================================================

export const ValidateModelRequestSchema = z.object({
    provider: z.enum(["openai", "anthropic", "gemini", "custom"]),
    model_name: z.string(),
    api_key: z.string().nullable().optional(),
    base_url: z.string().nullable().optional(),
});

export type ValidateModelRequest = z.infer<typeof ValidateModelRequestSchema>;

export const ValidateModelResponseSchema = z.object({
    valid: z.boolean(),
    message: z.string(),
});

export type ValidateModelResponse = z.infer<typeof ValidateModelResponseSchema>;

// ============================================================================
// Stream Event Types
// ============================================================================

export const StepEventSchema = z.object({
    step_id: z.string(),
    status: StepStatusSchema,
    label: z.string().nullable().optional(),
    tool_name: z.string().nullable().optional(),
    args: z.record(z.unknown()).nullable().optional(),
    result_preview: z.record(z.unknown()).nullable().optional(),
});

export type StepEvent = z.infer<typeof StepEventSchema>;

export const ReasoningSummaryEventSchema = z.object({
    text: z.string(),
});

export type ReasoningSummaryEvent = z.infer<typeof ReasoningSummaryEventSchema>;

export const AssistantDeltaEventSchema = z.object({
    delta: z.string(),
});

export type AssistantDeltaEvent = z.infer<typeof AssistantDeltaEventSchema>;

export const DoneEventSchema = z.object({
    answer_text: z.string(),
    sources: z.array(SourceItemSchema).default([]),
    response_id: z.string().optional(),
    model: z.string().optional(),
});

export type DoneEvent = z.infer<typeof DoneEventSchema>;
