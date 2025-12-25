import crypto from "crypto";
import { getSettings } from "../config.js";
import OpenAI from "openai";
import { InferenceClient } from "@huggingface/inference";

export type EmbeddingProvider = "local" | "openai" | "gemini" | "huggingface" | "custom";

export type EmbeddingEndpointConfig = {
    provider: EmbeddingProvider;
    model: string;
    apiKey?: string | null;
    baseUrl?: string | null;
};

// Lazy-load transformers.js to avoid blocking startup
let pipeline: any = null;
let embeddingPipeline: any = null;
let embeddingPipelineModelId: string | null = null;

async function getLocalEmbeddingPipeline(modelId: string) {
    if (embeddingPipeline && embeddingPipelineModelId === modelId) {
        return embeddingPipeline;
    }

    if (!pipeline) {
        const transformers = await import("@xenova/transformers");
        pipeline = transformers.pipeline;
    }

    console.log(`Loading local embedding model (${modelId})...`);
    embeddingPipeline = await pipeline("feature-extraction", modelId);
    embeddingPipelineModelId = modelId;
    console.log("Local embedding model loaded successfully");
    return embeddingPipeline;
}

function normalizeEmbeddingConfig(config?: Partial<EmbeddingEndpointConfig> | null): EmbeddingEndpointConfig {
    const settings = getSettings();
    const provider = (config?.provider || (settings.embeddingProvider as EmbeddingProvider) || "local") as EmbeddingProvider;
    const model = String(config?.model || settings.embeddingModel || "").trim();
    if (!model) {
        throw new Error("Embedding model is not configured.");
    }

    const baseUrlFromSettings = String(settings.embeddingBaseUrl || "").trim();
    const baseUrl =
        provider === "custom"
            ? String(config?.baseUrl || "").trim()
            : provider === "openai"
                ? settings.openaiBaseUrl
                : provider === "gemini"
                    ? settings.geminiBaseUrl
                    : provider === "huggingface"
                        ? (String(config?.baseUrl || settings.huggingfaceEndpointUrl || "").trim() || null)
                    : baseUrlFromSettings || null;

    const apiKey =
        provider === "custom"
            ? (config?.apiKey ?? null)
            : provider === "openai"
                ? (config?.apiKey ?? settings.openaiApiKey ?? null)
            : provider === "gemini"
                ? (config?.apiKey ?? settings.googleApiKey ?? null)
            : provider === "huggingface"
                ? (config?.apiKey ?? settings.huggingfaceApiKey ?? null)
                : (config?.apiKey ?? null);

    return {
        provider,
        model,
        apiKey,
        baseUrl,
    };
}

function buildEmbeddingKey(config: EmbeddingEndpointConfig, dimensions: number): string {
    const material = JSON.stringify({
        provider: config.provider,
        model: config.model,
        baseUrl: config.baseUrl || "",
        dim: dimensions,
    });
    const hash = crypto.createHash("sha256").update(material).digest("hex").slice(0, 12);
    return `emb_${hash}_${dimensions}`;
}

export async function embedTexts(
    texts: string[],
    config?: Partial<EmbeddingEndpointConfig> | null
): Promise<{ embeddingKey: string; vectors: Float32Array[] }>{
    const resolved = normalizeEmbeddingConfig(config);

    if (resolved.provider === "local") {
        const extractor = await getLocalEmbeddingPipeline(resolved.model);
        const vectors: Float32Array[] = [];
        let embeddingKey: string | null = null;
        let dimensions: number | null = null;

        for (const text of texts) {
            const output = await extractor(text, { pooling: "mean", normalize: true });
            const embedding = new Float32Array(output.data);
            if (dimensions === null) {
                dimensions = embedding.length;
                embeddingKey = buildEmbeddingKey(resolved, dimensions);
            } else if (embedding.length !== dimensions) {
                throw new Error(`Embedding dimension changed within a batch (got ${embedding.length}, expected ${dimensions}).`);
            }
            vectors.push(embedding);
        }

        if (!embeddingKey) {
            throw new Error("Failed to compute local embeddings.");
        }

        return { embeddingKey, vectors };
    }

    if (resolved.provider === "huggingface") {
        const token = String(resolved.apiKey || "").trim();
        if (!token) {
            throw new Error("Hugging Face API key is missing for embeddings. Set HUGGINGFACE_API_KEY or provide embedding_api_key.");
        }

        const hf = resolved.baseUrl
            ? new InferenceClient(token, { endpointUrl: resolved.baseUrl })
            : new InferenceClient(token);

        const output = await hf.featureExtraction({
            model: resolved.model,
            inputs: texts,
            normalize: true,
        } as any);

        const vectors: Float32Array[] = [];

        function l2Normalize(vec: Float32Array): Float32Array {
            let sum = 0;
            for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
            const norm = Math.sqrt(sum) || 1;
            const out = new Float32Array(vec.length);
            for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
            return out;
        }

        function meanPool(matrix: number[][]): Float32Array {
            if (!matrix.length) {
                throw new Error("Empty token embedding matrix.");
            }
            const dim = matrix[0]?.length || 0;
            if (!dim) {
                throw new Error("Invalid token embedding dimensions.");
            }
            const acc = new Float32Array(dim);
            for (const row of matrix) {
                if (!Array.isArray(row) || row.length !== dim) {
                    throw new Error("Inconsistent token embedding dimensions.");
                }
                for (let i = 0; i < dim; i++) {
                    acc[i] += Number(row[i] || 0);
                }
            }
            for (let i = 0; i < dim; i++) {
                acc[i] /= matrix.length;
            }
            return l2Normalize(acc);
        }

        function toVector(item: unknown): Float32Array {
            if (!Array.isArray(item)) {
                throw new Error("Unexpected Hugging Face feature extraction output.");
            }
            if (item.length === 0) {
                throw new Error("Empty Hugging Face embedding output.");
            }
            const first = item[0] as any;
            if (typeof first === "number") {
                return l2Normalize(new Float32Array(item as number[]));
            }
            if (Array.isArray(first) && typeof first[0] === "number") {
                return meanPool(item as number[][]);
            }
            throw new Error("Unsupported Hugging Face embedding output shape.");
        }

        // Output shapes vary: either a single embedding (1D or 2D) or a list of per-input embeddings.
        if (Array.isArray(output) && output.length && typeof (output as any)[0] === "number") {
            vectors.push(toVector(output));
        } else if (Array.isArray(output) && output.length && Array.isArray((output as any)[0]) && texts.length === 1) {
            vectors.push(toVector(output));
        } else if (Array.isArray(output) && (output as any).length === texts.length) {
            for (const item of output as any[]) {
                vectors.push(toVector(item));
            }
        } else {
            throw new Error("Unexpected Hugging Face feature extraction output length.");
        }

        if (!vectors.length) {
            throw new Error("Empty Hugging Face embeddings output.");
        }

        const dimensions = vectors[0].length;
        for (const v of vectors) {
            if (v.length !== dimensions) {
                throw new Error(`Embedding dimension changed within a batch (got ${v.length}, expected ${dimensions}).`);
            }
        }

        return { embeddingKey: buildEmbeddingKey(resolved, dimensions), vectors };
    }

    const apiKey = String(resolved.apiKey || "").trim();
    if (!apiKey) {
        throw new Error("Embedding API key is missing for the selected provider.");
    }

    const client = resolved.baseUrl
        ? new OpenAI({ apiKey, baseURL: resolved.baseUrl })
        : new OpenAI({ apiKey });

    const response = await client.embeddings.create({
        model: resolved.model,
        input: texts,
    });

    const vectors: Float32Array[] = [];
    let dimensions: number | null = null;
    for (const item of response.data || []) {
        const embeddingArr = (item as any).embedding as number[] | undefined;
        if (!Array.isArray(embeddingArr)) {
            throw new Error("Unexpected embeddings response format.");
        }
        const embedding = new Float32Array(embeddingArr);
        if (dimensions === null) {
            dimensions = embedding.length;
        } else if (embedding.length !== dimensions) {
            throw new Error(`Embedding dimension changed within a batch (got ${embedding.length}, expected ${dimensions}).`);
        }
        vectors.push(embedding);
    }

    if (dimensions === null || vectors.length === 0) {
        throw new Error("Empty embeddings response.");
    }

    return { embeddingKey: buildEmbeddingKey(resolved, dimensions), vectors };
}
