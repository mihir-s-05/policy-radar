import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
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
    type Step,
} from "../models/schemas.js";
import { OpenAIService } from "../services/openaiService.js";
import { getPdfMemoryStore } from "../services/pdfMemory.js";
import { WebFetcher } from "../clients/webFetcher.js";
import { RateLimitError, APIError } from "../clients/base.js";
import { registerRequest, cancelRequest, unregisterRequest } from "../services/cancellation.js";

const router = new Hono();
const settings = getSettings();

router.post("/api/session", async (c) => {
    try {
        const sessionId = createSession();
        console.log(`Created new session: ${sessionId}`);
        return c.json({ session_id: sessionId });
    } catch (error) {
        console.error("Error creating session", error);
        return c.json({ detail: String(error) }, 500);
    }
});

router.get("/api/sessions", async (c) => {
    const limit = parseInt(c.req.query("limit") || "50", 10);
    if (!Number.isFinite(limit) || limit < 1 || limit > 200) {
        return c.json({ detail: "limit must be between 1 and 200" }, 400);
    }
    try {
        const rows = listSessions(limit);

        const sessions: SessionInfo[] = rows.map((row) => ({
            session_id: row.session_id,
            created_at: row.created_at,
            last_message: row.last_message,
            last_message_at: row.last_message_at,
            title: row.title ? row.title.slice(0, 100) : null,
        }));

        return c.json({ sessions });
    } catch (error) {
        console.error("Error listing sessions", error);
        return c.json({ detail: String(error) }, 500);
    }
});

router.delete("/api/sessions/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const session = getSessionById(sessionId);
    if (!session) {
        return c.json({ detail: "Session not found" }, 404);
    }

    try {
        const pdfMemory = getPdfMemoryStore();
        await pdfMemory.deleteSession(sessionId);
    } catch (error) {
        console.warn(`Failed to clear PDF memory for session ${sessionId}`, error);
    }

    const deleted = deleteSession(sessionId);
    return c.json({ session_id: sessionId, deleted });
});

router.get("/api/sessions/:sessionId/messages", async (c) => {
    const sessionId = c.req.param("sessionId");

    const session = getSessionById(sessionId);
    if (!session) {
        return c.json({ detail: "Session not found" }, 404);
    }

    try {
        const messageRows = getMessages(sessionId);
        const sourceRows = getSources(sessionId);

        const sourcesByMessageId = new Map<number, SourceItem[]>();
        for (const row of sourceRows) {
            try {
                const sources = JSON.parse(row.sources_json) as SourceItem[];
                sourcesByMessageId.set(row.message_id, sources);
            } catch {
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
    } catch (error) {
        console.error("Error fetching messages", error);
        return c.json({ detail: String(error) }, 500);
    }
});

router.patch("/api/sessions/:sessionId/messages/:messageId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const messageId = parseInt(c.req.param("messageId"), 10);

    const session = getSessionById(sessionId);
    if (!session) {
        return c.json({ detail: "Session not found" }, 404);
    }

    const body = await c.req.json();
    const parsed = UpdateMessageRequestSchema.safeParse(body);
    if (!parsed.success) {
        return c.json({ detail: "Invalid request", errors: parsed.error.issues }, 400);
    }

    const updated = updateMessageContent(sessionId, messageId, parsed.data.content);
    if (!updated) {
        return c.json({ detail: "Message not found" }, 404);
    }
    return c.json({ updated });
});

router.post("/api/content/fetch", async (c) => {
    try {
        const body = await c.req.json();
        const parsed = FetchContentRequestSchema.safeParse(body);
        if (!parsed.success) {
            return c.json({ detail: "Invalid request", errors: parsed.error.issues }, 400);
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
    } catch (error) {
        console.error("Error fetching content", error);
        return c.json({ detail: String(error) }, 500);
    }
});

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

    const embeddingProviders = {
        local: {
            name: "local",
            display_name: "Local (Transformers.js)",
            base_url: null,
            models: [
                "Xenova/all-MiniLM-L6-v2",
                "Xenova/all-mpnet-base-v2",
            ],
            api_key_detected: true,
            supported: true,
        },
        openai: {
            name: "openai",
            display_name: "OpenAI",
            base_url: settings.openaiBaseUrl,
            models: [
                "text-embedding-3-small",
                "text-embedding-3-large",
            ],
            api_key_detected: Boolean(settings.openaiApiKey),
            supported: true,
        },
        gemini: {
            name: "gemini",
            display_name: "Google Gemini (OpenAI-compatible)",
            base_url: settings.geminiBaseUrl,
            models: [
                "text-embedding-004",
            ],
            api_key_detected: Boolean(settings.googleApiKey),
            supported: true,
        },
        huggingface: {
            name: "huggingface",
            display_name: "Hugging Face",
            base_url: settings.huggingfaceEndpointUrl || "https://api-inference.huggingface.co",
            models: [
                "sentence-transformers/all-MiniLM-L6-v2",
                "sentence-transformers/all-mpnet-base-v2",
                "intfloat/e5-small-v2",
                "intfloat/e5-base-v2",
                "BAAI/bge-small-en-v1.5",
                "BAAI/bge-base-en-v1.5",
            ],
            api_key_detected: Boolean(settings.huggingfaceApiKey),
            supported: true,
            notes: "Uses Hugging Face Inference API feature extraction. Some models return token embeddings; the backend mean-pools and normalizes.",
        },
        custom: {
            name: "custom",
            display_name: "Custom (OpenAI-compatible)",
            base_url: null,
            models: [],
            api_key_detected: false,
            supported: true,
        },
    };

    return c.json({
        model: settings.openaiModel,
        available_models: settings.availableModels,
        default_api_mode: settings.defaultApiMode,
        embedding_provider: settings.embeddingProvider,
        embedding_model: settings.embeddingModel,
        providers,
        embedding_providers: embeddingProviders,
    });
});

router.post("/api/validate-model", async (c) => {
    const body = await c.req.json();
    const parsed = ValidateModelRequestSchema.safeParse(body);
    if (!parsed.success) {
        return c.json({ detail: "Invalid request", errors: parsed.error.issues }, 400);
    }

    const { provider, model_name, api_key, base_url } = parsed.data;

    try {
        if (provider === "openai") {
            const apiKey = api_key || settings.openaiApiKey;
            const baseUrl = "https://api.openai.com/v1";
            if (!apiKey) {
                return c.json({ valid: false, message: "OpenAI API key missing" });
            }

            const response = await fetch(`${baseUrl}/models`, {
                headers: { Authorization: `Bearer ${apiKey}` },
            });

            if (!response.ok) {
                return c.json({ valid: false, message: `OpenAI API Error: ${response.status}` });
            }

            const data = await response.json() as { data?: Array<{ id: string }> };
            const modelIds = (data.data || []).map((m) => m.id);

            if (modelIds.includes(model_name)) {
                return c.json({ valid: true, message: `Model '${model_name}' found.` });
            }
            return c.json({ valid: false, message: `Model '${model_name}' not found in OpenAI list.` });
        }

        if (provider === "anthropic") {
            const apiKey = api_key || settings.anthropicApiKey;
            const baseUrl = "https://api.anthropic.com/v1";
            if (!apiKey) {
                return c.json({ valid: false, message: "Anthropic API key missing" });
            }

            const response = await fetch(`${baseUrl}/models`, {
                headers: {
                    "x-api-key": apiKey,
                    "anthropic-version": "2023-06-01",
                },
            });

            if (!response.ok) {
                return c.json({ valid: false, message: `Anthropic API Error: ${response.status}` });
            }

            const data = await response.json() as { data?: Array<{ id: string }> };
            const modelIds = (data.data || []).map((m) => m.id);

            if (modelIds.includes(model_name)) {
                return c.json({ valid: true, message: `Model '${model_name}' found.` });
            }
            return c.json({ valid: false, message: `Model '${model_name}' not found in Anthropic list.` });
        }

        if (provider === "gemini") {
            const apiKey = api_key || settings.googleApiKey;
            const baseUrl = "https://generativelanguage.googleapis.com/v1beta";
            if (!apiKey) {
                return c.json({ valid: false, message: "Gemini API key missing" });
            }

            const fullModelName = model_name.startsWith("models/") ? model_name : `models/${model_name}`;
            const response = await fetch(`${baseUrl}/models?key=${apiKey}`);
            if (!response.ok) {
                return c.json({ valid: false, message: `Gemini API Error: ${response.status}` });
            }

            const data = await response.json() as { models?: Array<{ name: string }> };
            const models = data.models || [];

            const found = models.some((m) =>
                m.name === fullModelName ||
                m.name === model_name ||
                m.name.endsWith(`/${model_name}`)
            );

            if (found) {
                return c.json({ valid: true, message: `Model '${model_name}' found.` });
            }
            return c.json({ valid: false, message: `Model '${model_name}' not found in Gemini list.` });
        }

        if (provider === "custom") {
            if (!base_url) {
                return c.json({ valid: false, message: "Base URL required for custom provider" });
            }

            const headers: Record<string, string> = {};
            if (api_key) {
                headers.Authorization = `Bearer ${api_key}`;
            }

            const response = await fetch(`${base_url.replace(/\/$/, "")}/models`, {
                headers,
            });

            if (!response.ok) {
                return c.json({ valid: false, message: `Custom endpoint returned ${response.status}` });
            }

            const data = await response.json() as { data?: Array<{ id?: string }> };
            if (Array.isArray(data.data)) {
                const ids = data.data.map((m) => m.id).filter(Boolean) as string[];
                if (ids.includes(model_name)) {
                    return c.json({ valid: true, message: `Model '${model_name}' found via compatible list.` });
                }
                return c.json({ valid: false, message: `Model '${model_name}' not found in custom list.` });
            }

            return c.json({ valid: false, message: "Could not parse models list from custom endpoint." });
        }

        return c.json({ valid: false, message: "Unknown provider" });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return c.json({ valid: false, message: `Connection failed: ${message}` });
    }
});

router.post("/api/chat", async (c) => {
    const body = await c.req.json();
    const parsed = ChatRequestSchema.safeParse(body);
    if (!parsed.success) {
        return c.json({ detail: "Invalid request", errors: parsed.error.issues }, 400);
    }

    const request = parsed.data;

    const session = getSessionById(request.session_id);
    if (!session) {
        return c.json({ detail: "Session not found" }, 404);
    }

    try {
        addMessage(request.session_id, "user", request.message);

        let baseUrl: string | null = null;
        let apiKey = request.api_key || undefined;
        let modelOverride = request.model || undefined;
        const provider = request.provider || "openai";
        let apiMode: "responses" | "chat_completions";

        if (provider === "anthropic") {
            baseUrl = settings.anthropicBaseUrl;
            apiKey = apiKey || settings.anthropicApiKey;
            apiMode = "chat_completions";
        } else if (provider === "gemini") {
            baseUrl = settings.geminiBaseUrl;
            apiKey = apiKey || settings.googleApiKey;
            apiMode = "chat_completions";
        } else if (provider === "custom" && request.custom_model) {
            baseUrl = request.custom_model.base_url;
            modelOverride = request.custom_model.model_name;
            if (request.custom_model.api_key) {
                apiKey = request.custom_model.api_key;
            }
            apiMode = "chat_completions";
        } else {
            apiKey = apiKey || settings.openaiApiKey;
            apiMode = (request.api_mode as "responses" | "chat_completions") || settings.defaultApiMode;
        }

        const embeddingProvider = (request.embedding_provider as "local" | "openai" | "gemini" | "huggingface" | "custom" | null) || settings.embeddingProvider as any || "local";
        const embeddingModel = request.embedding_model || settings.embeddingModel;
        const embeddingApiKey = request.embedding_api_key || undefined;
        const embeddingCustom = request.embedding_custom_model || null;

        const embeddingConfig =
            embeddingProvider === "custom" && embeddingCustom
                ? {
                    provider: "custom" as const,
                    model: embeddingCustom.model_name,
                    apiKey: embeddingCustom.api_key || null,
                    baseUrl: embeddingCustom.base_url,
                }
                : {
                    provider: embeddingProvider,
                    model: embeddingModel,
                    apiKey: embeddingApiKey || null,
                    baseUrl: null,
                };

        const openaiService = new OpenAIService({
            sessionId: request.session_id,
            baseUrl: baseUrl || undefined,
            apiKey,
            embedding: embeddingConfig,
        });

        let result: {
            answerText: string;
            sources: SourceItem[];
            reasoningSummary: string | null;
            steps: Step[];
            responseId: string;
            modelUsed: string;
        };

        if (apiMode === "chat_completions") {
            result = await openaiService.chatCompletions({
                message: request.message,
                mode: request.mode || "both",
                days: request.days,
                model: modelOverride,
                sources: request.sources || null,
            });
        } else {
            result = await openaiService.chat({
                message: request.message,
                mode: request.mode || "both",
                days: request.days,
                model: modelOverride,
                sources: request.sources || null,
                previousResponseId: session.previous_response_id || null,
            });
        }

        updateSessionResponseId(request.session_id, result.responseId);

        const messageId = addMessage(request.session_id, "assistant", result.answerText);
        if (result.sources.length > 0) {
            saveSources(request.session_id, messageId, JSON.stringify(result.sources));
        }

        return c.json({
            answer_text: result.answerText,
            sources: result.sources,
            reasoning_summary: result.reasoningSummary,
            steps: result.steps,
            model: result.modelUsed,
        });
    } catch (error) {
        if (error instanceof RateLimitError) {
            return c.json(
                {
                    detail: {
                        message: "Rate limit exceeded. Please try again in a moment.",
                        retry_after: error.retryAfter,
                    },
                },
                429
            );
        }
        if (error instanceof APIError) {
            const status = ([400, 401, 403, 404, 429, 500, 502, 503].includes(error.statusCode)
                ? error.statusCode
                : 500) as 400 | 401 | 403 | 404 | 429 | 500 | 502 | 503;
            return c.json({ detail: error.message }, { status });
        }
        if (error instanceof Error && error.name === "ValueError") {
            return c.json({ detail: error.message }, 400);
        }
        console.error("Chat error:", error);
        return c.json({ detail: String(error) }, 500);
    }
});

router.post("/api/sessions/:sessionId/cancel", async (c) => {
    const sessionId = c.req.param("sessionId");
    const cancelled = cancelRequest(sessionId);
    return c.json({ session_id: sessionId, cancelled });
});

router.post("/api/chat/stream", async (c) => {
    const body = await c.req.json();
    const parsed = ChatRequestSchema.safeParse(body);
    if (!parsed.success) {
        return c.json({ detail: "Invalid request", errors: parsed.error.issues }, 400);
    }

    const request = parsed.data;

    const session = getSessionById(request.session_id);
    if (!session) {
        return c.json({ detail: "Session not found" }, 404);
    }

    // Register this request for cancellation
    const abortController = registerRequest(request.session_id);

    return streamSSE(c, async (stream) => {
        try {
            addMessage(request.session_id, "user", request.message);

            let baseUrl: string | null = null;
            let apiKey = request.api_key || undefined;
            let modelOverride = request.model || undefined;
            const provider = request.provider || "openai";
            let apiMode: "responses" | "chat_completions";

            if (provider === "anthropic") {
                baseUrl = settings.anthropicBaseUrl;
                apiKey = apiKey || settings.anthropicApiKey;
                apiMode = "chat_completions";
            } else if (provider === "gemini") {
                baseUrl = settings.geminiBaseUrl;
                apiKey = apiKey || settings.googleApiKey;
                apiMode = "chat_completions";
            } else if (provider === "custom" && request.custom_model) {
                baseUrl = request.custom_model.base_url;
                modelOverride = request.custom_model.model_name;
                if (request.custom_model.api_key) {
                    apiKey = request.custom_model.api_key;
                }
                apiMode = "chat_completions";
            } else {
                apiKey = apiKey || settings.openaiApiKey;
                apiMode = (request.api_mode as "responses" | "chat_completions") || settings.defaultApiMode;
            }

            const embeddingProvider = (request.embedding_provider as "local" | "openai" | "gemini" | "huggingface" | "custom" | null) || settings.embeddingProvider as any || "local";
            const embeddingModel = request.embedding_model || settings.embeddingModel;
            const embeddingApiKey = request.embedding_api_key || undefined;
            const embeddingCustom = request.embedding_custom_model || null;

            const embeddingConfig =
                embeddingProvider === "custom" && embeddingCustom
                    ? {
                        provider: "custom" as const,
                        model: embeddingCustom.model_name,
                        apiKey: embeddingCustom.api_key || null,
                        baseUrl: embeddingCustom.base_url,
                    }
                    : {
                        provider: embeddingProvider,
                        model: embeddingModel,
                        apiKey: embeddingApiKey || null,
                        baseUrl: null,
                    };

            const openaiService = new OpenAIService({
                sessionId: request.session_id,
                baseUrl: baseUrl || undefined,
                apiKey,
                signal: abortController.signal,
                embedding: embeddingConfig,
            });

            let answerText = "";
            let allSources: SourceItem[] = [];
            let responseId: string | null = null;

            const streamMethod =
                apiMode === "chat_completions"
                    ? openaiService.chatCompletionsStream({
                        message: request.message,
                        mode: request.mode || "both",
                        days: request.days,
                        model: modelOverride,
                        sources: request.sources || null,
                    })
                    : openaiService.chatStream({
                        message: request.message,
                        mode: request.mode || "both",
                        days: request.days,
                        model: modelOverride,
                        sources: request.sources || null,
                        previousResponseId: session.previous_response_id || null,
                    });

            for await (const event of streamMethod) {
                await stream.writeSSE({
                    event: event.event,
                    data: JSON.stringify(event.data),
                });

                if (event.event === "done") {
                    answerText = event.data.answer_text;
                    allSources = event.data.sources;
                    responseId = event.data.response_id || null;
                }
            }

            if (responseId) {
                updateSessionResponseId(request.session_id, responseId);
            }
            if (answerText) {
                const messageId = addMessage(request.session_id, "assistant", answerText);
                if (allSources.length > 0) {
                    saveSources(request.session_id, messageId, JSON.stringify(allSources));
                }
            }
        } catch (error) {
            if (error instanceof RateLimitError) {
                await stream.writeSSE({
                    event: "error",
                    data: JSON.stringify({
                        error: "rate_limit",
                        message: "Rate limit exceeded. Please try again in a moment.",
                        retry_after: error.retryAfter,
                    }),
                });
            } else if (error instanceof APIError) {
                await stream.writeSSE({
                    event: "error",
                    data: JSON.stringify({
                        error: "api_error",
                        message: error.message,
                        status_code: error.statusCode,
                    }),
                });
            } else if (error instanceof Error && error.name === "ValueError") {
                await stream.writeSSE({
                    event: "error",
                    data: JSON.stringify({
                        error: "bad_request",
                        message: error.message,
                        status_code: 400,
                    }),
                });
            } else if (error instanceof Error && error.name === "AbortError") {
                // Request was cancelled by user - send a cancelled event
                await stream.writeSSE({
                    event: "cancelled",
                    data: JSON.stringify({
                        message: "Request cancelled by user",
                    }),
                });
            } else {
                console.error("Stream error:", error);
                await stream.writeSSE({
                    event: "error",
                    data: JSON.stringify({
                        error: "internal_error",
                        message: String(error),
                    }),
                });
            }
        } finally {
            // Always unregister the request when done
            unregisterRequest(request.session_id);
        }
    });
});

router.get("/api/health", async (c) => {
    return c.json({
        status: "healthy",
    });
});

export { router };
