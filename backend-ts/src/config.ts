import { config } from "dotenv";

// Load .env file
config();

export interface Settings {
    // API Keys
    govApiKey: string;
    openaiApiKey: string;
    anthropicApiKey: string;
    googleApiKey: string;

    // Model settings
    openaiModel: string;
    embeddingModel: string;
    llmProvider: string;
    availableModels: string[];
    defaultApiMode: "responses" | "chat_completions";

    // API Base URLs
    openaiBaseUrl: string;
    anthropicBaseUrl: string;
    geminiBaseUrl: string;

    // Provider model lists
    anthropicModels: string[];
    geminiModels: string[];

    // Government API URLs
    regulationsBaseUrl: string;
    govInfoBaseUrl: string;
    congressBaseUrl: string;
    federalRegisterBaseUrl: string;
    usaSpendingBaseUrl: string;
    fiscalDataBaseUrl: string;
    dataGovBaseUrl: string;
    dojBaseUrl: string;
    searchGovBaseUrl: string;

    // Search.gov credentials
    searchGovAffiliate: string;
    searchGovAccessKey: string;

    // Database
    databasePath: string;

    // Server
    port: number;

    // Cache
    cacheTtl: number;

    // Retry settings
    maxRetries: number;
    initialBackoff: number;

    // RAG settings
    ragCollection: string;
    ragPersistDir: string;
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
        // API Keys
        govApiKey: process.env.GOV_API_KEY || "",
        openaiApiKey: process.env.OPENAI_API_KEY || "",
        anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
        googleApiKey: process.env.GOOGLE_API_KEY || "",

        // Model settings
        openaiModel: process.env.OPENAI_MODEL || "gpt-5.2",
        embeddingModel: process.env.EMBEDDING_MODEL || "text-embedding-3-small",
        llmProvider: process.env.LLM_PROVIDER || "openai",
        availableModels: ["gpt-5.2", "gpt-5.1", "gpt-5-mini"],
        defaultApiMode: (process.env.DEFAULT_API_MODE as "responses" | "chat_completions") || "responses",

        // API Base URLs
        openaiBaseUrl: "https://api.openai.com/v1",
        anthropicBaseUrl: "https://api.anthropic.com/v1",
        geminiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",

        // Provider model lists
        anthropicModels: [
            "claude-opus-4-5-20251101",
            "claude-haiku-4-5-20251001",
            "claude-sonnet-4-5-20250929",
        ],
        geminiModels: [
            "gemini-3-pro-preview",
            "gemini-3-flash-preview",
            "gemini-2.5-flash",
            "gemini-2.5-pro",
        ],

        // Government API URLs
        regulationsBaseUrl: "https://api.regulations.gov/v4",
        govInfoBaseUrl: "https://api.govinfo.gov",
        congressBaseUrl: "https://api.congress.gov/v3",
        federalRegisterBaseUrl: "https://www.federalregister.gov/api/v1",
        usaSpendingBaseUrl: "https://api.usaspending.gov/api/v2",
        fiscalDataBaseUrl: "https://api.fiscaldata.treasury.gov/services/api/fiscal_service",
        dataGovBaseUrl: "https://api.gsa.gov/technology/datagov/v3/action",
        dojBaseUrl: "https://www.justice.gov/api/v1",
        searchGovBaseUrl: "https://api.gsa.gov/technology/searchgov/v2",

        // Search.gov credentials
        searchGovAffiliate: process.env.SEARCHGOV_AFFILIATE || "",
        searchGovAccessKey: process.env.SEARCHGOV_ACCESS_KEY || "",

        // Database
        databasePath: process.env.DATABASE_PATH || "./policy_radar.db",

        // Server
        port: parseInt(process.env.PORT || "8001", 10),

        // Cache
        cacheTtl: 600,

        // Retry settings
        maxRetries: 3,
        initialBackoff: 1.0,

        // RAG settings
        ragCollection: process.env.RAG_COLLECTION || "pdf_memory",
        ragPersistDir: process.env.RAG_PERSIST_DIR || "./chroma",
        ragChunkSize: parseInt(process.env.RAG_CHUNK_SIZE || "1200", 10),
        ragChunkOverlap: parseInt(process.env.RAG_CHUNK_OVERLAP || "200", 10),
        ragMaxChunks: parseInt(process.env.RAG_MAX_CHUNKS || "500", 10),
        ragTopK: parseInt(process.env.RAG_TOP_K || "5", 10),
    };

    return cachedSettings;
}
