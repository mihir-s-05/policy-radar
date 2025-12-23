import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import { getSettings } from "../config.js";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
    if (!db) {
        const settings = getSettings();
        db = new Database(settings.databasePath);
        db.pragma("journal_mode = WAL");
    }
    return db;
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
