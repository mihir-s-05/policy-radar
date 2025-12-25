import OpenAI from "openai";
import { getSettings } from "../config.js";
import type { SourceItem, SourceSelection, Step, StepEvent } from "../models/schemas.js";
import { ToolExecutor, getToolLabel } from "./toolExecutor.js";

const MAX_TOOL_TEXT_CHARS = 20000;
const MAX_TOOL_IMAGES = 2;
const MAX_IMAGE_BYTES = 200_000;
const MAX_IMAGE_TOTAL_BYTES = 250_000;

const SYSTEM_INSTRUCTIONS = `You are a neutral policy research assistant specializing in U.S. federal regulatory activity.

CRITICAL RULES:
1. Always use the available tools to search for up-to-date information. Never guess or make up information about regulations or federal activity.
2. Provide citations as links for every factual claim. Include at least one source per factual paragraph.
3. Do not provide legal advice. Always include this disclaimer at the end: "Note: This is not legal advice. Please verify information with official sources."
4. Be non-partisan and objective. Present information neutrally without political bias.
5. Keep responses readable and well-organized. Use bullet points or numbered lists for multiple items.

When searching:
- Prefer domain-specific tools when relevant; do not default to just Regulations.gov / GovInfo.
- Use regs_search_documents / regs_search_dockets for rulemaking, proposed/final rules, dockets, and comments.
- Use govinfo_search for official publications (incl. Federal Register) and broad gov publications.
- Use federal_register_search specifically for Federal Register items (rules, proposed rules, notices, presidential documents).
- Use congress_search_bills / congress_search_votes for legislation and roll call votes.
- Use usaspending_search for contracts, grants, awards, recipients, and funding flows.
- Use fiscal_data_query for Treasury Fiscal Data (debt, receipts, outlays, interest rates).
- Use datagov_search for datasets on data.gov and open data catalogs.
- Use doj_search for DOJ press releases and news.
- Use searchgov_search for broad search across government websites (when configured).
- Respect the user's time window by setting the 'days' parameter on any tool that supports it (when applicable).

READING FULL DOCUMENT CONTENT:
- After finding documents, use regs_read_document_content or govinfo_read_package_content to read the full text
- This allows you to understand and summarize the actual content, not just metadata
- Read the full content when the user asks for details, summaries, or analysis of specific documents
- Use fetch_url_content as a fallback for any government URL
- Some tools may include extracted PDF images as separate inputs. Use them when relevant.

USING PDF MEMORY (RAG):
- Use search_pdf_memory to retrieve previously indexed PDF content for this session when needed.
- If a PDF was read or indexed in this session and the user asks about its contents, call search_pdf_memory with the user's query before answering.
- When search_pdf_memory returns results, you MUST use the actual text content from the "matches" array in your response.
- The "matches" array contains relevant text chunks from the indexed PDFs - quote and cite these chunks directly in your answer.
- Include citations to the PDF URLs from the matches metadata when referencing the content.
- When the user requests quotes from PDFs, prioritize sources that provide PDF content and read those PDFs; then search the indexed PDF memory before responding.
- IMPORTANT: If search_pdf_memory returns matches, base your answer on those matches rather than just listing PDFs to download.

Format your response clearly with:
- A summary of what you found
- Key details organized logically
- Direct links to sources
- The required disclaimer at the end`;

const SOURCE_DISPLAY_NAMES: Record<string, string> = {
    regulations: "Regulations.gov",
    govinfo: "GovInfo",
    congress: "Congress.gov",
    federal_register: "Federal Register",
    usaspending: "USAspending.gov",
    fiscal_data: "Treasury Fiscal Data",
    datagov: "data.gov",
    doj: "DOJ",
    searchgov: "Search.gov",
};

const TOOL_TO_SOURCE: Record<string, string | null> = {
    regs_search_documents: "regulations",
    regs_search_dockets: "regulations",
    regs_get_document: "regulations",
    regs_read_document_content: "regulations",
    govinfo_search: "govinfo",
    govinfo_package_summary: "govinfo",
    govinfo_read_package_content: "govinfo",
    congress_search_bills: "congress",
    congress_search_votes: "congress",
    federal_register_search: "federal_register",
    usaspending_search: "usaspending",
    fiscal_data_query: "fiscal_data",
    datagov_search: "datagov",
    doj_search: "doj",
    searchgov_search: "searchgov",
    fetch_url_content: null,
    search_pdf_memory: null,
};

const TOOLS_WITH_DAYS_PARAM = new Set([
    "regs_search_documents",
    "govinfo_search",
    "federal_register_search",
    "usaspending_search",
    "doj_search",
]);

type ToolSpec = {
    type: "function";
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
};

export const TOOLS: ToolSpec[] = [
    {
        type: "function",
        name: "regs_search_documents",
        description: "Search for regulatory documents on Regulations.gov including proposed rules, final rules, notices, and other documents. Returns the most recent documents matching the search criteria.",
        parameters: {
            type: "object",
            properties: {
                search_term: {
                    type: "string",
                    description: "Search keywords for finding documents (e.g., 'asylum', 'water quality', 'immigration')",
                },
                days: {
                    type: "integer",
                    description: "Number of days to look back from today (e.g., 30, 60, 90)",
                    default: 30,
                },
                page_size: {
                    type: "integer",
                    description: "Number of results to return (max 25)",
                    default: 10,
                },
            },
            required: ["search_term"],
        },
    },
    {
        type: "function",
        name: "regs_search_dockets",
        description: "Search for dockets (rulemaking proceedings) on Regulations.gov. Dockets contain the full record of a rulemaking including all related documents and public comments.",
        parameters: {
            type: "object",
            properties: {
                search_term: {
                    type: "string",
                    description: "Search keywords for finding dockets",
                },
                page_size: {
                    type: "integer",
                    description: "Number of results to return",
                    default: 10,
                },
            },
            required: ["search_term"],
        },
    },
    {
        type: "function",
        name: "regs_get_document",
        description: "Get detailed information about a specific document from Regulations.gov by its document ID.",
        parameters: {
            type: "object",
            properties: {
                document_id: {
                    type: "string",
                    description: "The Regulations.gov document ID (e.g., 'EPA-HQ-OW-2024-0001-0001')",
                },
                include_attachments: {
                    type: "boolean",
                    description: "Whether to include attachment information",
                    default: false,
                },
            },
            required: ["document_id"],
        },
    },
    {
        type: "function",
        name: "govinfo_search",
        description: "Search GovInfo for Federal Register content and other official government publications. Supports keywords, collection filters, and time windows.",
        parameters: {
            type: "object",
            properties: {
                keywords: {
                    type: "string",
                    description: "Search keywords (e.g., 'immigration', 'water quality'). Use concise topic terms.",
                },
                collection: {
                    type: "string",
                    description: "Optional collection code filter (e.g., 'FR' for Federal Register).",
                },
                days: {
                    type: "integer",
                    description: "Number of days to look back from today (e.g., 30, 60, 90).",
                    default: 30,
                },
                query: {
                    type: "string",
                    description: "Advanced query override (e.g., 'collection:FR AND immigration AND publishdate:range(2024-01-01,)'). Use only when needed.",
                },
                page_size: {
                    type: "integer",
                    description: "Number of results to return",
                    default: 10,
                },
            },
            required: ["keywords"],
        },
    },
    {
        type: "function",
        name: "govinfo_package_summary",
        description: "Get detailed summary information about a specific GovInfo package by its package ID.",
        parameters: {
            type: "object",
            properties: {
                package_id: {
                    type: "string",
                    description: "The GovInfo package ID",
                },
            },
            required: ["package_id"],
        },
    },
    {
        type: "function",
        name: "regs_read_document_content",
        description: "Read and extract the full text content of a Regulations.gov document. Use this after searching to get the complete document text for analysis and summarization.",
        parameters: {
            type: "object",
            properties: {
                document_id: {
                    type: "string",
                    description: "The Regulations.gov document ID to read (e.g., 'EPA-HQ-OW-2024-0001-0001')",
                },
            },
            required: ["document_id"],
        },
    },
    {
        type: "function",
        name: "govinfo_read_package_content",
        description: "Read and extract the full text content of a GovInfo package (Federal Register entry, bill, etc.). Use this after searching to get the complete document text for analysis and summarization.",
        parameters: {
            type: "object",
            properties: {
                package_id: {
                    type: "string",
                    description: "The GovInfo package ID to read",
                },
            },
            required: ["package_id"],
        },
    },
    {
        type: "function",
        name: "fetch_url_content",
        description: "Fetch and extract text content from any government URL. Use this as a fallback when you have a URL but need to read its content.",
        parameters: {
            type: "object",
            properties: {
                url: {
                    type: "string",
                    description: "The URL to fetch content from (should be a .gov or official government URL)",
                },
                max_length: {
                    type: "integer",
                    description: "Optional maximum length of text to return. Increase for longer documents.",
                    default: 15000,
                },
                full_text: {
                    type: "boolean",
                    description: "Set true to return the full extracted text without truncation.",
                    default: false,
                },
            },
            required: ["url"],
        },
    },
    {
        type: "function",
        name: "search_pdf_memory",
        description: "Search indexed PDF content stored in memory for this session. Returns relevant text chunks from previously indexed PDFs. You MUST use the text content from the 'matches' array in your response when this tool returns results. The matches contain the actual PDF text that answers the user's query.",
        parameters: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "Search query for the PDF memory.",
                },
                top_k: {
                    type: "integer",
                    description: "Number of matches to return.",
                    default: 5,
                },
            },
            required: ["query"],
        },
    },
    {
        type: "function",
        name: "congress_search_bills",
        description: "Search Congress.gov for bills and legislation. Returns bill titles, numbers, sponsors, and status.",
        parameters: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "Search keywords for bills (e.g., 'immigration reform', 'tax credit')",
                },
                congress: {
                    type: "integer",
                    description: "Congress number (e.g., 118 for 118th Congress). Defaults to current.",
                },
                limit: {
                    type: "integer",
                    description: "Number of results to return",
                    default: 10,
                },
            },
            required: ["query"],
        },
    },
    {
        type: "function",
        name: "congress_search_votes",
        description: "Search Congress.gov for roll call votes. Returns vote results and which members voted yea/nay.",
        parameters: {
            type: "object",
            properties: {
                chamber: {
                    type: "string",
                    description: "Congressional chamber: 'house' or 'senate'",
                    enum: ["house", "senate"],
                    default: "house",
                },
                congress: {
                    type: "integer",
                    description: "Congress number (defaults to 118)",
                },
                limit: {
                    type: "integer",
                    description: "Number of results",
                    default: 10,
                },
            },
            required: [],
        },
    },
    {
        type: "function",
        name: "federal_register_search",
        description: "Search the Federal Register for rules, proposed rules, notices, and presidential documents. No API key required.",
        parameters: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "Search keywords",
                },
                document_type: {
                    type: "string",
                    description: "Filter by type: RULE, PRORULE (proposed rule), NOTICE, or PRESDOCU (presidential)",
                    enum: ["RULE", "PRORULE", "NOTICE", "PRESDOCU"],
                },
                days: {
                    type: "integer",
                    description: "Number of days to look back",
                    default: 30,
                },
                limit: {
                    type: "integer",
                    description: "Number of results",
                    default: 10,
                },
            },
            required: ["query"],
        },
    },
    {
        type: "function",
        name: "usaspending_search",
        description: "Search USAspending.gov for federal spending, contracts, grants, and awards. Returns a markdown summary suitable for analysis.",
        parameters: {
            type: "object",
            properties: {
                keywords: {
                    type: "array",
                    items: { type: "string" },
                    description: "Search keywords (e.g., ['defense', 'aircraft'])",
                },
                agency: {
                    type: "string",
                    description: "Filter by awarding agency name",
                },
                award_type: {
                    type: "string",
                    description: "Type of award: 'contracts', 'grants', 'loans', or 'direct_payments'",
                    enum: ["contracts", "grants", "loans", "direct_payments"],
                },
                days: {
                    type: "integer",
                    description: "Number of days to look back",
                    default: 365,
                },
                limit: {
                    type: "integer",
                    description: "Number of results",
                    default: 10,
                },
            },
            required: ["award_type"],
        },
    },
    {
        type: "function",
        name: "fiscal_data_query",
        description: "Query Treasury Fiscal Data API for debt, interest rates, receipts, and outlays. Returns a markdown summary.",
        parameters: {
            type: "object",
            properties: {
                dataset: {
                    type: "string",
                    description: "Dataset to query",
                    enum: ["debt_to_penny", "interest_rates", "monthly_receipts", "monthly_outlays"],
                    default: "debt_to_penny",
                },
                limit: {
                    type: "integer",
                    description: "Number of records",
                    default: 10,
                },
            },
            required: [],
        },
    },
    {
        type: "function",
        name: "datagov_search",
        description: "Search data.gov for government datasets. Returns dataset titles, descriptions, and resource links.",
        parameters: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "Search keywords (e.g., 'climate data', 'census')",
                },
                organization: {
                    type: "string",
                    description: "Filter by organization/agency",
                },
                format: {
                    type: "string",
                    description: "Filter by resource format (CSV, JSON, PDF, etc.)",
                },
                limit: {
                    type: "integer",
                    description: "Number of results",
                    default: 10,
                },
            },
            required: ["query"],
        },
    },
    {
        type: "function",
        name: "doj_search",
        description: "Search Department of Justice press releases and news.",
        parameters: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "Search keywords",
                },
                component: {
                    type: "string",
                    description: "DOJ component (e.g., 'fbi', 'dea', 'civil-rights')",
                },
                days: {
                    type: "integer",
                    description: "Number of days to look back",
                    default: 30,
                },
                limit: {
                    type: "integer",
                    description: "Number of results",
                    default: 10,
                },
            },
            required: [],
        },
    },
    {
        type: "function",
        name: "searchgov_search",
        description: "Search across government websites using Search.gov. Only available if configured with SEARCHGOV_AFFILIATE and SEARCHGOV_ACCESS_KEY.",
        parameters: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "Search keywords",
                },
                limit: {
                    type: "integer",
                    description: "Number of results",
                    default: 10,
                },
            },
            required: ["query"],
        },
    },
];

export class OpenAIService {
    private client: OpenAI;
    private routingClient: OpenAI | null;
    private model: string;
    private routingModel: string;
    private toolExecutor: ToolExecutor;
    private signal?: AbortSignal;

    constructor(options?: {
        sessionId?: string;
        baseUrl?: string;
        apiKey?: string;
        signal?: AbortSignal;
        embedding?: { provider?: "local" | "openai" | "gemini" | "huggingface" | "custom" | null; model?: string | null; apiKey?: string | null; baseUrl?: string | null } | null;
    }) {
        const settings = getSettings();
        const effectiveApiKey = options?.apiKey || settings.openaiApiKey;

        if (options?.baseUrl) {
            this.client = new OpenAI({ apiKey: effectiveApiKey, baseURL: options.baseUrl });
        } else {
            this.client = new OpenAI({ apiKey: effectiveApiKey });
        }

        this.model = settings.openaiModel;
        this.routingModel = settings.openaiModel;
        this.routingClient = settings.openaiApiKey
            ? new OpenAI({ apiKey: settings.openaiApiKey, baseURL: settings.openaiBaseUrl })
            : null;
        this.toolExecutor = new ToolExecutor(options?.sessionId || null);
        this.toolExecutor.setEmbeddingConfig(options?.embedding || null);
        this.signal = options?.signal;
    }

    private makeValueError(message: string): Error {
        const err = new Error(message);
        err.name = "ValueError";
        return err;
    }

    private checkAborted(): void {
        if (this.signal?.aborted) {
            const err = new Error("Request aborted");
            err.name = "AbortError";
            throw err;
        }
    }

    private truncateForModel(text: string): { text: string; truncated: boolean } {
        if (!text || text.length <= MAX_TOOL_TEXT_CHARS) {
            return { text, truncated: false };
        }

        let truncated = text.slice(0, MAX_TOOL_TEXT_CHARS);
        const lastPeriod = truncated.lastIndexOf(".");
        if (lastPeriod > MAX_TOOL_TEXT_CHARS * 0.8) {
            truncated = truncated.slice(0, lastPeriod + 1);
        }
        truncated += "\n\n[Content truncated for model context...]";
        return { text: truncated, truncated: true };
    }

    private shortenLabelValue(value: string, maxLen: number = 60): string {
        if (!value) return "";
        if (value.length <= maxLen) return value;
        return value.slice(0, maxLen - 3) + "...";
    }

    private formatPdfSearchLabel(query: string, preview?: Record<string, unknown> | null): string {
        const base = `Search PDF memory: ${this.shortenLabelValue(query || "", 50)}`;
        if (!preview) return base;
        const documents = (preview.documents as Record<string, unknown>[] | undefined) || [];
        if (!documents.length) return base;
        const firstDoc = documents[0] || {};
        const docLabel =
            (firstDoc.doc_key as string) ||
            (firstDoc.pdf_url as string) ||
            "";
        const shortLabel = this.shortenLabelValue(docLabel, 50);
        if (!shortLabel) return base;
        if (documents.length > 1) {
            return `${base} (top: ${shortLabel} +${documents.length - 1})`;
        }
        return `${base} (top: ${shortLabel})`;
    }

    private buildPdfIndexStep(preview?: Record<string, unknown> | null): {
        label: string;
        status: "done" | "error";
        toolName: string;
        args: Record<string, unknown>;
        resultPreview: Record<string, unknown>;
    } | null {
        if (!preview) return null;
        const pdfIndex = preview.pdf_index as Record<string, unknown> | undefined;
        if (!pdfIndex || typeof pdfIndex !== "object") return null;

        const status = String(pdfIndex.status || "");
        const docLabel =
            (pdfIndex.doc_key as string) ||
            (pdfIndex.pdf_url as string) ||
            (pdfIndex.source_url as string) ||
            "";
        const shortLabel = this.shortenLabelValue(docLabel, 50);
        let labelBase = "Index PDF memory";
        if (status === "skipped") {
            labelBase = "Index PDF memory skipped";
        } else if (status === "failed") {
            labelBase = "Index PDF memory failed";
        }
        const label = shortLabel ? `${labelBase}: ${shortLabel}` : labelBase;

        const args: Record<string, unknown> = {};
        if (pdfIndex.doc_key) args.doc_key = pdfIndex.doc_key;
        if (pdfIndex.source_type) args.source_type = pdfIndex.source_type;
        if (pdfIndex.pdf_url) args.pdf_url = pdfIndex.pdf_url;
        if (pdfIndex.source_url) args.source_url = pdfIndex.source_url;

        return {
            label,
            status: status === "failed" ? "error" : "done",
            toolName: "index_pdf_memory",
            args,
            resultPreview: pdfIndex,
        };
    }

    private buildPdfSearchStep(
        query: string,
        preview?: Record<string, unknown> | null,
        status: "done" | "error" = "done"
    ): {
        label: string;
        status: "done" | "error";
        toolName: string;
        args: Record<string, unknown>;
        resultPreview: Record<string, unknown> | null;
    } {
        const label = this.formatPdfSearchLabel(query, preview || undefined);
        return {
            label,
            status,
            toolName: "search_pdf_memory",
            args: { query },
            resultPreview: preview || null,
        };
    }

    private prepareToolOutput(toolName: string, result: Record<string, unknown>): {
        safeResult: Record<string, unknown>;
        imageMessage: OpenAI.Responses.ResponseInputItem | null;
    } {
        const images = result.images as Record<string, unknown>[] | undefined;
        const safeResult: Record<string, unknown> = Object.fromEntries(
            Object.entries(result).filter(([key]) => key !== "images")
        );

        if (typeof safeResult.full_text === "string" && safeResult.full_text) {
            const originalLen = safeResult.full_text.length;
            const { text, truncated } = this.truncateForModel(safeResult.full_text);
            if (truncated) {
                safeResult.full_text = text;
                safeResult.full_text_length = originalLen;
                safeResult.full_text_truncated = true;
                console.log(
                    `Truncated full_text for ${toolName} from ${originalLen} chars to ${text.length} chars`
                );
            }
        }

        if (typeof safeResult.text === "string" && safeResult.text) {
            const originalLen = safeResult.text.length;
            const { text, truncated } = this.truncateForModel(safeResult.text);
            if (truncated) {
                safeResult.text = text;
                safeResult.text_length = originalLen;
                safeResult.text_truncated = true;
                console.log(
                    `Truncated text for ${toolName} from ${originalLen} chars to ${text.length} chars`
                );
            }
        }

        if (!images || images.length === 0) {
            return { safeResult, imageMessage: null };
        }

        const imageInputs: Array<{ type: "input_image"; image_url: string } | { type: "input_text"; text: string }> = [];
        const imageMeta: Record<string, unknown>[] = [];
        const sourceLabel =
            (result.url as string) ||
            (result.document_id as string) ||
            (result.package_id as string) ||
            toolName;

        let skippedImages = 0;
        let totalImageBytes = 0;

        for (const image of images) {
            if (imageInputs.filter((item) => item.type === "input_image").length >= MAX_TOOL_IMAGES) {
                skippedImages += 1;
                continue;
            }

            const byteSize = typeof image.byte_size === "number" ? image.byte_size : 0;
            if (byteSize && byteSize > MAX_IMAGE_BYTES) {
                skippedImages += 1;
                continue;
            }
            if (byteSize && totalImageBytes + byteSize > MAX_IMAGE_TOTAL_BYTES) {
                skippedImages += 1;
                continue;
            }

            const data = image.data_base64 as string | undefined;
            const mimeType = (image.mime_type as string) || "image/png";
            if (data) {
                imageInputs.push({
                    type: "input_image",
                    image_url: `data:${mimeType};base64,${data}`,
                });
                totalImageBytes += byteSize;
            }

            imageMeta.push({
                id: image.id,
                page: image.page,
                source: image.source,
                mime_type: mimeType,
                width: image.width,
                height: image.height,
                byte_size: image.byte_size,
            });
        }

        let messageItem: OpenAI.Responses.ResponseInputItem | null = null;
        if (imageInputs.length > 0) {
            const lines: string[] = [`Images extracted from ${sourceLabel}:`];
            for (const meta of imageMeta) {
                let label = (meta.id as string) || "image";
                const details: string[] = [];
                if (meta.page) details.push(`page ${meta.page}`);
                if (meta.source) details.push(String(meta.source));
                if (details.length > 0) {
                    label = `${label} (${details.join(", ")})`;
                }
                lines.push(`- ${label}`);
            }
            imageInputs.unshift({ type: "input_text", text: lines.join("\n") });
            messageItem = {
                type: "message",
                role: "user",
                content: imageInputs,
            } as OpenAI.Responses.ResponseInputItem;
        }

        if (imageMeta.length > 0) {
            safeResult.image_count = imageMeta.length;
            safeResult.image_metadata = imageMeta;
            if (skippedImages) {
                safeResult.images_skipped_for_model = skippedImages;
            }
            console.log(`Prepared ${imageMeta.length} image(s) for model input from ${sourceLabel}`);
        } else if (skippedImages) {
            safeResult.image_count = 0;
            safeResult.images_skipped_for_model = skippedImages;
            console.log(`Skipped ${skippedImages} image(s) for model input from ${sourceLabel}`);
        }

        return { safeResult, imageMessage: messageItem };
    }

    private formatUserMessage(options: {
        message: string;
        days: number;
        selectedSources?: Set<string> | null;
        autoRationale?: string | null;
    }): string {
        const { message, days, selectedSources, autoRationale } = options;
        let sourcesLine = "Auto";
        if (selectedSources && selectedSources.size > 0) {
            sourcesLine = Array.from(selectedSources)
                .sort()
                .map((s) => SOURCE_DISPLAY_NAMES[s] || s)
                .join(", ");
        }
        const rationaleLine = autoRationale ? `\n- Auto selection: ${autoRationale}` : "";

        return `User query: ${message}\n\nSearch context:\n- Time window: Last ${days} days\n- Sources: ${sourcesLine}${rationaleLine}\n\nIf a PDF was indexed for this session, use search_pdf_memory with the user query before answering. When search_pdf_memory returns matches, USE the text content from those matches in your response - quote and cite the actual PDF content, don't just list PDFs to download.\n\nPlease search for relevant information and provide a comprehensive answer with citations.`;
    }

    private getConfiguredSources(): Set<string> {
        const settings = getSettings();
        const configured = new Set<string>(Object.keys(SOURCE_DISPLAY_NAMES));

        if (!settings.govApiKey) {
            configured.delete("regulations");
            configured.delete("govinfo");
            configured.delete("congress");
        }

        if (!settings.searchGovAffiliate || !settings.searchGovAccessKey) {
            configured.delete("searchgov");
        }

        return configured;
    }

    private filterToolsForSources(tools: ToolSpec[], selectedSources: Set<string>): ToolSpec[] {
        const filtered: ToolSpec[] = [];
        for (const tool of tools) {
            const sourceKey = TOOL_TO_SOURCE[tool.name];
            if (sourceKey === null || selectedSources.has(sourceKey)) {
                filtered.push(tool);
            }
        }
        return filtered;
    }

    private wantsAllSources(message: string): boolean {
        const text = message.toLowerCase();
        return (
            text.includes("as many sources as possible") ||
            text.includes("as many sources") ||
            text.includes("all sources") ||
            text.includes("all available sources") ||
            text.includes("all possible sources") ||
            text.includes("every source") ||
            text.includes("across all sources")
        );
    }

    private resolveSourcePreferences(
        mode: string,
        sources?: SourceSelection | null,
        message?: string
    ): { autoEnabled: boolean; allowedSources: Set<string> } {
        const configuredSources = this.getConfiguredSources();
        const forceAllSources = Boolean(message && this.wantsAllSources(message));

        if (!sources) {
            if (mode === "regulations") {
                return { autoEnabled: false, allowedSources: new Set(["regulations"].filter((s) => configuredSources.has(s))) };
            }
            if (mode === "govinfo") {
                return { autoEnabled: false, allowedSources: new Set(["govinfo"].filter((s) => configuredSources.has(s))) };
            }
            return {
                autoEnabled: true,
                allowedSources: new Set(
                    [...Object.keys(SOURCE_DISPLAY_NAMES)].filter((s) => configuredSources.has(s))
                ),
            };
        }

        let requestedSources = new Set<string>(
            Object.keys(SOURCE_DISPLAY_NAMES).filter((key) => Boolean((sources as Record<string, boolean>)[key]))
        );
        const autoEnabled = Boolean((sources as Record<string, boolean>).auto);

        if (forceAllSources) {
            requestedSources = new Set(Object.keys(SOURCE_DISPLAY_NAMES));
        }

        if (requestedSources.size === 0) {
            if (autoEnabled) {
                requestedSources = new Set(Object.keys(SOURCE_DISPLAY_NAMES));
            } else {
                return { autoEnabled: false, allowedSources: new Set() };
            }
        }

        if (mode === "regulations") {
            requestedSources = new Set([...requestedSources].filter((s) => s === "regulations"));
        } else if (mode === "govinfo") {
            requestedSources = new Set([...requestedSources].filter((s) => s === "govinfo"));
        }

        requestedSources = new Set([...requestedSources].filter((s) => configuredSources.has(s)));

        return { autoEnabled: autoEnabled || forceAllSources, allowedSources: requestedSources };
    }

    private extractJsonObject(text: string): Record<string, unknown> | null {
        if (!text) return null;
        const trimmed = text.trim();
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                return parsed as Record<string, unknown>;
            }
        } catch {
        }

        const match = trimmed.match(/\{[\s\S]*\}/);
        if (!match) return null;
        try {
            const parsed = JSON.parse(match[0]);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                return parsed as Record<string, unknown>;
            }
        } catch {
            return null;
        }

        return null;
    }

    private async autoSelectSources(options: {
        message: string;
        allowedSources: Set<string>;
        modelToUse: string;
    }): Promise<{ selected: Set<string>; rationale?: string | null }> {
        const { message, allowedSources, modelToUse } = options;
        if (allowedSources.size === 0) {
            return { selected: new Set() };
        }
        if (allowedSources.size === 1) {
            return { selected: new Set(allowedSources), rationale: "Only one source available." };
        }

        const sourceDescriptions: Record<string, string> = {
            regulations: "Rulemakings, dockets, proposed/final rules, comments, CFR changes (Regulations.gov).",
            govinfo: "Official publications and PDFs (Federal Register, bills, reports, gov docs) via GovInfo.",
            federal_register: "Federal Register rules, notices, presidential docs (official FR API).",
            congress: "Bills, legislation status, roll call votes, sponsors/committees (Congress.gov).",
            usaspending: "Federal awards, contracts, grants, recipients (USAspending.gov).",
            fiscal_data: "Treasury fiscal time series (debt, receipts, outlays, interest rates).",
            datagov: "Open data catalog and datasets (data.gov).",
            doj: "DOJ press releases and enforcement announcements.",
            searchgov: "Broad .gov site search (Search.gov) for agency pages and guidance.",
        };

        const optionsText = Array.from(allowedSources)
            .sort()
            .map((key) => `- ${key}: ${SOURCE_DISPLAY_NAMES[key]} — ${sourceDescriptions[key] || ""}`)
            .join("\n");

        const rubric = `Routing guidance (choose all that apply):
- regulations: rulemakings, dockets, proposed/final rules, CFR changes, agency regulatory actions
- govinfo: official publications, broad federal documents; good companion for regulations/federal register
- federal_register: rules/notices/presidential documents specifically in the Federal Register
- congress: bills, legislation status, roll call votes, sponsors, committees
- usaspending: federal awards/contracts/grants, recipients, agencies, award totals
- fiscal_data: Treasury fiscal time series (debt, receipts, outlays, interest rates)
- datagov: datasets, open data resources, data catalog discovery
- doj: DOJ press releases, enforcement announcements, investigations (public-facing)
- searchgov: broad web search across .gov sites (when query is broad or agency-specific web pages are needed)`;

        const selectorMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
            {
                role: "system",
                content:
                    "You route user queries to the most relevant data sources. " +
                    "Use the routing guidance and choose the sources most likely to contain authoritative results. " +
                    "Return STRICT JSON only: {\"sources\": [\"source_key\", ...], \"rationale\": \"short\"}. " +
                    "Choose 1-6 sources; choose fewer when the query is narrow. Only choose from the allowed list.",
            },
            {
                role: "user",
                content: `User query: ${message}\n\nAllowed sources:\n${optionsText}\n\n${rubric}`,
            },
        ];

        const routingClient = this.routingClient || this.client;
        const routingModel = this.routingClient ? this.routingModel : modelToUse;
        const tryJsonResponse = async (useResponseFormat: boolean) => {
            const response = await routingClient.chat.completions.create({
                model: routingModel,
                messages: selectorMessages,
                temperature: 0,
                max_completion_tokens: 200,
                ...(useResponseFormat ? { response_format: { type: "json_object" } } : {}),
            });

            const raw = response.choices[0]?.message?.content || "";
            const data = this.extractJsonObject(raw) || {};
            const chosen = Array.isArray(data.sources)
                ? data.sources.filter((s: unknown) => typeof s === "string" && allowedSources.has(s))
                : [];
            const selected = new Set((chosen as string[]).slice(0, 6));
            const rationale = typeof data.rationale === "string" ? data.rationale : null;

            if (!selected.size) {
                return {
                    selected: new Set(allowedSources),
                    rationale: "No sources selected; using all allowed sources.",
                };
            }

            return { selected, rationale };
        };

        try {
            return await tryJsonResponse(true);
        } catch (error) {
            try {
                return await tryJsonResponse(false);
            } catch (inner) {
                console.warn(`Auto source selection failed; using all allowed sources: ${inner}`);
                return {
                    selected: new Set(allowedSources),
                    rationale: "Routing unavailable; using all allowed sources.",
                };
            }
        }
    }

    private applyDaysDefault(toolName: string, args: Record<string, unknown>, days: number): void {
        if (TOOLS_WITH_DAYS_PARAM.has(toolName) && args.days === undefined) {
            args.days = days;
        }
    }

    private getAvailableTools(mode: string, selectedSources?: Set<string> | null): ToolSpec[] {
        const fetchUrlTool = TOOLS.filter((t) => t.name === "fetch_url_content");
        const memoryTool = TOOLS.filter((t) => t.name === "search_pdf_memory");

        let tools: ToolSpec[] = [];
        if (mode === "regulations") {
            const regsTools = TOOLS.filter((t) => t.name.startsWith("regs_"));
            tools = [...regsTools, ...fetchUrlTool, ...memoryTool];
        } else if (mode === "govinfo") {
            const govinfoTools = TOOLS.filter((t) => t.name.startsWith("govinfo_"));
            tools = [...govinfoTools, ...fetchUrlTool, ...memoryTool];
        } else {
            tools = [...TOOLS];
        }

        if (!selectedSources) return tools;
        return this.filterToolsForSources(tools, selectedSources);
    }

    private convertToolsForChatCompletions(tools: ToolSpec[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
        return tools.map((tool) => ({
            type: "function",
            function: {
                name: tool.name,
                description: tool.description || "",
                parameters: tool.parameters || { type: "object", properties: {} },
            },
        }));
    }

    private convertToolsForResponses(tools: ToolSpec[]): OpenAI.Responses.Tool[] {
        return tools.map((tool) => ({
            type: "function",
            name: tool.name,
            description: tool.description || "",
            parameters: tool.parameters || { type: "object", properties: {} },
            strict: false,
        }));
    }

    async chatCompletions(options: {
        message: string;
        mode: string;
        days: number;
        model?: string;
        sources?: SourceSelection | null;
    }): Promise<{
        answerText: string;
        sources: SourceItem[];
        reasoningSummary: string | null;
        steps: Step[];
        responseId: string;
        modelUsed: string;
    }> {
        this.toolExecutor.clearSources();
        const steps: Step[] = [];
        let stepCounter = 0;

        const modelToUse = options.model || this.model;
        const { autoEnabled, allowedSources } = this.resolveSourcePreferences(
            options.mode,
            options.sources,
            options.message
        );
        if (allowedSources.size === 0) {
            throw this.makeValueError("No sources enabled/available for this request.");
        }

        let selectedSources = allowedSources;
        let autoRationale: string | null = null;
        if (autoEnabled) {
            stepCounter += 1;
            if (this.wantsAllSources(options.message)) {
                selectedSources = allowedSources;
                autoRationale = "User requested all sources.";
            } else {
                const { selected, rationale } = await this.autoSelectSources({
                    message: options.message,
                    allowedSources,
                    modelToUse,
                });
                selectedSources = selected.size === 0 ? allowedSources : selected;
                autoRationale = rationale || null;
            }
            console.log(
                `Auto-select sources (sync): allowed=${Array.from(allowedSources).sort().join(",")}; ` +
                `selected=${Array.from(selectedSources).sort().join(",")}; ` +
                `rationale=${autoRationale || "none"}`
            );

            steps.push({
                step_id: String(stepCounter),
                status: "done",
                label: "Auto-select sources",
                tool_name: "auto_select_sources",
                args: { allowed_sources: Array.from(allowedSources).sort() },
                result_preview: {
                    selected_sources: Array.from(selectedSources).sort(),
                    rationale: autoRationale,
                },
            });
        }

        const formattedMessage = this.formatUserMessage({
            message: options.message,
            days: options.days,
            selectedSources,
            autoRationale,
        });
        const availableTools = this.getAvailableTools(options.mode, selectedSources);
        const chatTools = this.convertToolsForChatCompletions(availableTools);

        const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
            { role: "system", content: SYSTEM_INSTRUCTIONS },
            { role: "user", content: formattedMessage },
        ];

        let response = await this.client.chat.completions.create({
            model: modelToUse,
            messages,
            tools: chatTools.length > 0 ? chatTools : undefined,
            tool_choice: chatTools.length > 0 ? "auto" : undefined,
        });

        while (response.choices[0]?.message?.tool_calls?.length) {
            const toolCalls = response.choices[0].message.tool_calls || [];
            messages.push(response.choices[0].message);

            for (const call of toolCalls) {
                stepCounter += 1;
                const stepId = String(stepCounter);
                const toolName = call.function?.name || "";
                let args: Record<string, unknown> = {};
                try {
                    args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
                } catch {
                    args = {};
                }

                if (
                    (toolName === "regs_search_documents" || toolName === "govinfo_search") &&
                    args.days === undefined
                ) {
                    args.days = options.days;
                }

                const step: Step = {
                    step_id: stepId,
                    status: "running",
                    label: getToolLabel(toolName, args),
                    tool_name: toolName,
                    args,
                };
                steps.push(step);

                const { result, preview } = await this.toolExecutor.executeTool(toolName, args);
                const { safeResult } = this.prepareToolOutput(toolName, result);

                step.status = safeResult.error ? "error" : "done";
                step.result_preview = preview;
                if (toolName === "search_pdf_memory") {
                    step.label = this.formatPdfSearchLabel(String(args.query || ""), preview);
                }

                const pdfIndexStep = this.buildPdfIndexStep(preview);
                if (pdfIndexStep) {
                    stepCounter += 1;
                    steps.push({
                        step_id: String(stepCounter),
                        status: pdfIndexStep.status,
                        label: pdfIndexStep.label,
                        tool_name: pdfIndexStep.toolName,
                        args: pdfIndexStep.args,
                        result_preview: pdfIndexStep.resultPreview,
                    });

                    const searchQuery = options.message.trim();
                    if (searchQuery) {
                        const searchResult = await this.toolExecutor.executeTool("search_pdf_memory", {
                            query: searchQuery,
                        });
                        const { safeResult: safeSearch } = this.prepareToolOutput(
                            "search_pdf_memory",
                            searchResult.result
                        );
                        safeResult.pdf_memory_search = safeSearch;

                        stepCounter += 1;
                        const searchStep = this.buildPdfSearchStep(
                            searchQuery,
                            searchResult.preview,
                            safeSearch.error ? "error" : "done"
                        );
                        steps.push({
                            step_id: String(stepCounter),
                            status: searchStep.status,
                            label: searchStep.label,
                            tool_name: searchStep.toolName,
                            args: searchStep.args,
                            result_preview: searchStep.resultPreview || undefined,
                        });
                    }
                }

                messages.push({
                    role: "tool",
                    tool_call_id: call.id || "",
                    content: JSON.stringify(safeResult),
                });
            }

            response = await this.client.chat.completions.create({
                model: modelToUse,
                messages,
                tools: chatTools.length > 0 ? chatTools : undefined,
                tool_choice: chatTools.length > 0 ? "auto" : undefined,
            });
        }

        const answerText = response.choices[0]?.message?.content || "";
        const sources = this.toolExecutor.getCollectedSources();

        return {
            answerText,
            sources,
            reasoningSummary: null,
            steps,
            responseId: response.id || "",
            modelUsed: modelToUse,
        };
    }

    async *chatCompletionsStream(options: {
        message: string;
        mode: string;
        days: number;
        model?: string;
        sources?: SourceSelection | null;
    }): AsyncGenerator<
        | { event: "step"; data: StepEvent }
        | { event: "assistant_delta"; data: { delta: string } }
        | { event: "done"; data: { answer_text: string; sources: SourceItem[]; response_id: string; model: string } }
    > {
        this.toolExecutor.clearSources();
        let stepCounter = 0;

        const modelToUse = options.model || this.model;
        const { autoEnabled, allowedSources } = this.resolveSourcePreferences(
            options.mode,
            options.sources,
            options.message
        );
        if (allowedSources.size === 0) {
            throw this.makeValueError("No sources enabled/available for this request.");
        }

        let selectedSources = allowedSources;
        let autoRationale: string | null = null;
        if (autoEnabled) {
            stepCounter += 1;
            const autoStepId = String(stepCounter);
            yield {
                event: "step",
                data: {
                    step_id: autoStepId,
                    status: "running",
                    label: "Auto-select sources",
                    tool_name: "auto_select_sources",
                    args: { allowed_sources: Array.from(allowedSources).sort() },
                },
            };

            if (this.wantsAllSources(options.message)) {
                selectedSources = allowedSources;
                autoRationale = "User requested all sources.";
            } else {
                const { selected, rationale } = await this.autoSelectSources({
                    message: options.message,
                    allowedSources,
                    modelToUse,
                });
                selectedSources = selected.size === 0 ? allowedSources : selected;
                autoRationale = rationale || null;
            }
            console.log(
                `Auto-select sources (stream chat_completions): allowed=${Array.from(allowedSources).sort().join(",")}; ` +
                `selected=${Array.from(selectedSources).sort().join(",")}; ` +
                `rationale=${autoRationale || "none"}`
            );

            yield {
                event: "step",
                data: {
                    step_id: autoStepId,
                    status: "done",
                    result_preview: {
                        selected_sources: Array.from(selectedSources).sort(),
                        rationale: autoRationale,
                    },
                },
            };
        }

        const formattedMessage = this.formatUserMessage({
            message: options.message,
            days: options.days,
            selectedSources,
            autoRationale,
        });
        const availableTools = this.getAvailableTools(options.mode, selectedSources);
        const chatTools = this.convertToolsForChatCompletions(availableTools);

        const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
            { role: "system", content: SYSTEM_INSTRUCTIONS },
            { role: "user", content: formattedMessage },
        ];

        let response = await this.client.chat.completions.create({
            model: modelToUse,
            messages,
            tools: chatTools.length > 0 ? chatTools : undefined,
            tool_choice: chatTools.length > 0 ? "auto" : undefined,
        });

        while (response.choices[0]?.message?.tool_calls?.length) {
            this.checkAborted();

            const toolCalls = response.choices[0].message.tool_calls || [];
            messages.push(response.choices[0].message);

            for (const call of toolCalls) {
                stepCounter += 1;
                const stepId = String(stepCounter);
                const toolName = call.function?.name || "";
                let args: Record<string, unknown> = {};
                try {
                    args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
                } catch {
                    args = {};
                }

                this.applyDaysDefault(toolName, args, options.days);

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

                const { result, preview } = await this.toolExecutor.executeTool(toolName, args);
                const { safeResult } = this.prepareToolOutput(toolName, result);

                const labelOverride = toolName === "search_pdf_memory"
                    ? this.formatPdfSearchLabel(String(args.query || ""), preview)
                    : undefined;

                yield {
                    event: "step",
                    data: {
                        step_id: stepId,
                        status: safeResult.error ? "error" : "done",
                        result_preview: preview,
                        label: labelOverride,
                    },
                };

                const pdfIndexStep = this.buildPdfIndexStep(preview);
                if (pdfIndexStep) {
                    stepCounter += 1;
                    yield {
                        event: "step",
                        data: {
                            step_id: String(stepCounter),
                            status: pdfIndexStep.status,
                            label: pdfIndexStep.label,
                            tool_name: pdfIndexStep.toolName,
                            args: pdfIndexStep.args,
                            result_preview: pdfIndexStep.resultPreview,
                        },
                    };

                    const searchQuery = options.message.trim();
                    if (searchQuery) {
                        stepCounter += 1;
                        const searchStepId = String(stepCounter);
                        yield {
                            event: "step",
                            data: {
                                step_id: searchStepId,
                                status: "running",
                                label: "Search PDF memory",
                                tool_name: "search_pdf_memory",
                                args: { query: searchQuery },
                            },
                        };

                        const searchResult = await this.toolExecutor.executeTool("search_pdf_memory", {
                            query: searchQuery,
                        });
                        const { safeResult: safeSearch } = this.prepareToolOutput(
                            "search_pdf_memory",
                            searchResult.result
                        );
                        safeResult.pdf_memory_search = safeSearch;

                        const searchStep = this.buildPdfSearchStep(
                            searchQuery,
                            searchResult.preview,
                            safeSearch.error ? "error" : "done"
                        );
                        yield {
                            event: "step",
                            data: {
                                step_id: searchStepId,
                                status: searchStep.status,
                                label: searchStep.label,
                                tool_name: searchStep.toolName,
                                args: searchStep.args,
                                result_preview: searchStep.resultPreview || undefined,
                            },
                        };
                    }
                }

                messages.push({
                    role: "tool",
                    tool_call_id: call.id || "",
                    content: JSON.stringify(safeResult),
                });
            }

            response = await this.client.chat.completions.create({
                model: modelToUse,
                messages,
                tools: chatTools.length > 0 ? chatTools : undefined,
                tool_choice: chatTools.length > 0 ? "auto" : undefined,
            });
        }

        const finalText = response.choices[0]?.message?.content || "";
        const chunkSize = 50;
        for (let i = 0; i < finalText.length; i += chunkSize) {
            const chunk = finalText.slice(i, i + chunkSize);
            yield { event: "assistant_delta", data: { delta: chunk } };
            await new Promise((resolve) => setTimeout(resolve, 10));
        }

        const sources = this.toolExecutor.getCollectedSources();

        yield {
            event: "done",
            data: {
                answer_text: finalText,
                sources,
                response_id: response.id || "",
                model: modelToUse,
            },
        };
    }

    async chat(options: {
        message: string;
        mode: string;
        days: number;
        model?: string;
        sources?: SourceSelection | null;
        previousResponseId?: string | null;
    }): Promise<{
        answerText: string;
        sources: SourceItem[];
        reasoningSummary: string | null;
        steps: Step[];
        responseId: string;
        modelUsed: string;
    }> {
        this.toolExecutor.clearSources();
        const steps: Step[] = [];
        let stepCounter = 0;

        const modelToUse = options.model || this.model;
        const { autoEnabled, allowedSources } = this.resolveSourcePreferences(
            options.mode,
            options.sources,
            options.message
        );
        if (allowedSources.size === 0) {
            throw this.makeValueError("No sources enabled/available for this request.");
        }

        let selectedSources = allowedSources;
        let autoRationale: string | null = null;
        if (autoEnabled) {
            stepCounter += 1;
            if (this.wantsAllSources(options.message)) {
                selectedSources = allowedSources;
                autoRationale = "User requested all sources.";
            } else {
                const { selected, rationale } = await this.autoSelectSources({
                    message: options.message,
                    allowedSources,
                    modelToUse,
                });
                selectedSources = selected.size === 0 ? allowedSources : selected;
                autoRationale = rationale || null;
            }
            console.log(
                `Auto-select sources (sync responses): allowed=${Array.from(allowedSources).sort().join(",")}; ` +
                `selected=${Array.from(selectedSources).sort().join(",")}; ` +
                `rationale=${autoRationale || "none"}`
            );
            steps.push({
                step_id: String(stepCounter),
                status: "done",
                label: "Auto-select sources",
                tool_name: "auto_select_sources",
                args: { allowed_sources: Array.from(allowedSources).sort() },
                result_preview: {
                    selected_sources: Array.from(selectedSources).sort(),
                    rationale: autoRationale,
                },
            });
        }

        const formattedMessage = this.formatUserMessage({
            message: options.message,
            days: options.days,
            selectedSources,
            autoRationale,
        });
        const availableTools = this.getAvailableTools(options.mode, selectedSources);
        const responseTools = this.convertToolsForResponses(availableTools);

        const inputMessages: OpenAI.Responses.ResponseInputItem[] = [
            { type: "message", role: "user", content: formattedMessage },
        ];

        let response = await this.client.responses.create({
            model: modelToUse,
            instructions: SYSTEM_INSTRUCTIONS,
            input: inputMessages,
            tools: responseTools,
            parallel_tool_calls: false,
            previous_response_id: options.previousResponseId || undefined,
        });

        let currentResponseId = response.id;
        const reasoningSummary: string | null = null;

        while (true) {
            const functionCalls = (response.output || []).filter((item) => item.type === "function_call") as Array<{
                type: "function_call";
                name: string;
                arguments: string;
                call_id: string;
            }>;

            if (!functionCalls.length) {
                break;
            }

            const functionOutputs: OpenAI.Responses.ResponseInputItem[] = [];

            for (const call of functionCalls) {
                stepCounter += 1;
                const stepId = String(stepCounter);
                const toolName = call.name;
                let args: Record<string, unknown> = {};
                try {
                    args = call.arguments ? JSON.parse(call.arguments) : {};
                } catch {
                    args = {};
                }

                this.applyDaysDefault(toolName, args, options.days);

                const step: Step = {
                    step_id: stepId,
                    status: "running",
                    label: getToolLabel(toolName, args),
                    tool_name: toolName,
                    args,
                };
                steps.push(step);

                const { result, preview } = await this.toolExecutor.executeTool(toolName, args);
                const { safeResult, imageMessage } = this.prepareToolOutput(toolName, result);

                step.status = safeResult.error ? "error" : "done";
                step.result_preview = preview;
                if (toolName === "search_pdf_memory") {
                    step.label = this.formatPdfSearchLabel(String(args.query || ""), preview);
                }

                const pdfIndexStep = this.buildPdfIndexStep(preview);
                if (pdfIndexStep) {
                    stepCounter += 1;
                    steps.push({
                        step_id: String(stepCounter),
                        status: pdfIndexStep.status,
                        label: pdfIndexStep.label,
                        tool_name: pdfIndexStep.toolName,
                        args: pdfIndexStep.args,
                        result_preview: pdfIndexStep.resultPreview,
                    });

                    const searchQuery = options.message.trim();
                    if (searchQuery) {
                        const searchResult = await this.toolExecutor.executeTool("search_pdf_memory", {
                            query: searchQuery,
                        });
                        const { safeResult: safeSearch } = this.prepareToolOutput(
                            "search_pdf_memory",
                            searchResult.result
                        );
                        safeResult.pdf_memory_search = safeSearch;

                        stepCounter += 1;
                        const searchStep = this.buildPdfSearchStep(
                            searchQuery,
                            searchResult.preview,
                            safeSearch.error ? "error" : "done"
                        );
                        steps.push({
                            step_id: String(stepCounter),
                            status: searchStep.status,
                            label: searchStep.label,
                            tool_name: searchStep.toolName,
                            args: searchStep.args,
                            result_preview: searchStep.resultPreview || undefined,
                        });
                    }
                }

                functionOutputs.push({
                    type: "function_call_output",
                    call_id: call.call_id,
                    output: JSON.stringify(safeResult),
                });

                if (imageMessage) {
                    functionOutputs.push(imageMessage);
                }
            }

            response = await this.client.responses.create({
                model: modelToUse,
                instructions: SYSTEM_INSTRUCTIONS,
                input: functionOutputs,
                tools: responseTools,
                parallel_tool_calls: false,
                previous_response_id: currentResponseId,
            });
            currentResponseId = response.id;
        }

        let answerText = "";
        for (const item of response.output || []) {
            if (item.type === "message") {
                const contents = item.content || [];
                for (const content of contents) {
                    if (content.type === "output_text") {
                        answerText = content.text || "";
                        break;
                    }
                }
            }
        }

        const sources = this.toolExecutor.getCollectedSources();

        return {
            answerText,
            sources,
            reasoningSummary,
            steps,
            responseId: currentResponseId,
            modelUsed: modelToUse,
        };
    }

    async *chatStream(options: {
        message: string;
        mode: string;
        days: number;
        model?: string;
        sources?: SourceSelection | null;
        previousResponseId?: string | null;
    }): AsyncGenerator<
        | { event: "step"; data: StepEvent }
        | { event: "assistant_delta"; data: { delta: string } }
        | { event: "done"; data: { answer_text: string; sources: SourceItem[]; response_id: string; model: string } }
    > {
        this.toolExecutor.clearSources();
        let stepCounter = 0;

        const modelToUse = options.model || this.model;
        const { autoEnabled, allowedSources } = this.resolveSourcePreferences(
            options.mode,
            options.sources,
            options.message
        );
        if (allowedSources.size === 0) {
            throw this.makeValueError("No sources enabled/available for this request.");
        }

        let selectedSources = allowedSources;
        let autoRationale: string | null = null;
        if (autoEnabled) {
            stepCounter += 1;
            const autoStepId = String(stepCounter);
            yield {
                event: "step",
                data: {
                    step_id: autoStepId,
                    status: "running",
                    label: "Auto-select sources",
                    tool_name: "auto_select_sources",
                    args: { allowed_sources: Array.from(allowedSources).sort() },
                },
            };

            if (this.wantsAllSources(options.message)) {
                selectedSources = allowedSources;
                autoRationale = "User requested all sources.";
            } else {
                const { selected, rationale } = await this.autoSelectSources({
                    message: options.message,
                    allowedSources,
                    modelToUse,
                });
                selectedSources = selected.size === 0 ? allowedSources : selected;
                autoRationale = rationale || null;
            }
            console.log(
                `Auto-select sources (stream responses): allowed=${Array.from(allowedSources).sort().join(",")}; ` +
                `selected=${Array.from(selectedSources).sort().join(",")}; ` +
                `rationale=${autoRationale || "none"}`
            );

            yield {
                event: "step",
                data: {
                    step_id: autoStepId,
                    status: "done",
                    result_preview: {
                        selected_sources: Array.from(selectedSources).sort(),
                        rationale: autoRationale,
                    },
                },
            };
        }

        const formattedMessage = this.formatUserMessage({
            message: options.message,
            days: options.days,
            selectedSources,
            autoRationale,
        });
        const availableTools = this.getAvailableTools(options.mode, selectedSources);
        const responseTools = this.convertToolsForResponses(availableTools);

        const inputMessages: OpenAI.Responses.ResponseInputItem[] = [
            { type: "message", role: "user", content: formattedMessage },
        ];

        let response = await this.client.responses.create({
            model: modelToUse,
            instructions: SYSTEM_INSTRUCTIONS,
            input: inputMessages,
            tools: responseTools,
            parallel_tool_calls: false,
            previous_response_id: options.previousResponseId || undefined,
        });

        let currentResponseId = response.id;

        while (true) {
            this.checkAborted();

            const functionCalls = (response.output || []).filter((item) => item.type === "function_call") as Array<{
                type: "function_call";
                name: string;
                arguments: string;
                call_id: string;
            }>;

            if (!functionCalls.length) {
                break;
            }

            const functionOutputs: OpenAI.Responses.ResponseInputItem[] = [];

            for (const call of functionCalls) {
                stepCounter += 1;
                const stepId = String(stepCounter);
                const toolName = call.name;
                let args: Record<string, unknown> = {};
                try {
                    args = call.arguments ? JSON.parse(call.arguments) : {};
                } catch {
                    args = {};
                }

                this.applyDaysDefault(toolName, args, options.days);

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

                const { result, preview } = await this.toolExecutor.executeTool(toolName, args);
                const { safeResult, imageMessage } = this.prepareToolOutput(toolName, result);

                const labelOverride = toolName === "search_pdf_memory"
                    ? this.formatPdfSearchLabel(String(args.query || ""), preview)
                    : undefined;

                yield {
                    event: "step",
                    data: {
                        step_id: stepId,
                        status: safeResult.error ? "error" : "done",
                        result_preview: preview,
                        label: labelOverride,
                    },
                };

                const pdfIndexStep = this.buildPdfIndexStep(preview);
                if (pdfIndexStep) {
                    stepCounter += 1;
                    yield {
                        event: "step",
                        data: {
                            step_id: String(stepCounter),
                            status: pdfIndexStep.status,
                            label: pdfIndexStep.label,
                            tool_name: pdfIndexStep.toolName,
                            args: pdfIndexStep.args,
                            result_preview: pdfIndexStep.resultPreview,
                        },
                    };

                    const searchQuery = options.message.trim();
                    if (searchQuery) {
                        stepCounter += 1;
                        const searchStepId = String(stepCounter);
                        yield {
                            event: "step",
                            data: {
                                step_id: searchStepId,
                                status: "running",
                                label: "Search PDF memory",
                                tool_name: "search_pdf_memory",
                                args: { query: searchQuery },
                            },
                        };

                        const searchResult = await this.toolExecutor.executeTool("search_pdf_memory", {
                            query: searchQuery,
                        });
                        const { safeResult: safeSearch } = this.prepareToolOutput(
                            "search_pdf_memory",
                            searchResult.result
                        );
                        safeResult.pdf_memory_search = safeSearch;

                        const searchStep = this.buildPdfSearchStep(
                            searchQuery,
                            searchResult.preview,
                            safeSearch.error ? "error" : "done"
                        );
                        yield {
                            event: "step",
                            data: {
                                step_id: searchStepId,
                                status: searchStep.status,
                                label: searchStep.label,
                                tool_name: searchStep.toolName,
                                args: searchStep.args,
                                result_preview: searchStep.resultPreview || undefined,
                            },
                        };
                    }
                }

                functionOutputs.push({
                    type: "function_call_output",
                    call_id: call.call_id,
                    output: JSON.stringify(safeResult),
                });
                if (imageMessage) {
                    functionOutputs.push(imageMessage);
                }
            }

            response = await this.client.responses.create({
                model: modelToUse,
                instructions: SYSTEM_INSTRUCTIONS,
                input: functionOutputs,
                tools: responseTools,
                parallel_tool_calls: false,
                previous_response_id: currentResponseId,
            });
            currentResponseId = response.id;
        }

        let finalText = "";
        for (const item of response.output || []) {
            if (item.type === "message") {
                const contents = item.content || [];
                for (const content of contents) {
                    if (content.type === "output_text") {
                        const text = content.text || "";
                        const chunkSize = 50;
                        for (let i = 0; i < text.length; i += chunkSize) {
                            const chunk = text.slice(i, i + chunkSize);
                            yield { event: "assistant_delta", data: { delta: chunk } };
                            finalText += chunk;
                            await new Promise((resolve) => setTimeout(resolve, 10));
                        }
                    }
                }
            }
        }

        const sources = this.toolExecutor.getCollectedSources();

        yield {
            event: "done",
            data: {
                answer_text: finalText,
                sources,
                response_id: currentResponseId,
                model: modelToUse,
            },
        };
    }
}
