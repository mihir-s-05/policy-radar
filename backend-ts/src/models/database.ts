import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import * as sqliteVec from "sqlite-vec";
import { getSettings } from "../config.js";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
    if (!db) {
        const settings = getSettings();
        // Disable safeIntegers to ensure lastInsertRowid is always a number (not BigInt)
        // This is required for vec0 virtual table which expects INTEGER rowid values
        const dbOptions: Database.Options = { safeIntegers: false };
        console.log(`[DB] Initializing database at ${settings.databasePath} with options:`, JSON.stringify(dbOptions));
        db = new Database(settings.databasePath, dbOptions);
        db.pragma("journal_mode = WAL");
        
        // Verify the database configuration
        try {
            // Test insert to verify lastInsertRowid behavior
            db.exec(`CREATE TABLE IF NOT EXISTS _db_config_test (id INTEGER PRIMARY KEY AUTOINCREMENT, test TEXT)`);
            const testStmt = db.prepare(`INSERT INTO _db_config_test (test) VALUES (?)`);
            const testResult = testStmt.run("test");
            const testRowId = testResult.lastInsertRowid;
            console.log(`[DB] Database config test - lastInsertRowid: ${testRowId}, type: ${typeof testRowId}, isBigInt: ${typeof testRowId === 'bigint'}`);
            db.exec(`DROP TABLE IF EXISTS _db_config_test`);
            
            if (typeof testRowId === 'bigint') {
                console.warn(`[DB] WARNING: lastInsertRowid is still returning BigInt despite safeIntegers=false. This may cause vec0 insertion issues.`);
            }
        } catch (testError) {
            console.warn(`[DB] Could not verify database configuration:`, testError);
        }
        
        console.log(`[DB] Database initialized successfully`);
    }
    return db;
}

function assertSafeEmbeddingKey(key: string): string {
    const safe = String(key || "").trim();
    if (!safe) {
        throw new Error("Embedding key is required");
    }
    if (!/^[a-zA-Z0-9_]+$/.test(safe)) {
        throw new Error(`Invalid embedding key: ${safe}`);
    }
    return safe;
}

function getEmbeddingTableNames(embeddingKey: string): {
    metaTable: string;
    vecTable: string;
    idxSession: string;
    idxDocHash: string;
} {
    const key = assertSafeEmbeddingKey(embeddingKey);
    return {
        metaTable: `pdf_chunks_${key}`,
        vecTable: `vec_pdf_chunks_${key}`,
        idxSession: `idx_pdf_chunks_${key}_session`,
        idxDocHash: `idx_pdf_chunks_${key}_doc_hash`,
    };
}

export function listEmbeddingKeys(): string[] {
    const database = getDb();
    const rows = database
        .prepare(
            `
            SELECT name
            FROM sqlite_master
            WHERE type = 'table'
              AND name LIKE 'pdf_chunks_emb\\_%' ESCAPE '\\'
        `
        )
        .all() as Array<{ name: string }>;

    const keys = new Set<string>();
    for (const row of rows) {
        const name = String(row.name || "");
        if (!name.startsWith("pdf_chunks_")) continue;
        const key = name.slice("pdf_chunks_".length);
        if (key) keys.add(key);
    }
    return Array.from(keys);
}

export function initDb(): void {
    const database = getDb();

    database.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      previous_response_id TEXT,
      created_at TEXT NOT NULL
    )
  `);

    database.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
    )
  `);

    database.exec(`
    CREATE TABLE IF NOT EXISTS sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      message_id INTEGER,
      sources_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id),
      FOREIGN KEY (message_id) REFERENCES messages(id)
    )
  `);
}

export function createSession(): string {
    const sessionId = uuidv4();
    const createdAt = new Date().toISOString();

    const database = getDb();
    const stmt = database.prepare(
        "INSERT INTO sessions (session_id, previous_response_id, created_at) VALUES (?, ?, ?)"
    );
    stmt.run(sessionId, null, createdAt);

    return sessionId;
}

export interface SessionRow {
    session_id: string;
    previous_response_id: string | null;
    created_at: string;
}

export function getSessionById(sessionId: string): SessionRow | null {
    const database = getDb();
    const stmt = database.prepare(
        "SELECT session_id, previous_response_id, created_at FROM sessions WHERE session_id = ?"
    );
    const row = stmt.get(sessionId) as SessionRow | undefined;
    return row || null;
}

export function updateSessionResponseId(sessionId: string, responseId: string): void {
    const database = getDb();
    const stmt = database.prepare(
        "UPDATE sessions SET previous_response_id = ? WHERE session_id = ?"
    );
    stmt.run(responseId, sessionId);
}

export function deleteSession(sessionId: string): boolean {
    const database = getDb();

    database.prepare("DELETE FROM sources WHERE session_id = ?").run(sessionId);
    database.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
    const result = database.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId);

    return result.changes > 0;
}

export function addMessage(sessionId: string, role: string, content: string): number {
    const createdAt = new Date().toISOString();

    const database = getDb();
    const stmt = database.prepare(
        "INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)"
    );
    const result = stmt.run(sessionId, role, content, createdAt);

    return Number(result.lastInsertRowid);
}

export interface MessageRow {
    id: number;
    session_id: string;
    role: string;
    content: string;
    created_at: string;
}

export function getMessages(sessionId: string): MessageRow[] {
    const database = getDb();
    const stmt = database.prepare(
        "SELECT id, session_id, role, content, created_at FROM messages WHERE session_id = ? ORDER BY id"
    );
    return stmt.all(sessionId) as MessageRow[];
}

export function saveSources(sessionId: string, messageId: number, sourcesJson: string): void {
    const createdAt = new Date().toISOString();

    const database = getDb();
    const stmt = database.prepare(
        "INSERT INTO sources (session_id, message_id, sources_json, created_at) VALUES (?, ?, ?, ?)"
    );
    stmt.run(sessionId, messageId, sourcesJson, createdAt);
}

export function updateMessageContent(sessionId: string, messageId: number, content: string): boolean {
    const database = getDb();
    const stmt = database.prepare(
        "UPDATE messages SET content = ? WHERE session_id = ? AND id = ?"
    );
    const result = stmt.run(content, sessionId, messageId);
    return result.changes > 0;
}

export interface SessionListRow {
    session_id: string;
    created_at: string;
    last_message: string | null;
    last_message_at: string | null;
    title: string | null;
}

export function listSessions(limit: number = 50): SessionListRow[] {
    const database = getDb();
    const stmt = database.prepare(`
    SELECT
      s.session_id,
      s.created_at,
      (
        SELECT content
        FROM messages m
        WHERE m.session_id = s.session_id
        ORDER BY m.id DESC
        LIMIT 1
      ) AS last_message,
      (
        SELECT created_at
        FROM messages m
        WHERE m.session_id = s.session_id
        ORDER BY m.id DESC
        LIMIT 1
      ) AS last_message_at,
      (
        SELECT content
        FROM messages m
        WHERE m.session_id = s.session_id AND m.role = 'user'
        ORDER BY m.id ASC
        LIMIT 1
      ) AS title
    FROM sessions s
    ORDER BY COALESCE(last_message_at, s.created_at) DESC
    LIMIT ?
  `);
    return stmt.all(limit) as SessionListRow[];
}

export interface SourcesRow {
    message_id: number;
    sources_json: string;
}

export function getSources(sessionId: string): SourcesRow[] {
    const database = getDb();
    const stmt = database.prepare(
        "SELECT message_id, sources_json FROM sources WHERE session_id = ?"
    );
    return stmt.all(sessionId) as SourcesRow[];
}

// ============================================================================
// Vector Database Functions (sqlite-vec)
// ============================================================================

let vectorDbInitialized = false;
const vectorDbInitializedKeys = new Set<string>();

export function initVectorDb(embeddingKey: string, dimensions: number): void {
    const { metaTable, vecTable, idxSession, idxDocHash } = getEmbeddingTableNames(embeddingKey);
    if (vectorDbInitializedKeys.has(embeddingKey)) {
        return;
    }
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
        throw new Error(`Invalid embedding dimensions: ${dimensions}`);
    }

    const database = getDb();

    // Load sqlite-vec extension
    sqliteVec.load(database);

    // Create metadata table for PDF chunks
    database.exec(`
        CREATE TABLE IF NOT EXISTS ${metaTable} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            doc_key TEXT NOT NULL,
            doc_hash TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,
            total_chunks INTEGER NOT NULL,
            content TEXT NOT NULL,
            source_url TEXT,
            source_type TEXT,
            pdf_url TEXT,
            created_at TEXT NOT NULL,
            UNIQUE(session_id, doc_key, chunk_index)
        )
    `);

    database.exec(`
        CREATE INDEX IF NOT EXISTS ${idxSession}
        ON ${metaTable}(session_id)
    `);

    database.exec(`
        CREATE INDEX IF NOT EXISTS ${idxDocHash}
        ON ${metaTable}(session_id, doc_key, doc_hash)
    `);

    // Create vector virtual table with cosine distance
    // Note: vec0 uses rowid as implicit primary key, not a custom column
    // Dimensions must match the selected local embedding model.
    database.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS ${vecTable} USING vec0(
            embedding float[${dimensions}] distance_metric=cosine
        )
    `);

    vectorDbInitialized = true;
    vectorDbInitializedKeys.add(embeddingKey);
    console.log(`Vector database initialized with sqlite-vec (${embeddingKey}, dim=${dimensions})`);
}

export interface PdfChunkMetadata {
    source_url?: string;
    source_type?: string;
    pdf_url?: string;
}

export function insertPdfChunk(
    embeddingKey: string,
    sessionId: string,
    docKey: string,
    docHash: string,
    chunkIndex: number,
    totalChunks: number,
    content: string,
    embedding: Float32Array,
    metadata: PdfChunkMetadata
): number {
    const { metaTable, vecTable } = getEmbeddingTableNames(embeddingKey);
    const database = getDb();
    const createdAt = new Date().toISOString();

    // Insert metadata and get the rowid
    const metaStmt = database.prepare(`
        INSERT INTO ${metaTable}
        (session_id, doc_key, doc_hash, chunk_index, total_chunks, content,
         source_url, source_type, pdf_url, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = metaStmt.run(
        sessionId,
        docKey,
        docHash,
        chunkIndex,
        totalChunks,
        content,
        metadata.source_url || null,
        metadata.source_type || null,
        metadata.pdf_url || null,
        createdAt
    );

    // Get the rowid from the insert result
    // With safeIntegers: false, lastInsertRowid is always a number
    const rawRowId = result.lastInsertRowid;
    console.log(`[DB] Metadata insert result - raw lastInsertRowid: ${rawRowId}, type: ${typeof rawRowId}, isBigInt: ${typeof rawRowId === 'bigint'}`);
    
    // Ensure we have a proper integer - use Math.floor to guarantee integer type
    // vec0 virtual table requires rowid to be INTEGER, not just a number
    const chunkId = Math.floor(Number(rawRowId));
    console.log(`[DB] Converted chunkId: ${chunkId}, type: ${typeof chunkId}, isSafeInteger: ${Number.isSafeInteger(chunkId)}, isInteger: ${Number.isInteger(chunkId)}`);
    
    // Ensure it's a valid positive integer
    if (!Number.isSafeInteger(chunkId) || chunkId <= 0) {
        const errorMsg = `Invalid chunk ID: ${chunkId} (type: ${typeof chunkId}, raw: ${rawRowId}, rawType: ${typeof rawRowId})`;
        console.error(`[DB] ${errorMsg}`);
        throw new Error(errorMsg);
    }

    // Insert embedding with same ID (vec0 uses rowid as primary key)
    // Note: vec0 requires rowid to be explicitly INTEGER type
    // better-sqlite3 binds JavaScript numbers, but vec0 is strict about INTEGER type
    // Solution: Use SQL CAST and ensure the value is a whole integer number
    try {
        console.log(`[DB] Attempting to insert into ${vecTable} with rowid=${chunkId} (type: ${typeof chunkId}), embedding length=${embedding.length}`);
        
        // Ensure chunkId is a whole integer (not a float)
        const integerRowId = Math.trunc(chunkId);
        if (integerRowId !== chunkId) {
            throw new Error(`chunkId must be a whole integer, got: ${chunkId}`);
        }
        
        // Use CAST to ensure SQLite treats it as INTEGER
        // Note: better-sqlite3 may bind numbers as REAL, so CAST is essential
        const vecStmt = database.prepare(`
            INSERT INTO ${vecTable} (rowid, embedding) VALUES (CAST(? AS INTEGER), ?)
        `);
        
        // Log the actual parameter types being bound
        console.log(`[DB] Binding parameters - rowid: ${integerRowId} (${typeof integerRowId}), embedding: Float32Array(${embedding.length})`);
        // Bind the integer value
        vecStmt.run(integerRowId, embedding);
        console.log(`[DB] Successfully inserted chunk ${integerRowId} into ${vecTable}`);
    } catch (error) {
        const errorDetails = {
            error: String(error),
            errorType: error instanceof Error ? error.constructor.name : typeof error,
            chunkId,
            chunkIdType: typeof chunkId,
            rawRowId,
            rawRowIdType: typeof rawRowId,
            vecTable,
            embeddingLength: embedding.length,
            isSafeInteger: Number.isSafeInteger(chunkId),
            isInteger: Number.isInteger(chunkId),
        };
        console.error(`[DB] Failed to insert into ${vecTable}:`, JSON.stringify(errorDetails, null, 2));
        throw error;
    }

    return chunkId;
}

export function checkDocumentExists(
    embeddingKey: string,
    sessionId: string,
    docKey: string,
    docHash: string
): boolean {
    const { metaTable } = getEmbeddingTableNames(embeddingKey);
    const database = getDb();
    const stmt = database.prepare(`
        SELECT 1 FROM ${metaTable}
        WHERE session_id = ? AND doc_key = ? AND doc_hash = ?
        LIMIT 1
    `);
    const row = stmt.get(sessionId, docKey, docHash);
    return row !== undefined;
}

export function deleteDocumentChunks(embeddingKey: string, sessionId: string, docKey: string): void {
    const { metaTable, vecTable } = getEmbeddingTableNames(embeddingKey);
    const database = getDb();

    // Get chunk IDs to delete from vector table
    const idsStmt = database.prepare(`
        SELECT id FROM ${metaTable} WHERE session_id = ? AND doc_key = ?
    `);
    const ids = idsStmt.all(sessionId, docKey) as { id: number }[];

    if (ids.length > 0) {
        // Delete from vector table (vec0 uses rowid)
        const deleteVecStmt = database.prepare(`
            DELETE FROM ${vecTable} WHERE rowid = ?
        `);
        for (const { id } of ids) {
            deleteVecStmt.run(id);
        }

        // Delete from metadata table
        database.prepare(`
            DELETE FROM ${metaTable} WHERE session_id = ? AND doc_key = ?
        `).run(sessionId, docKey);
    }
}

export function deleteSessionChunks(embeddingKey: string, sessionId: string): void {
    const { metaTable, vecTable } = getEmbeddingTableNames(embeddingKey);
    const database = getDb();

    // Get all chunk IDs for this session
    const idsStmt = database.prepare(`
        SELECT id FROM ${metaTable} WHERE session_id = ?
    `);
    const ids = idsStmt.all(sessionId) as { id: number }[];

    if (ids.length > 0) {
        // Delete from vector table (vec0 uses rowid)
        const deleteVecStmt = database.prepare(`
            DELETE FROM ${vecTable} WHERE rowid = ?
        `);
        for (const { id } of ids) {
            deleteVecStmt.run(id);
        }
    }

    // Delete from metadata table
    database.prepare(`
        DELETE FROM ${metaTable} WHERE session_id = ?
    `).run(sessionId);
}

export interface VectorSearchResult {
    chunkId: number;
    distance: number;
}

export function searchVectorsBySession(
    embeddingKey: string,
    sessionId: string,
    queryEmbedding: Float32Array,
    topK: number
): VectorSearchResult[] {
    const { metaTable, vecTable } = getEmbeddingTableNames(embeddingKey);
    const database = getDb();

    // Get chunk IDs for this session
    const sessionChunksStmt = database.prepare(`
        SELECT id FROM ${metaTable} WHERE session_id = ?
    `);
    const sessionChunkIds = sessionChunksStmt.all(sessionId) as { id: number }[];

    if (sessionChunkIds.length === 0) {
        return [];
    }

    // Build set of valid IDs for filtering
    const idSet = new Set(sessionChunkIds.map((r) => r.id));

    // Query vectors - request more results than needed since we'll filter by session
    const overFetch = Math.min(topK * 10, 500);
    const searchStmt = database.prepare(`
        SELECT rowid, distance
        FROM ${vecTable}
        WHERE embedding MATCH ?
        AND k = ?
    `);

    const rawResults = searchStmt.all(queryEmbedding, overFetch) as { rowid: number; distance: number }[];

    // Map to expected interface and filter to only session chunks
    return rawResults
        .map((r) => ({ chunkId: r.rowid, distance: r.distance }))
        .filter((r) => idSet.has(r.chunkId))
        .slice(0, topK);
}

export interface ChunkWithMetadata {
    id: number;
    session_id: string;
    doc_key: string;
    doc_hash: string;
    chunk_index: number;
    total_chunks: number;
    content: string;
    source_url: string | null;
    source_type: string | null;
    pdf_url: string | null;
    created_at: string;
}

export function getChunksByIds(embeddingKey: string, ids: number[]): ChunkWithMetadata[] {
    if (ids.length === 0) return [];

    const { metaTable } = getEmbeddingTableNames(embeddingKey);
    const database = getDb();
    const placeholders = ids.map(() => "?").join(",");
    const stmt = database.prepare(`
        SELECT * FROM ${metaTable} WHERE id IN (${placeholders})
    `);
    return stmt.all(...ids) as ChunkWithMetadata[];
}
