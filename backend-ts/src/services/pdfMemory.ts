import crypto from "crypto";
import { getSettings } from "../config.js";
import {
    initVectorDb,
    insertPdfChunk,
    checkDocumentExists,
    deleteDocumentChunks,
    deleteSessionChunks,
    searchVectorsBySession,
    getChunksByIds,
    listEmbeddingKeys,
} from "../models/database.js";
import { embedTexts, type EmbeddingProvider } from "./embeddings.js";

let pdfMemoryStore: PdfMemoryStore | null = null;

export class PdfMemoryStore {
    private settings = getSettings();

    constructor() {
        console.log("PDF memory store initialized with sqlite-vec (local embeddings)");
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
        const overlap = Math.max(
            0,
            Math.min(this.settings.ragChunkOverlap, Math.floor(chunkSize / 3))
        );

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

    private async embedTexts(
        texts: string[],
        embeddingConfig?: { provider?: EmbeddingProvider | null; model?: string | null; apiKey?: string | null; baseUrl?: string | null } | null
    ): Promise<{ embeddingKey: string; vectors: Float32Array[] } | null> {
        try {
            const provider = (embeddingConfig?.provider || (this.settings.embeddingProvider as EmbeddingProvider) || "local") as EmbeddingProvider;
            const model = String(embeddingConfig?.model || this.settings.embeddingModel || "").trim();
            const apiKey = embeddingConfig?.apiKey ?? null;
            const baseUrl = embeddingConfig?.baseUrl ?? null;

            const embedded = await embedTexts(texts, { provider, model, apiKey, baseUrl });
            if (embedded?.vectors?.length) {
                initVectorDb(embedded.embeddingKey, embedded.vectors[0].length);
            }
            return embedded;
        } catch (error) {
            console.error(`Embedding failed: ${error}`);
            return null;
        }
    }

    async addDocument(
        sessionId: string,
        docKey: string,
        text: string,
        metadata?: Record<string, string>,
        embeddingConfig?: { provider?: EmbeddingProvider | null; model?: string | null; apiKey?: string | null; baseUrl?: string | null } | null
    ): Promise<{
        status: "indexed" | "skipped" | "failed";
        error?: string;
        reason?: string;
    }> {
        if (!sessionId || !docKey || !text) {
            return { status: "skipped", reason: "missing_inputs" };
        }

        const chunks = this.chunkText(text);
        if (!chunks.length) {
            return { status: "skipped", reason: "no_text_chunks" };
        }

        const docHash = crypto.createHash("sha256").update(text).digest("hex");

        // Check for existing document with same hash (deduplication)
        try {
            const embedded = await this.embedTexts([chunks[0]], embeddingConfig);
            if (!embedded) {
                return { status: "failed", error: "embedding_failed" };
            }
            const embeddingKey = embedded.embeddingKey;

            if (checkDocumentExists(embeddingKey, sessionId, docKey, docHash)) {
                console.log(`PDF already indexed for ${sessionId} (${docKey})`);
                return { status: "skipped", reason: "already_indexed" };
            }
        } catch (error) {
            return { status: "failed", error: String(error) };
        }

        // Generate embeddings in batches
        const embeddings: Float32Array[] = [];
        let embeddingKey: string | null = null;
        const batchSize = 16; // Smaller batch for local model

        for (let i = 0; i < chunks.length; i += batchSize) {
            const batch = chunks.slice(i, i + batchSize);
            const embedded = await this.embedTexts(batch, embeddingConfig);
            if (!embedded) {
                return { status: "failed", error: "embedding_failed" };
            }
            embeddingKey = embeddingKey || embedded.embeddingKey;
            embeddings.push(...embedded.vectors);
        }

        if (!embeddingKey) {
            return { status: "failed", error: "embedding_failed" };
        }

        // Delete any existing chunks for this doc_key (handles updates)
        try {
            deleteDocumentChunks(embeddingKey, sessionId, docKey);
        } catch {
            // Ignore deletion errors
        }

        // Insert all chunks
        try {
            const chunkMetadata = {
                source_url: metadata?.source_url,
                source_type: metadata?.source_type,
                pdf_url: metadata?.pdf_url,
            };

            console.log(`[PDF Memory] Inserting ${chunks.length} chunks for docKey: ${docKey}, sessionId: ${sessionId}, embeddingKey: ${embeddingKey}`);
            
            for (let i = 0; i < chunks.length; i++) {
                try {
                    console.log(`[PDF Memory] Inserting chunk ${i + 1}/${chunks.length} for ${docKey}`);
                    const chunkId = insertPdfChunk(
                        embeddingKey,
                        sessionId,
                        docKey,
                        docHash,
                        i,
                        chunks.length,
                        chunks[i],
                        embeddings[i],
                        chunkMetadata
                    );
                    console.log(`[PDF Memory] Successfully inserted chunk ${i + 1}/${chunks.length} with ID ${chunkId}`);
                } catch (chunkError) {
                    const errorDetails = {
                        chunkIndex: i,
                        totalChunks: chunks.length,
                        docKey,
                        sessionId,
                        error: String(chunkError),
                        errorType: chunkError instanceof Error ? chunkError.constructor.name : typeof chunkError,
                        stack: chunkError instanceof Error ? chunkError.stack : undefined,
                    };
                    console.error(`[PDF Memory] Failed to insert chunk ${i + 1}/${chunks.length}:`, JSON.stringify(errorDetails, null, 2));
                    throw chunkError; // Re-throw to be caught by outer catch
                }
            }

            console.log(
                `[PDF Memory] Successfully indexed ${chunks.length} PDF chunks for session ${sessionId} (${docKey})`
            );
            return { status: "indexed" };
        } catch (error) {
            const errorDetails = {
                docKey,
                sessionId,
                chunksCount: chunks.length,
                error: String(error),
                errorType: error instanceof Error ? error.constructor.name : typeof error,
                stack: error instanceof Error ? error.stack : undefined,
            };
            console.error(`[PDF Memory] Failed to index PDF chunks:`, JSON.stringify(errorDetails, null, 2));
            return { status: "failed", error: String(error) };
        }
    }

    async query(
        sessionId: string,
        queryText: string,
        topK?: number,
        embeddingConfig?: { provider?: EmbeddingProvider | null; model?: string | null; apiKey?: string | null; baseUrl?: string | null } | null
    ): Promise<
        { text: string; score: number | null; metadata: Record<string, unknown> }[]
    > {
        if (!sessionId || !queryText) return [];

        const k = topK || this.settings.ragTopK;
        const embedded = await this.embedTexts([queryText], embeddingConfig);
        if (!embedded || embedded.vectors.length === 0) return [];

        try {
            // Search vectors
            const vectorResults = searchVectorsBySession(
                embedded.embeddingKey,
                sessionId,
                embedded.vectors[0],
                k
            );

            if (vectorResults.length === 0) return [];

            // Fetch metadata for matched chunks
            const chunkIds = vectorResults.map((r) => r.chunkId);
            const chunks = getChunksByIds(embedded.embeddingKey, chunkIds);
            const chunkMap = new Map(chunks.map((c) => [c.id, c]));

            // Build results with scores
            // Cosine distance is in [0, 2], convert to similarity score
            // Score = 1 - distance (matching ChromaDB's behavior)
            return vectorResults.map((r) => {
                const chunk = chunkMap.get(r.chunkId);
                const score = 1.0 - r.distance;
                return {
                    text: chunk?.content || "",
                    score,
                    metadata: {
                        session_id: chunk?.session_id,
                        doc_key: chunk?.doc_key,
                        doc_hash: chunk?.doc_hash,
                        chunk_index: String(chunk?.chunk_index),
                        total_chunks: String(chunk?.total_chunks),
                        source_url: chunk?.source_url || "",
                        source_type: chunk?.source_type || "",
                        pdf_url: chunk?.pdf_url || "",
                    },
                };
            });
        } catch (error) {
            console.error(`Vector search failed: ${error}`);
            return [];
        }
    }

    async deleteSession(sessionId: string): Promise<void> {
        if (!sessionId) return;

        try {
            const keys = listEmbeddingKeys();
            for (const key of keys) {
                try {
                    deleteSessionChunks(key, sessionId);
                } catch {
                    // Best-effort cleanup
                }
            }
            console.log(`Cleared PDF memory for session ${sessionId}`);
        } catch (error) {
            console.error(`Failed to delete session chunks: ${error}`);
        }
    }
}

export function getPdfMemoryStore(): PdfMemoryStore {
    if (!pdfMemoryStore) {
        pdfMemoryStore = new PdfMemoryStore();
    }
    return pdfMemoryStore;
}
