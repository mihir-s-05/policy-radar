import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid";
import { getSettings } from "../config.js";
import type {
    SourceItem,
    SourceSelection,
    Step,
    CustomModelConfig,
} from "../models/schemas.js";
import { ToolExecutor, getToolLabel } from "./toolExecutor.js";

// ============================================================================
// System Instructions
// ============================================================================

const SYSTEM_INSTRUCTIONS = `You are Policy Radar, an advanced research assistant specializing in federal policy, legislation, regulations, and government data. You have access to multiple powerful tools that connect to official government APIs and databases.

## Your Core Capabilities

### Primary Data Sources
- **Regulations.gov**: Federal rulemaking documents, proposed rules, final rules, and public comments
- **GovInfo.gov**: Congressional records, bills, public laws, executive documents, and government publications
- **Congress.gov**: Bills, amendments, voting records, and congressional activity
- **Federal Register**: Daily journal of the U.S. Government with proposed rules and public notices
- **USAspending.gov**: Federal spending, contracts, grants, and financial assistance
- **FiscalData.treasury.gov**: Treasury financial data including debt, receipts, and outlays
- **Data.gov**: Federal datasets across all agencies
- **Justice.gov**: DOJ press releases and announcements
- **Search.gov**: Cross-agency government content search

### Key Behaviors

1. **Always Use Tools First**: Before answering policy questions, use relevant tools to find current, authoritative information. Never rely on training data for policy specifics.

2. **Source Attribution**: Always cite your sources. Use the URLs provided by tools and clearly indicate which agency or document your information comes from.

3. **Comprehensive Research**: Use multiple tools and sources when appropriate. Cross-reference information between Regulations.gov and Federal Register, or between Congress.gov and GovInfo.

4. **PDF Memory**: When you fetch PDF content from documents, it gets indexed. Use search_pdf_memory to search previously fetched documents for specific information.

5. **Neutral Tone**: Present information objectively. When policy topics are politically contentious, present multiple perspectives without editorial bias.

6. **Recency Matters**: Federal policy changes frequently. Always prefer recent search results and note when information might be outdated.

7. **Acknowledge Limitations**: If you cannot find authoritative information, say so. Do not fabricate policy details.

## Important Disclaimers

Always include appropriate disclaimers when:
- Discussing legal requirements (suggest consulting legal counsel)
- Providing financial impact assessments (note these are estimates)
- Covering pending regulations (note that rules may change before finalization)

## Response Format

Structure responses clearly with:
- Key findings prominently displayed
- Source citations with links
- Relevant dates and document numbers
- Context about the policy landscape when helpful`;

// ============================================================================
// Tool Definitions
// ============================================================================

export const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    {
        type: "function",
        function: {
            name: "regs_search_documents",
            description: "Search for documents on Regulations.gov. Use for finding proposed rules, final rules, notices, and supporting documents.",
            parameters: {
                type: "object",
                properties: {
                    search_term: { type: "string", description: "Keywords to search for" },
                    date_ge: { type: "string", description: "Filter documents posted on or after this date (YYYY-MM-DD)" },
                    date_le: { type: "string", description: "Filter documents posted on or before this date (YYYY-MM-DD)" },
                    page_size: { type: "integer", description: "Number of results (default 10, max 25)" },
                },
                required: ["search_term"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "regs_search_dockets",
            description: "Search for dockets on Regulations.gov. Dockets group related documents for a rulemaking proceeding.",
            parameters: {
                type: "object",
                properties: {
                    search_term: { type: "string", description: "Keywords to search for" },
                    page_size: { type: "integer", description: "Number of results (default 10)" },
                },
                required: ["search_term"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "regs_get_document",
            description: "Get detailed metadata for a specific Regulations.gov document by ID.",
            parameters: {
                type: "object",
                properties: {
                    document_id: { type: "string", description: "The document ID (e.g., EPA-HQ-OAR-2021-0208-0001)" },
                    include_attachments: { type: "boolean", description: "Include attachment metadata" },
                },
                required: ["document_id"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "regs_read_document_content",
            description: "Fetch and read the full text content of a Regulations.gov document. Use when you need the actual text of a rule or notice.",
            parameters: {
                type: "object",
                properties: {
                    document_id: { type: "string", description: "The document ID" },
                },
                required: ["document_id"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "govinfo_search",
            description: "Search GovInfo.gov for government publications, congressional records, and official documents.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Search query (supports keywords and filters like collection:BILLS)" },
                    keywords: { type: "string", description: "Alias for query" },
                    collection: { type: "string", description: "Filter by collection (e.g., BILLS, PLAW, CFR, FR, CREC)" },
                    days: { type: "integer", description: "Only include documents from the last N days" },
                    page_size: { type: "integer", description: "Number of results (default 10)" },
                },
                required: [],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "govinfo_package_summary",
            description: "Get summary metadata for a GovInfo package by ID.",
            parameters: {
                type: "object",
                properties: {
                    package_id: { type: "string", description: "The package ID (e.g., BILLS-118hr1234ih)" },
                },
                required: ["package_id"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "govinfo_read_package_content",
            description: "Fetch and read the full text content of a GovInfo package. Use to read bills, laws, or other documents.",
            parameters: {
                type: "object",
                properties: {
                    package_id: { type: "string", description: "The package ID" },
                },
                required: ["package_id"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "fetch_url_content",
            description: "Fetch content from any URL. Supports HTML pages and PDF documents. Content is extracted and indexed for future reference.",
            parameters: {
                type: "object",
                properties: {
                    url: { type: "string", description: "The URL to fetch" },
                },
                required: ["url"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "search_pdf_memory",
            description: "Search previously fetched PDF documents for relevant content. Use when you've already fetched PDFs and need to find specific information.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "What to search for in the indexed documents" },
                    top_k: { type: "integer", description: "Number of results (default 5)" },
                },
                required: ["query"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "congress_search_bills",
            description: "Search for bills in Congress. Returns bill titles, statuses, and links.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Keywords to search for" },
                    congress: { type: "integer", description: "Congress number (e.g., 118 for 118th Congress)" },
                    limit: { type: "integer", description: "Number of results (default 10)" },
                },
                required: ["query"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "congress_search_votes",
            description: "Search for roll call votes in Congress.",
            parameters: {
                type: "object",
                properties: {
                    chamber: { type: "string", enum: ["house", "senate"], description: "Which chamber" },
                    congress: { type: "integer", description: "Congress number" },
                    limit: { type: "integer", description: "Number of results (default 10)" },
                },
                required: [],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "federal_register_search",
            description: "Search the Federal Register for rules, proposed rules, notices, and presidential documents.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Search terms" },
                    document_type: { type: "string", enum: ["RULE", "PRORULE", "NOTICE", "PRESDOCU"], description: "Type of document" },
                    agency: { type: "string", description: "Filter by agency slug (e.g., environmental-protection-agency)" },
                    days: { type: "integer", description: "Only include documents from the last N days" },
                    per_page: { type: "integer", description: "Number of results (default 10)" },
                },
                required: ["query"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "usaspending_search",
            description: "Search USAspending.gov for federal contracts, grants, loans, and other spending.",
            parameters: {
                type: "object",
                properties: {
                    keywords: {
                        oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
                        description: "Search keywords",
                    },
                    agency: { type: "string", description: "Filter by awarding agency name" },
                    recipient: { type: "string", description: "Filter by recipient name" },
                    award_type: { type: "string", enum: ["contracts", "grants", "loans", "direct_payments"], description: "Type of award" },
                    days: { type: "integer", description: "Time period in days (default 365)" },
                    limit: { type: "integer", description: "Number of results (default 10)" },
                },
                required: [],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "fiscal_data_query",
            description: "Query Treasury fiscal data (debt, interest rates, receipts, outlays).",
            parameters: {
                type: "object",
                properties: {
                    dataset: {
                        type: "string",
                        enum: ["debt_to_penny", "debt_outstanding", "treasury_offset", "interest_rates", "monthly_receipts", "monthly_outlays", "federal_surplus_deficit"],
                        description: "Which dataset to query",
                    },
                    page_size: { type: "integer", description: "Number of records (default 10)" },
                },
                required: [],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "datagov_search",
            description: "Search Data.gov for federal datasets.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Search terms" },
                    organization: { type: "string", description: "Filter by organization" },
                    rows: { type: "integer", description: "Number of results (default 10)" },
                },
                required: ["query"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "doj_search",
            description: "Search DOJ press releases and news.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Search keywords" },
                    component: { type: "string", description: "DOJ component (e.g., office-of-the-attorney-general)" },
                    days: { type: "integer", description: "Only include from the last N days (default 30)" },
                    limit: { type: "integer", description: "Number of results (default 10)" },
                },
                required: [],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "searchgov_search",
            description: "Search across government websites using Search.gov.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Search terms" },
                    limit: { type: "integer", description: "Number of results (default 10)" },
                },
                required: ["query"],
            },
        },
    },
];

// ============================================================================
// OpenAI Service
// ============================================================================

export class OpenAIService {
    private settings = getSettings();

    private getClient(
        provider: string = "openai",
        apiKey?: string,
        customModel?: CustomModelConfig
    ): OpenAI {
        if (provider === "custom" && customModel) {
            return new OpenAI({
                apiKey: customModel.api_key || "not-required",
                baseURL: customModel.base_url,
            });
        }

        if (provider === "anthropic" || provider === "gemini") {
            throw new Error(
                `Provider "${provider}" uses a non-OpenAI API and cannot be used with the OpenAI SDK client.`
            );
        }

        return new OpenAI({
            apiKey: apiKey || this.settings.openaiApiKey,
            baseURL: this.settings.openaiBaseUrl,
        });
    }

    private getModelName(
        provider: string = "openai",
        model?: string,
        customModel?: CustomModelConfig
    ): string {
        if (provider === "custom" && customModel) {
            return customModel.model_name;
        }

        if (model) return model;

        if (provider === "anthropic") {
            return this.settings.anthropicModels[0];
        }

        if (provider === "gemini") {
            return this.settings.geminiModels[0];
        }

        return this.settings.openaiModel;
    }

    private truncateContent(content: string, maxLength: number = 30000): string {
        if (content.length <= maxLength) return content;
        return content.slice(0, maxLength) + "\n\n[Content truncated...]";
    }

    private formatToolOutput(result: Record<string, unknown>): string {
        const json = JSON.stringify(result, null, 2);
        return this.truncateContent(json, 30000);
    }

    private resolveSourceSelection(sources?: SourceSelection): SourceSelection {
        if (!sources) {
            return {
                auto: true,
                govinfo: true,
                regulations: true,
                congress: true,
                federal_register: true,
                usaspending: true,
                fiscal_data: true,
                datagov: true,
                doj: true,
                searchgov: true,
            };
        }
        return sources;
    }

    private filterToolsForSources(sources: SourceSelection): OpenAI.Chat.Completions.ChatCompletionTool[] {
        const sourceToTools: Record<string, string[]> = {
            regulations: ["regs_search_documents", "regs_search_dockets", "regs_get_document", "regs_read_document_content"],
            govinfo: ["govinfo_search", "govinfo_package_summary", "govinfo_read_package_content"],
            congress: ["congress_search_bills", "congress_search_votes"],
            federal_register: ["federal_register_search"],
            usaspending: ["usaspending_search"],
            fiscal_data: ["fiscal_data_query"],
            datagov: ["datagov_search"],
            doj: ["doj_search"],
            searchgov: ["searchgov_search"],
        };

        const allowedTools = new Set<string>(["fetch_url_content", "search_pdf_memory"]);

        for (const [source, tools] of Object.entries(sourceToTools)) {
            if (sources[source as keyof SourceSelection]) {
                for (const tool of tools) {
                    allowedTools.add(tool);
                }
            }
        }

        return TOOLS.filter((t) => allowedTools.has(t.function.name));
    }

    private requireApiKey(value: string, providerLabel: string): string {
        if (!value) {
            throw new Error(`${providerLabel} API key is required.`);
        }
        return value;
    }

    private ensureTrailingSlash(value: string): string {
        return value.endsWith("/") ? value : `${value}/`;
    }

    private normalizeGeminiBaseUrl(value: string): string {
        const withSlash = this.ensureTrailingSlash(value);
        return withSlash.replace(/\/openai\/?$/i, "/");
    }

    private parseToolArgs(raw: unknown): Record<string, unknown> {
        if (!raw) return {};
        if (typeof raw === "string") {
            try {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === "object") {
                    return parsed as Record<string, unknown>;
                }
            } catch {
                return {};
            }
        }
        if (typeof raw === "object") {
            return raw as Record<string, unknown>;
        }
        return {};
    }

    private async throwIfNotOk(response: Response, label: string): Promise<void> {
        if (response.ok) return;
        const body = await response.text();
        const trimmed = body.trim();
        const detail = trimmed ? `: ${trimmed.slice(0, 500)}` : "";
        throw new Error(`${label} API error (HTTP ${response.status} ${response.statusText})${detail}`);
    }

    async *chatStream(options: {
        sessionId: string;
        message: string;
        previousResponseId?: string;
        sources?: SourceSelection;
        days?: number;
        model?: string;
        provider?: string;
        apiMode?: "responses" | "chat_completions";
        customModel?: CustomModelConfig;
        apiKey?: string;
    }): AsyncGenerator<
        | { event: "step"; data: Step }
        | { event: "assistant_delta"; data: { delta: string } }
        | { event: "done"; data: { answer_text: string; sources: SourceItem[]; response_id?: string; model: string } }
        | { event: "error"; data: { error: string } }
    > {
        const {
            sessionId,
            message,
            previousResponseId,
            sources: rawSources,
            model,
            provider = "openai",
            apiMode = this.settings.defaultApiMode,
            customModel,
            apiKey,
        } = options;

        const sources = this.resolveSourceSelection(rawSources);
        const modelName = this.getModelName(provider, model, customModel);
        const filteredTools = this.filterToolsForSources(sources);
        const toolExecutor = new ToolExecutor(sessionId);

        try {
            if (provider === "anthropic") {
                yield* this.chatStreamAnthropic({
                    modelName,
                    message,
                    filteredTools,
                    toolExecutor,
                    apiKey,
                });
                return;
            }

            if (provider === "gemini") {
                yield* this.chatStreamGemini({
                    modelName,
                    message,
                    filteredTools,
                    toolExecutor,
                    apiKey,
                });
                return;
            }

            const client = this.getClient(provider, apiKey, customModel);

            if (apiMode === "responses") {
                yield* this.chatStreamResponses({
                    client,
                    modelName,
                    message,
                    previousResponseId,
                    filteredTools,
                    toolExecutor,
                });
            } else {
                yield* this.chatStreamCompletions({
                    client,
                    modelName,
                    message,
                    filteredTools,
                    toolExecutor,
                });
            }
        } catch (error) {
            console.error("Chat stream error:", error);
            yield { event: "error", data: { error: String(error) } };
        }
    }

    private async *chatStreamAnthropic(options: {
        modelName: string;
        message: string;
        filteredTools: OpenAI.Chat.Completions.ChatCompletionTool[];
        toolExecutor: ToolExecutor;
        apiKey?: string;
    }): AsyncGenerator<
        | { event: "step"; data: Step }
        | { event: "assistant_delta"; data: { delta: string } }
        | { event: "done"; data: { answer_text: string; sources: SourceItem[]; response_id?: string; model: string } }
    > {
        const { modelName, message, filteredTools, toolExecutor, apiKey } = options;

        const anthropicApiKey = this.requireApiKey(
            apiKey || this.settings.anthropicApiKey,
            "Anthropic"
        );
        const baseUrl = this.ensureTrailingSlash(this.settings.anthropicBaseUrl);

        const tools = filteredTools.map((tool) => ({
            name: tool.function.name,
            description: tool.function.description,
            input_schema: tool.function.parameters as Record<string, unknown>,
        }));

        type AnthropicContentBlock =
            | { type: "text"; text: string }
            | { type: "tool_use"; id: string; name: string; input?: unknown }
            | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

        type AnthropicMessage = { role: "user" | "assistant"; content: AnthropicContentBlock[] };

        const messages: AnthropicMessage[] = [
            { role: "user", content: [{ type: "text", text: message }] },
        ];

        let fullText = "";
        let continueLoop = true;

        while (continueLoop) {
            const response = await fetch(new URL("messages", baseUrl), {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-api-key": anthropicApiKey,
                    "anthropic-version": "2023-06-01",
                },
                body: JSON.stringify({
                    model: modelName,
                    max_tokens: 2048,
                    system: SYSTEM_INSTRUCTIONS,
                    messages,
                    tools: tools.length > 0 ? tools : undefined,
                }),
            });

            await this.throwIfNotOk(response, "Anthropic");

            const payload = (await response.json()) as { content?: AnthropicContentBlock[] };
            const contentBlocks = Array.isArray(payload.content) ? payload.content : [];

            const textBlocks = contentBlocks.filter((block) => block.type === "text") as Array<
                Extract<AnthropicContentBlock, { type: "text" }>
            >;
            const newText = textBlocks.map((block) => block.text || "").join("");
            if (newText) {
                fullText += newText;
                yield { event: "assistant_delta", data: { delta: newText } };
            }

            if (contentBlocks.length > 0) {
                messages.push({ role: "assistant", content: contentBlocks });
            }

            const toolUses = contentBlocks.filter((block) => block.type === "tool_use") as Array<
                Extract<AnthropicContentBlock, { type: "tool_use" }>
            >;

            if (toolUses.length > 0) {
                const toolResults: AnthropicContentBlock[] = [];

                for (const toolCall of toolUses) {
                    const args = this.parseToolArgs(toolCall.input);

                    const stepId = uuidv4();
                    yield {
                        event: "step",
                        data: {
                            step_id: stepId,
                            status: "running",
                            label: getToolLabel(toolCall.name, args),
                            tool_name: toolCall.name,
                            args,
                        },
                    };

                    const { result, preview } = await toolExecutor.execute(toolCall.name, args);

                    yield {
                        event: "step",
                        data: {
                            step_id: stepId,
                            status: "done",
                            label: getToolLabel(toolCall.name, args),
                            tool_name: toolCall.name,
                            args,
                            result_preview: preview,
                        },
                    };

                    toolResults.push({
                        type: "tool_result",
                        tool_use_id: toolCall.id,
                        content: this.formatToolOutput(result),
                    });
                }

                messages.push({
                    role: "user",
                    content: toolResults,
                });
            } else {
                continueLoop = false;
            }
        }

        yield {
            event: "done",
            data: {
                answer_text: fullText,
                sources: toolExecutor.getSources(),
                model: modelName,
            },
        };
    }

    private async *chatStreamGemini(options: {
        modelName: string;
        message: string;
        filteredTools: OpenAI.Chat.Completions.ChatCompletionTool[];
        toolExecutor: ToolExecutor;
        apiKey?: string;
    }): AsyncGenerator<
        | { event: "step"; data: Step }
        | { event: "assistant_delta"; data: { delta: string } }
        | { event: "done"; data: { answer_text: string; sources: SourceItem[]; response_id?: string; model: string } }
    > {
        const { modelName, message, filteredTools, toolExecutor, apiKey } = options;

        const geminiApiKey = this.requireApiKey(
            apiKey || this.settings.googleApiKey,
            "Google Gemini"
        );
        const baseUrl = this.normalizeGeminiBaseUrl(this.settings.geminiBaseUrl);
        const endpoint = new URL(`models/${encodeURIComponent(modelName)}:generateContent`, baseUrl);

        const functionDeclarations = filteredTools.map((tool) => ({
            name: tool.function.name,
            description: tool.function.description,
            parameters: tool.function.parameters as Record<string, unknown>,
        }));

        type GeminiContentPart = {
            text?: string;
            functionCall?: { name?: string; args?: unknown };
            functionResponse?: { name: string; response: Record<string, unknown> };
        };

        type GeminiMessage = { role: "user" | "model"; parts: GeminiContentPart[] };

        const messages: GeminiMessage[] = [
            { role: "user", parts: [{ text: message }] },
        ];

        let fullText = "";
        let continueLoop = true;

        while (continueLoop) {
            const response = await fetch(endpoint, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-goog-api-key": geminiApiKey,
                },
                body: JSON.stringify({
                    systemInstruction: {
                        role: "system",
                        parts: [{ text: SYSTEM_INSTRUCTIONS }],
                    },
                    contents: messages,
                    tools: functionDeclarations.length > 0
                        ? [{ functionDeclarations }]
                        : undefined,
                    generationConfig: { maxOutputTokens: 2048 },
                }),
            });

            await this.throwIfNotOk(response, "Gemini");

            const payload = (await response.json()) as {
                candidates?: Array<{ content?: { parts?: GeminiContentPart[] } }>;
            };

            const parts = payload.candidates?.[0]?.content?.parts ?? [];
            const text = parts.map((part) => part.text || "").join("");
            if (text) {
                fullText += text;
                yield { event: "assistant_delta", data: { delta: text } };
            }

            if (parts.length > 0) {
                messages.push({ role: "model", parts });
            }

            const toolCalls = parts.filter((part) => part.functionCall?.name);

            if (toolCalls.length > 0) {
                const toolResultParts: GeminiContentPart[] = [];

                for (const callPart of toolCalls) {
                    const call = callPart.functionCall;
                    const toolName = call?.name || "";
                    if (!toolName) {
                        continue;
                    }

                    const args = this.parseToolArgs(call?.args);

                    const stepId = uuidv4();
                    yield {
                        event: "step",
                        data: {
                            step_id: stepId,
                            status: "running",
                            label: getToolLabel(toolName, args),
                            tool_name: toolName,
                            args,
                        },
                    };

                    const { result, preview } = await toolExecutor.execute(toolName, args);

                    yield {
                        event: "step",
                        data: {
                            step_id: stepId,
                            status: "done",
                            label: getToolLabel(toolName, args),
                            tool_name: toolName,
                            args,
                            result_preview: preview,
                        },
                    };

                    toolResultParts.push({
                        functionResponse: {
                            name: toolName,
                            response: { result: this.formatToolOutput(result) },
                        },
                    });
                }

                if (toolResultParts.length > 0) {
                    messages.push({ role: "user", parts: toolResultParts });
                }
            } else {
                continueLoop = false;
            }
        }

        yield {
            event: "done",
            data: {
                answer_text: fullText,
                sources: toolExecutor.getSources(),
                model: modelName,
            },
        };
    }

    private async *chatStreamResponses(options: {
        client: OpenAI;
        modelName: string;
        message: string;
        previousResponseId?: string;
        filteredTools: OpenAI.Chat.Completions.ChatCompletionTool[];
        toolExecutor: ToolExecutor;
    }): AsyncGenerator<
        | { event: "step"; data: Step }
        | { event: "assistant_delta"; data: { delta: string } }
        | { event: "done"; data: { answer_text: string; sources: SourceItem[]; response_id?: string; model: string } }
    > {
        const { client, modelName, message, previousResponseId, filteredTools, toolExecutor } = options;

        // Build input based on previous response
        let input: string | OpenAI.Responses.ResponseInputItem[];
        if (previousResponseId) {
            input = [{ type: "message", role: "user", content: message }];
        } else {
            input = message;
        }

        // Convert tools to response format
        const responseTools = filteredTools.map((t) => ({
            type: "function" as const,
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters as Record<string, unknown>,
            strict: false as const,
        }));

        let responseId = previousResponseId;
        let fullText = "";
        let continueLoop = true;

        while (continueLoop) {
            const stream = await client.responses.create({
                model: modelName,
                input,
                instructions: SYSTEM_INSTRUCTIONS,
                tools: responseTools,
                previous_response_id: responseId,
                stream: true,
            });

            let pendingToolCalls: { id: string; name: string; arguments: string }[] = [];
            let currentToolCallId: string | null = null;

            for await (const event of stream) {
                if (event.type === "response.output_item.added") {
                    const item = event.item;
                    if (item.type === "function_call") {
                        currentToolCallId = item.call_id;
                        pendingToolCalls.push({
                            id: item.call_id,
                            name: item.name,
                            arguments: "",
                        });

                        const stepId = uuidv4();
                        yield {
                            event: "step",
                            data: {
                                step_id: stepId,
                                status: "running",
                                label: getToolLabel(item.name, {}),
                                tool_name: item.name,
                                args: {},
                            },
                        };
                    }
                }

                if (event.type === "response.function_call_arguments.delta") {
                    const call = pendingToolCalls.find((c) => c.id === currentToolCallId);
                    if (call) {
                        call.arguments += event.delta;
                    }
                }

                if (event.type === "response.output_text.delta") {
                    fullText += event.delta;
                    yield { event: "assistant_delta", data: { delta: event.delta } };
                }

                if (event.type === "response.completed") {
                    responseId = event.response.id;
                }
            }

            // Execute pending tool calls
            if (pendingToolCalls.length > 0) {
                const toolResults: { call_id: string; output: string }[] = [];

                for (const call of pendingToolCalls) {
                    let args: Record<string, unknown> = {};
                    try {
                        args = JSON.parse(call.arguments || "{}");
                    } catch {
                        args = {};
                    }

                    const stepId = uuidv4();
                    yield {
                        event: "step",
                        data: {
                            step_id: stepId,
                            status: "running",
                            label: getToolLabel(call.name, args),
                            tool_name: call.name,
                            args,
                        },
                    };

                    const { result, preview } = await toolExecutor.execute(call.name, args);

                    yield {
                        event: "step",
                        data: {
                            step_id: stepId,
                            status: "done",
                            label: getToolLabel(call.name, args),
                            tool_name: call.name,
                            args,
                            result_preview: preview,
                        },
                    };

                    toolResults.push({
                        call_id: call.id,
                        output: this.formatToolOutput(result),
                    });
                }

                // Continue with tool results
                input = toolResults.map((r) => ({
                    type: "function_call_output" as const,
                    call_id: r.call_id,
                    output: r.output,
                }));
                pendingToolCalls = [];
            } else {
                continueLoop = false;
            }
        }

        yield {
            event: "done",
            data: {
                answer_text: fullText,
                sources: toolExecutor.getSources(),
                response_id: responseId,
                model: modelName,
            },
        };
    }

    private async *chatStreamCompletions(options: {
        client: OpenAI;
        modelName: string;
        message: string;
        filteredTools: OpenAI.Chat.Completions.ChatCompletionTool[];
        toolExecutor: ToolExecutor;
    }): AsyncGenerator<
        | { event: "step"; data: Step }
        | { event: "assistant_delta"; data: { delta: string } }
        | { event: "done"; data: { answer_text: string; sources: SourceItem[]; model: string } }
    > {
        const { client, modelName, message, filteredTools, toolExecutor } = options;

        const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
            { role: "system", content: SYSTEM_INSTRUCTIONS },
            { role: "user", content: message },
        ];

        let fullText = "";
        let continueLoop = true;

        while (continueLoop) {
            const stream = await client.chat.completions.create({
                model: modelName,
                messages,
                tools: filteredTools.length > 0 ? filteredTools : undefined,
                stream: true,
            });

            let pendingToolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();
            let assistantContent = "";

            for await (const chunk of stream) {
                const delta = chunk.choices[0]?.delta;

                if (delta?.content) {
                    fullText += delta.content;
                    assistantContent += delta.content;
                    yield { event: "assistant_delta", data: { delta: delta.content } };
                }

                if (delta?.tool_calls) {
                    for (const tc of delta.tool_calls) {
                        const index = tc.index;
                        let call = pendingToolCalls.get(index);

                        if (!call && tc.id) {
                            call = { id: tc.id, name: tc.function?.name || "", arguments: "" };
                            pendingToolCalls.set(index, call);

                            const stepId = uuidv4();
                            yield {
                                event: "step",
                                data: {
                                    step_id: stepId,
                                    status: "running",
                                    label: getToolLabel(call.name, {}),
                                    tool_name: call.name,
                                    args: {},
                                },
                            };
                        }

                        if (call) {
                            if (tc.function?.name) {
                                call.name = tc.function.name;
                            }
                            if (tc.function?.arguments) {
                                call.arguments += tc.function.arguments;
                            }
                        }
                    }
                }
            }

            // Add assistant message to history
            if (assistantContent || pendingToolCalls.size > 0) {
                const toolCallsArray = Array.from(pendingToolCalls.values()).map((c) => ({
                    id: c.id,
                    type: "function" as const,
                    function: { name: c.name, arguments: c.arguments },
                }));

                messages.push({
                    role: "assistant",
                    content: assistantContent || null,
                    tool_calls: toolCallsArray.length > 0 ? toolCallsArray : undefined,
                });
            }

            // Execute tool calls
            if (pendingToolCalls.size > 0) {
                for (const call of pendingToolCalls.values()) {
                    let args: Record<string, unknown> = {};
                    try {
                        args = JSON.parse(call.arguments || "{}");
                    } catch {
                        args = {};
                    }

                    const stepId = uuidv4();
                    yield {
                        event: "step",
                        data: {
                            step_id: stepId,
                            status: "running",
                            label: getToolLabel(call.name, args),
                            tool_name: call.name,
                            args,
                        },
                    };

                    const { result, preview } = await toolExecutor.execute(call.name, args);

                    yield {
                        event: "step",
                        data: {
                            step_id: stepId,
                            status: "done",
                            label: getToolLabel(call.name, args),
                            tool_name: call.name,
                            args,
                            result_preview: preview,
                        },
                    };

                    messages.push({
                        role: "tool",
                        tool_call_id: call.id,
                        content: this.formatToolOutput(result),
                    });
                }

                pendingToolCalls = new Map();
            } else {
                continueLoop = false;
            }
        }

        yield {
            event: "done",
            data: {
                answer_text: fullText,
                sources: toolExecutor.getSources(),
                model: modelName,
            },
        };
    }

    async chat(options: {
        sessionId: string;
        message: string;
        previousResponseId?: string;
        sources?: SourceSelection;
        days?: number;
        model?: string;
        provider?: string;
        apiMode?: "responses" | "chat_completions";
        customModel?: CustomModelConfig;
        apiKey?: string;
    }): Promise<{
        answer_text: string;
        sources: SourceItem[];
        response_id?: string;
        model: string;
        steps: Step[];
    }> {
        const steps: Step[] = [];
        let answerText = "";
        let responseId: string | undefined;
        let modelUsed = "";
        let allSources: SourceItem[] = [];

        for await (const event of this.chatStream(options)) {
            if (event.event === "step") {
                // Update or add step
                const existingIndex = steps.findIndex((s) => s.step_id === event.data.step_id);
                if (existingIndex >= 0) {
                    steps[existingIndex] = event.data;
                } else {
                    steps.push(event.data);
                }
            } else if (event.event === "assistant_delta") {
                answerText += event.data.delta;
            } else if (event.event === "done") {
                answerText = event.data.answer_text;
                allSources = event.data.sources;
                responseId = event.data.response_id;
                modelUsed = event.data.model;
            } else if (event.event === "error") {
                throw new Error(event.data.error);
            }
        }

        return {
            answer_text: answerText,
            sources: allSources,
            response_id: responseId,
            model: modelUsed,
            steps,
        };
    }
}
