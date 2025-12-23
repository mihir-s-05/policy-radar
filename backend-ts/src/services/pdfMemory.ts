import { ChromaClient, Collection, IncludeEnum } from "chromadb";
import OpenAI from "openai";
import crypto from "crypto";
import { getSettings } from "../config.js";
import { ensureChromaServerRunning } from "./chromaServer.js";

let pdfMemoryStore: PdfMemoryStore | null = null;

export class PdfMemoryStore {
    private settings = getSettings();
    private client: ChromaClient;
    private collection: Collection | null = null;
    private openai: OpenAI;
    private chromaHealthy = true;
    private chromaRetryAfter = 0;
    private chromaFailures = 0;

    constructor() {
        const serverUrl = this.settings.chromaServerUrl;
        this.client = new ChromaClient({
            path: serverUrl,
        });
        this.openai = new OpenAI({ apiKey: this.settings.openaiApiKey });
        console.log(`PDF memory store initialized with Chroma at ${serverUrl}`);
    }

    private markChromaUnavailable(message?: string): void {
        this.chromaHealthy = false;
        this.chromaFailures += 1;
        const backoffMs = Math.min(30000, 1000 * Math.pow(2, this.chromaFailures));
        this.chromaRetryAfter = Date.now() + backoffMs;
        if (message) {
            console.warn(`Chroma unavailable: ${message}`);
        }
    }

    private async getCollection(): Promise<Collection | null> {
        const now = Date.now();
        if (!this.chromaHealthy && now < this.chromaRetryAfter) {
            return null;
        }

        try {
            const ready = await ensureChromaServerRunning();
            if (!ready) {
                return null;
            }
            if (!this.collection) {
                this.collection = await this.client.getOrCreateCollection({
                    name: this.settings.ragCollection,
                    metadata: { "hnsw:space": "cosine" },
                });
            }
            this.chromaHealthy = true;
            this.chromaFailures = 0;
            return this.collection;
        } catch (error) {
            this.markChromaUnavailable((error as Error).message);
            return null;
        }
    }

    private whereAll(filters: Record<string, string | undefined>): Record<string, unknown> {
        const parts = Object.entries(filters)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => ({ [k]: v }));

        if (!parts.length) return {};
        if (parts.length === 1) return parts[0];
        return { $and: parts };
    }

    private normalizeText(text: string): string {
        text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        text = text.replace(/[ \t]+/g, " ");
        text = text.replace(/\n{3,}/g, "\n\n");
        return text.trim();
    }

    private chooseChunkSize(textLength: number): number {
        const baseSize = Math.max(200, this.settings.ragChunkSize);
        if (textLength <= 0) return baseSize;

        const minSize = Math.max(300, Math.floor(baseSize * 0.6));
        const maxSize = Math.max(minSize + 200, Math.floor(baseSize * 2.5));

        const scale = Math.sqrt(Math.max(textLength, 1) / 60000);
        let chunkSize = Math.round(baseSize * Math.min(3, Math.max(0.7, scale)));

        chunkSize = Math.max(minSize, Math.min(maxSize, chunkSize));
        if (textLength < chunkSize * 1.5) {
            chunkSize = Math.max(minSize, Math.floor(textLength / 2));
        }
        if (chunkSize <= 0) {
            chunkSize = baseSize;
        }
        return chunkSize;
    }

    private chunkText(text: string): string[] {
        text = this.normalizeText(text);

        if (!text) return [];

        const chunkSize = this.chooseChunkSize(text.length);
        const overlap = Math.max(0, Math.min(this.settings.ragChunkOverlap, Math.floor(chunkSize / 3)));

        const chunks: string[] = [];
        let start = 0;

        while (start < text.length) {
            const end = Math.min(start + chunkSize, text.length);
            chunks.push(text.slice(start, end));

            if (end === text.length) break;
            start = end - overlap;
        }

        return chunks;
    }

    private makeChunkIds(sessionId: string, docKey: string, count: number): string[] {
        const keyHash = crypto.createHash("sha1").update(docKey).digest("hex");
        const prefix = sessionId.replace(/-/g, "").slice(0, 12);
        return Array.from({ length: count }, (_, i) => `${prefix}_${keyHash}_${i}`);
    }

    private async embedTexts(texts: string[]): Promise<number[][] | null> {
        if (!this.settings.openaiApiKey) {
            console.error("Missing OPENAI_API_KEY. Cannot embed PDF text.");
            return null;
        }

        let backoff = this.settings.initialBackoff * 1000;

        for (let attempt = 0; attempt <= this.settings.maxRetries; attempt++) {
            try {
                const response = await this.openai.embeddings.create({
                    model: this.settings.embeddingModel,
                    input: texts,
                });
                return response.data.map((item) => item.embedding);
            } catch (error) {
                if (attempt >= this.settings.maxRetries) {
                    console.error(`Embedding failed after retries: ${error}`);
                    return null;
                }
                await new Promise((r) => setTimeout(r, backoff));
                backoff = Math.min(backoff * 2, 30000);
            }
        }

        return null;
    }

    async addDocument(
        sessionId: string,
        docKey: string,
        text: string,
        metadata?: Record<string, string>
    ): Promise<{ status: "indexed" | "skipped" | "failed"; error?: string; reason?: string }> {
        if (!sessionId || !docKey || !text) {
            return { status: "skipped", reason: "missing_inputs" };
        }

        const chunks = this.chunkText(text);
        if (!chunks.length) {
            return { status: "skipped", reason: "no_text_chunks" };
        }

        const docHash = crypto.createHash("sha256").update(text).digest("hex");
        const baseMeta: Record<string, string> = {
            session_id: sessionId,
            doc_key: docKey,
            doc_hash: docHash,
            ...metadata,
        };

        const collection = await this.getCollection();
        if (!collection) {
            return { status: "failed", error: "Chroma server unavailable" };
        }

        const existing = await collection.get({
            where: this.whereAll({
                session_id: sessionId,
                doc_key: docKey,
                doc_hash: docHash,
            }),
            limit: 1,
        });

        if (existing.ids?.length) {
            console.log(`PDF already indexed for ${sessionId} (${docKey})`);
            return { status: "skipped", reason: "already_indexed" };
        }

        const embeddings: number[][] = [];
        const batchSize = 32;

        for (let i = 0; i < chunks.length; i += batchSize) {
            const batch = chunks.slice(i, i + batchSize);
            const batchEmbeddings = await this.embedTexts(batch);
            if (!batchEmbeddings) {
                return { status: "failed", error: "embedding_failed" };
            }
            embeddings.push(...batchEmbeddings);
        }

        const ids = this.makeChunkIds(sessionId, docKey, chunks.length);
        const metadatas = chunks.map((_, index) => ({
            ...baseMeta,
            chunk_index: String(index),
            total_chunks: String(chunks.length),
        }));

        try {
            await collection.delete({
                where: this.whereAll({ session_id: sessionId, doc_key: docKey }),
            });
        } catch {
        }

        await collection.upsert({
            ids,
            documents: chunks,
            metadatas,
            embeddings,
        });

        console.log(
            `Indexed ${chunks.length} PDF chunks for session ${sessionId} (${docKey})`
        );

        return { status: "indexed" };
    }

    async query(
        sessionId: string,
        queryText: string,
        topK?: number
    ): Promise<{ text: string; score: number | null; metadata: Record<string, unknown> }[]> {
        if (!sessionId || !queryText) return [];

        const k = topK || this.settings.ragTopK;
        const embeddings = await this.embedTexts([queryText]);
        if (!embeddings) return [];

        const collection = await this.getCollection();
        if (!collection) {
            return [];
        }

        const results = await collection.query({
            queryEmbeddings: embeddings,
            nResults: k,
            where: { session_id: sessionId },
            include: [IncludeEnum.Documents, IncludeEnum.Metadatas, IncludeEnum.Distances],
        });

        const matches: { text: string; score: number | null; metadata: Record<string, unknown> }[] = [];

        const docs = results.documents?.[0] || [];
        const metas = results.metadatas?.[0] || [];
        const distances = results.distances?.[0] || [];

        for (let i = 0; i < docs.length; i++) {
            const distance = distances[i];
            const score = distance !== undefined ? 1.0 - distance : null;
            matches.push({
                text: docs[i] || "",
                score,
                metadata: (metas[i] as Record<string, unknown>) || {},
            });
        }

        return matches;
    }

    async deleteSession(sessionId: string): Promise<void> {
        if (!sessionId) return;

        const collection = await this.getCollection();
        if (!collection) {
            return;
        }
        try {
            await collection.delete({ where: { session_id: sessionId } });
        } catch {
        }
        console.log(`Cleared PDF memory for session ${sessionId}`);
    }
}

export function getPdfMemoryStore(): PdfMemoryStore {
    if (!pdfMemoryStore) {
        pdfMemoryStore = new PdfMemoryStore();
    }
    return pdfMemoryStore;
}
