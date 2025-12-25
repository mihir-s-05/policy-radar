import { config } from "dotenv";

config();

export interface Settings {
    govApiKey: string;
    openaiApiKey: string;
    anthropicApiKey: string;
    googleApiKey: string;
    huggingfaceApiKey: string;

    openaiModel: string;
    embeddingModel: string;
    embeddingProvider: string;
    llmProvider: string;
    availableModels: string[];
    defaultApiMode: "responses" | "chat_completions";

    openaiBaseUrl: string;
    anthropicBaseUrl: string;
    geminiBaseUrl: string;

    embeddingBaseUrl: string;
    huggingfaceEndpointUrl: string;

    anthropicModels: string[];
    geminiModels: string[];

    regulationsBaseUrl: string;
    govInfoBaseUrl: string;
    congressBaseUrl: string;
    federalRegisterBaseUrl: string;
    usaSpendingBaseUrl: string;
    fiscalDataBaseUrl: string;
    dataGovBaseUrl: string;
    dojBaseUrl: string;
    searchGovBaseUrl: string;

    searchGovAffiliate: string;
    searchGovAccessKey: string;

    databasePath: string;

    port: number;

    cacheTtl: number;

    maxRetries: number;
    initialBackoff: number;

    ragChunkSize: number;
    ragChunkOverlap: number;
    ragMaxChunks: number;
    ragTopK: number;
}

let cachedSettings: Settings | null = null;

export function getSettings(): Settings {
    if (cachedSettings) {
        return cachedSettings;
    }

    cachedSettings = {
        govApiKey: process.env.GOV_API_KEY || "",
        openaiApiKey: process.env.OPENAI_API_KEY || "",
        anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
        googleApiKey: process.env.GOOGLE_API_KEY || "",
        huggingfaceApiKey: process.env.HUGGINGFACE_API_KEY || "",

        openaiModel: process.env.OPENAI_MODEL || "gpt-5.2",
        // Used by the local PDF RAG embedding pipeline (Transformers.js).
        embeddingModel: process.env.EMBEDDING_MODEL || "Xenova/all-MiniLM-L6-v2",
        embeddingProvider: process.env.EMBEDDING_PROVIDER || "local",
        llmProvider: process.env.LLM_PROVIDER || "openai",
        availableModels: ["gpt-5.2", "gpt-5-mini", "gpt-5.1", "o3"],
        defaultApiMode: (process.env.DEFAULT_API_MODE as "responses" | "chat_completions") || "responses",

        openaiBaseUrl: "https://api.openai.com/v1",
        anthropicBaseUrl: "https://api.anthropic.com/v1",
        geminiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",

        // Optional: override for OpenAI-compatible embedding endpoints when EMBEDDING_PROVIDER != local.
        embeddingBaseUrl: process.env.EMBEDDING_BASE_URL || "",
        // Optional: override Hugging Face inference endpoint URL (e.g. a dedicated Inference Endpoint).
        huggingfaceEndpointUrl: process.env.HUGGINGFACE_ENDPOINT_URL || "",

        anthropicModels: [
            "claude-opus-4-5-20251101",
            "claude-sonnet-4-5-20250929",
            "claude-haiku-4-5-20251001",
        ],
        geminiModels: [
            "gemini-3-pro",
            "gemini-3-flash-preview",
        ],

        regulationsBaseUrl: "https://api.regulations.gov/v4",
        govInfoBaseUrl: "https://api.govinfo.gov",
        congressBaseUrl: "https://api.congress.gov/v3",
        federalRegisterBaseUrl: "https://www.federalregister.gov/api/v1",
        usaSpendingBaseUrl: "https://api.usaspending.gov/api/v2",
        fiscalDataBaseUrl: "https://api.fiscaldata.treasury.gov/services/api/fiscal_service",
        dataGovBaseUrl: "https://api.gsa.gov/technology/datagov/v3/action",
        dojBaseUrl: "https://www.justice.gov/api/v1",
        searchGovBaseUrl: "https://api.gsa.gov/technology/searchgov/v2",

        searchGovAffiliate: process.env.SEARCHGOV_AFFILIATE || "",
        searchGovAccessKey: process.env.SEARCHGOV_ACCESS_KEY || "",

        databasePath: process.env.DATABASE_PATH || "./policy_radar.db",

        port: parseInt(process.env.PORT || "8001", 10),

        cacheTtl: 600,

        maxRetries: 3,
        initialBackoff: 1.0,

        ragChunkSize: parseInt(process.env.RAG_CHUNK_SIZE || "1200", 10),
        ragChunkOverlap: parseInt(process.env.RAG_CHUNK_OVERLAP || "200", 10),
        ragMaxChunks: parseInt(process.env.RAG_MAX_CHUNKS || "500", 10),
        ragTopK: parseInt(process.env.RAG_TOP_K || "5", 10),
    };

    return cachedSettings;
}
