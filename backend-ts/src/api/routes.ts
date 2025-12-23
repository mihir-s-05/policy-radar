import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import OpenAI from "openai";
import { getSettings } from "../config.js";
import {
    createSession,
    listSessions,
    deleteSession,
    getSessionById,
    addMessage,
    getMessages,
    getSources,
    saveSources,
    updateMessageContent,
    updateSessionResponseId,
} from "../models/database.js";
import {
    ChatRequestSchema,
    FetchContentRequestSchema,
    UpdateMessageRequestSchema,
    ValidateModelRequestSchema,
    type SourceItem,
    type SessionInfo,
    type MessageItem,
} from "../models/schemas.js";
import { OpenAIService } from "../services/openaiService.js";
import { getPdfMemoryStore } from "../services/pdfMemory.js";
import { WebFetcher } from "../clients/webFetcher.js";
import { RateLimitError, APIError } from "../clients/base.js";

const router = new Hono();
const settings = getSettings();

// ============================================================================
// Session Endpoints
// ============================================================================

// Create session
router.post("/api/session", async (c) => {
    const sessionId = createSession();
    return c.json({ session_id: sessionId });
});

// List sessions
router.get("/api/sessions", async (c) => {
    const limit = parseInt(c.req.query("limit") || "50", 10);
    const rows = listSessions(limit);

    const sessions: SessionInfo[] = rows.map((row) => ({
        session_id: row.session_id,
        created_at: row.created_at,
        last_message: row.last_message,
        last_message_at: row.last_message_at,
        title: row.title ? row.title.slice(0, 100) : null,
    }));

    return c.json({ sessions });
});

// Delete session
router.delete("/api/sessions/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");

    // Delete PDF memory for session
    try {
        const pdfMemory = getPdfMemoryStore();
        await pdfMemory.deleteSession(sessionId);
    } catch (error) {
        console.warn(`Failed to delete PDF memory for session ${sessionId}:`, error);
    }

    const deleted = deleteSession(sessionId);
    return c.json({ session_id: sessionId, deleted });
});

// Get messages for session
router.get("/api/sessions/:sessionId/messages", async (c) => {
    const sessionId = c.req.param("sessionId");

    // Check session exists
    const session = getSessionById(sessionId);
    if (!session) {
        return c.json({ error: "Session not found" }, 404);
    }

    const messageRows = getMessages(sessionId);
    const sourceRows = getSources(sessionId);

    // Build map of message_id -> sources
    const sourcesByMessageId = new Map<number, SourceItem[]>();
    for (const row of sourceRows) {
        try {
            const sources = JSON.parse(row.sources_json) as SourceItem[];
            sourcesByMessageId.set(row.message_id, sources);
        } catch {
            // Ignore parse errors
        }
    }

    const messages: MessageItem[] = messageRows.map((row) => ({
        id: row.id,
        role: row.role as "user" | "assistant",
        content: row.content,
        created_at: row.created_at,
        sources: sourcesByMessageId.get(row.id) || null,
    }));

    return c.json({ session_id: sessionId, messages });
});

// Update message content
router.patch("/api/sessions/:sessionId/messages/:messageId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const messageId = parseInt(c.req.param("messageId"), 10);

    const body = await c.req.json();
    const parsed = UpdateMessageRequestSchema.safeParse(body);
    if (!parsed.success) {
        return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
    }

    const updated = updateMessageContent(sessionId, messageId, parsed.data.content);
    return c.json({ updated });
});

// ============================================================================
// Content Fetch Endpoint
// ============================================================================

router.post("/api/content/fetch", async (c) => {
    const body = await c.req.json();
    const parsed = FetchContentRequestSchema.safeParse(body);
    if (!parsed.success) {
        return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
    }

    const { url, max_length, full_text } = parsed.data;
    const fetcher = new WebFetcher();
    const result = await fetcher.fetchUrl(url, full_text ? null : max_length);

    return c.json({
        url: result.url,
        title: result.title,
        full_text: result.text,
        error: result.error,
    });
});

// ============================================================================
// Config Endpoint
// ============================================================================

router.get("/api/config", async (c) => {
    const providers = {
        openai: {
            name: "openai",
            display_name: "OpenAI",
            base_url: settings.openaiBaseUrl,
            models: settings.availableModels,
            api_key_detected: Boolean(settings.openaiApiKey),
            api_mode: "responses" as const,
        },
        anthropic: {
            name: "anthropic",
            display_name: "Anthropic",
            base_url: settings.anthropicBaseUrl,
            models: settings.anthropicModels,
            api_key_detected: Boolean(settings.anthropicApiKey),
            api_mode: "chat_completions" as const,
        },
        gemini: {
            name: "gemini",
            display_name: "Google Gemini",
            base_url: settings.geminiBaseUrl,
            models: settings.geminiModels,
            api_key_detected: Boolean(settings.googleApiKey),
            api_mode: "chat_completions" as const,
        },
    };

    return c.json({
        model: settings.openaiModel,
        available_models: settings.availableModels,
        default_api_mode: settings.defaultApiMode,
        providers,
    });
});

// ============================================================================
// Validate Model Endpoint
// ============================================================================

const ensureTrailingSlash = (value: string): string =>
    value.endsWith("/") ? value : `${value}/`;

const formatValidationError = async (response: Response): Promise<string> => {
    const body = await response.text();
    const trimmed = body.trim();
    const detail = trimmed ? `: ${trimmed.slice(0, 500)}` : "";
    return `HTTP ${response.status} ${response.statusText}${detail}`;
};

router.post("/api/validate-model", async (c) => {
    const body = await c.req.json();
    const parsed = ValidateModelRequestSchema.safeParse(body);
    if (!parsed.success) {
        return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
    }

    const { provider, model_name, api_key, base_url } = parsed.data;

    try {
        const model = model_name;

        if (provider === "custom") {
            if (!base_url) {
                return c.json({ valid: false, message: "Custom provider requires base_url" });
            }
            const client = new OpenAI({
                apiKey: api_key || "not-required",
                baseURL: base_url,
            });

            await client.chat.completions.create({
                model,
                messages: [{ role: "user", content: "test" }],
                max_tokens: 1,
            });
        } else if (provider === "anthropic") {
            const apiKey = api_key || settings.anthropicApiKey;
            const baseUrl = ensureTrailingSlash(base_url || settings.anthropicBaseUrl);
            const response = await fetch(new URL("messages", baseUrl), {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-api-key": apiKey,
                    "anthropic-version": "2023-06-01",
                },
                body: JSON.stringify({
                    model,
                    max_tokens: 1,
                    messages: [{ role: "user", content: "test" }],
                }),
            });

            if (!response.ok) {
                throw new Error(`Anthropic validation failed (${await formatValidationError(response)})`);
            }
        } else if (provider === "gemini") {
            const apiKey = api_key || settings.googleApiKey;
            let baseUrl = ensureTrailingSlash(base_url || settings.geminiBaseUrl);
            baseUrl = baseUrl.replace(/\/openai\/?$/i, "/");
            const endpoint = new URL(
                `models/${encodeURIComponent(model)}:generateContent`,
                baseUrl
            );
            const response = await fetch(endpoint, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-goog-api-key": apiKey,
                },
                body: JSON.stringify({
                    contents: [{ role: "user", parts: [{ text: "test" }] }],
                    generationConfig: { maxOutputTokens: 1 },
                }),
            });

            if (!response.ok) {
                throw new Error(`Gemini validation failed (${await formatValidationError(response)})`);
            }
        } else {
            const client = new OpenAI({
                apiKey: api_key || settings.openaiApiKey,
            });

            await client.chat.completions.create({
                model,
                messages: [{ role: "user", content: "test" }],
                max_tokens: 1,
            });
        }

        return c.json({ valid: true, message: "Model validated successfully" });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return c.json({ valid: false, message });
    }
});

// ============================================================================
// Chat Endpoint (Non-streaming)
// ============================================================================

router.post("/api/chat", async (c) => {
    const body = await c.req.json();
    const parsed = ChatRequestSchema.safeParse(body);
    if (!parsed.success) {
        return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
    }

    const request = parsed.data;

    // Check session exists
    const session = getSessionById(request.session_id);
    if (!session) {
        return c.json({ error: "Session not found" }, 404);
    }

    // Add user message
    addMessage(request.session_id, "user", request.message);

    try {
        const openaiService = new OpenAIService();
        const result = await openaiService.chat({
            sessionId: request.session_id,
            message: request.message,
            previousResponseId: session.previous_response_id || undefined,
            sources: request.sources || undefined,
            days: request.days,
            model: request.model || undefined,
            provider: request.provider || undefined,
            apiMode: request.api_mode || undefined,
            customModel: request.custom_model || undefined,
            apiKey: request.api_key || undefined,
        });

        // Add assistant message
        const messageId = addMessage(request.session_id, "assistant", result.answer_text);

        // Save sources
        if (result.sources.length > 0) {
            saveSources(request.session_id, messageId, JSON.stringify(result.sources));
        }

        // Update response ID
        if (result.response_id) {
            updateSessionResponseId(request.session_id, result.response_id);
        }

        return c.json({
            answer_text: result.answer_text,
            sources: result.sources,
            steps: result.steps,
            model: result.model,
        });
    } catch (error) {
        if (error instanceof RateLimitError) {
            return c.json(
                { error: "Rate limit exceeded", retry_after: error.retryAfter },
                429
            );
        }
        if (error instanceof APIError) {
            return c.json({ error: error.message }, error.statusCode as 400 | 401 | 403 | 404 | 500 | 502 | 503);
        }
        console.error("Chat error:", error);
        return c.json({ error: String(error) }, 500);
    }
});

// ============================================================================
// Chat Stream Endpoint (SSE)
// ============================================================================

router.post("/api/chat/stream", async (c) => {
    const body = await c.req.json();
    const parsed = ChatRequestSchema.safeParse(body);
    if (!parsed.success) {
        return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
    }

    const request = parsed.data;

    // Check session exists
    const session = getSessionById(request.session_id);
    if (!session) {
        return c.json({ error: "Session not found" }, 404);
    }

    // Add user message
    addMessage(request.session_id, "user", request.message);

    return streamSSE(c, async (stream) => {
        try {
            const openaiService = new OpenAIService();
            let answerText = "";
            let allSources: SourceItem[] = [];
            let responseId: string | undefined;

            for await (const event of openaiService.chatStream({
                sessionId: request.session_id,
                message: request.message,
                previousResponseId: session.previous_response_id || undefined,
                sources: request.sources || undefined,
                days: request.days,
                model: request.model || undefined,
                provider: request.provider || undefined,
                apiMode: request.api_mode || undefined,
                customModel: request.custom_model || undefined,
                apiKey: request.api_key || undefined,
            })) {
                await stream.writeSSE({
                    event: event.event,
                    data: JSON.stringify(event.data),
                });

                if (event.event === "done") {
                    answerText = event.data.answer_text;
                    allSources = event.data.sources;
                    responseId = event.data.response_id;
                }
            }

            // Save assistant message and sources
            if (answerText) {
                const messageId = addMessage(request.session_id, "assistant", answerText);
                if (allSources.length > 0) {
                    saveSources(request.session_id, messageId, JSON.stringify(allSources));
                }
                if (responseId) {
                    updateSessionResponseId(request.session_id, responseId);
                }
            }
        } catch (error) {
            console.error("Stream error:", error);
            await stream.writeSSE({
                event: "error",
                data: JSON.stringify({ error: String(error) }),
            });
        }
    });
});

// ============================================================================
// Health Check
// ============================================================================

router.get("/api/health", async (c) => {
    return c.json({
        status: "healthy",
        timestamp: new Date().toISOString(),
    });
});

export { router };
