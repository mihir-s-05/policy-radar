import { ChromaClient, Collection, IncludeEnum } from "chromadb";
import OpenAI from "openai";
import crypto from "crypto";
import { getSettings } from "../config.js";

let pdfMemoryStore: PdfMemoryStore | null = null;

export class PdfMemoryStore {
    private settings = getSettings();
    private client: ChromaClient;
    private collection: Collection | null = null;
    private openai: OpenAI;

    constructor() {
        this.client = new ChromaClient({
            path: this.settings.ragPersistDir,
        });
        this.openai = new OpenAI({ apiKey: this.settings.openaiApiKey });
        console.log(`PDF memory store initialized at ${this.settings.ragPersistDir}`);
    }

    private async getCollection(): Promise<Collection> {
        if (!this.collection) {
            this.collection = await this.client.getOrCreateCollection({
                name: this.settings.ragCollection,
                metadata: { "hnsw:space": "cosine" },
            });
        }
        return this.collection;
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

    private chunkText(text: string): string[] {
        const chunkSize = Math.max(200, this.settings.ragChunkSize);
        const overlap = Math.max(0, Math.min(this.settings.ragChunkOverlap, chunkSize / 2));
        text = this.normalizeText(text);

        if (!text) return [];

        const chunks: string[] = [];
        let start = 0;

        while (start < text.length) {
            const end = Math.min(start + chunkSize, text.length);
            chunks.push(text.slice(start, end));

            if (end === text.length) break;
            start = end - overlap;

            if (this.settings.ragMaxChunks > 0 && chunks.length >= this.settings.ragMaxChunks) {
                console.warn(
                    `RAG chunk limit reached (${this.settings.ragMaxChunks}). Remaining text was not indexed.`
                );
                break;
            }
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
    ): Promise<void> {
        if (!sessionId || !docKey || !text) return;

        const chunks = this.chunkText(text);
        if (!chunks.length) return;

        const docHash = crypto.createHash("sha256").update(text).digest("hex");
        const baseMeta: Record<string, string> = {
            session_id: sessionId,
            doc_key: docKey,
            doc_hash: docHash,
            ...metadata,
        };

        const collection = await this.getCollection();

        // Check if already indexed
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
            return;
        }

        // Embed in batches
        const embeddings: number[][] = [];
        const batchSize = 32;

        for (let i = 0; i < chunks.length; i += batchSize) {
            const batch = chunks.slice(i, i + batchSize);
            const batchEmbeddings = await this.embedTexts(batch);
            if (!batchEmbeddings) return;
            embeddings.push(...batchEmbeddings);
        }

        const ids = this.makeChunkIds(sessionId, docKey, chunks.length);
        const metadatas = chunks.map((_, index) => ({
            ...baseMeta,
            chunk_index: String(index),
            total_chunks: String(chunks.length),
        }));

        // Delete old versions first
        try {
            await collection.delete({
                where: this.whereAll({ session_id: sessionId, doc_key: docKey }),
            });
        } catch {
            // Ignore errors
        }

        await collection.upsert({
            ids,
            documents: chunks,
            metadatas,
            embeddings,
        });

        console.log(`Indexed ${chunks.length} PDF chunks for session ${sessionId} (${docKey})`);
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
        try {
            await collection.delete({ where: { session_id: sessionId } });
        } catch {
            // Ignore errors
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
