import sqlite3
import uuid
from datetime import datetime
from typing import Optional
from contextlib import contextmanager

DATABASE_PATH = "policy_radar.db"


def get_db_connection():
    conn = sqlite3.connect(DATABASE_PATH)
    conn.row_factory = sqlite3.Row
    return conn


@contextmanager
def db_session():
    conn = get_db_connection()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db():
    with db_session() as conn:
        cursor = conn.cursor()

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                session_id TEXT PRIMARY KEY,
                previous_response_id TEXT,
                created_at TEXT NOT NULL
            )
        """)

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions(session_id)
            )
        """)

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS sources (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                message_id INTEGER,
                sources_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions(session_id),
                FOREIGN KEY (message_id) REFERENCES messages(id)
            )
        """)


def create_session() -> str:
    session_id = str(uuid.uuid4())
    created_at = datetime.utcnow().isoformat()

    with db_session() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO sessions (session_id, previous_response_id, created_at) VALUES (?, ?, ?)",
            (session_id, None, created_at),
        )

    return session_id


def get_session_by_id(session_id: str) -> Optional[dict]:
    with db_session() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT session_id, previous_response_id, created_at FROM sessions WHERE session_id = ?",
            (session_id,),
        )
        row = cursor.fetchone()

        if row:
            return {
                "session_id": row["session_id"],
                "previous_response_id": row["previous_response_id"],
                "created_at": row["created_at"],
            }
        return None


def update_session_response_id(session_id: str, response_id: str):
    with db_session() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE sessions SET previous_response_id = ? WHERE session_id = ?",
            (response_id, session_id),
        )


def delete_session(session_id: str) -> bool:
    with db_session() as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM sources WHERE session_id = ?", (session_id,))
        cursor.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
        cursor.execute("DELETE FROM sessions WHERE session_id = ?", (session_id,))
        return cursor.rowcount > 0


def add_message(session_id: str, role: str, content: str) -> int:
    created_at = datetime.utcnow().isoformat()

    with db_session() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)",
            (session_id, role, content, created_at),
        )
        return cursor.lastrowid


def get_messages(session_id: str) -> list[dict]:
    with db_session() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, session_id, role, content, created_at FROM messages WHERE session_id = ? ORDER BY id",
            (session_id,),
        )
        rows = cursor.fetchall()

        return [
            {
                "id": row["id"],
                "session_id": row["session_id"],
                "role": row["role"],
                "content": row["content"],
                "created_at": row["created_at"],
            }
            for row in rows
        ]


def save_sources(session_id: str, message_id: int, sources_json: str):
    created_at = datetime.utcnow().isoformat()

    with db_session() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO sources (session_id, message_id, sources_json, created_at) VALUES (?, ?, ?, ?)",
            (session_id, message_id, sources_json, created_at),
        )


def update_message_content(session_id: str, message_id: int, content: str) -> bool:
    with db_session() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE messages SET content = ? WHERE session_id = ? AND id = ?",
            (content, session_id, message_id),
        )
        return cursor.rowcount > 0


def list_sessions(limit: int = 50) -> list[dict]:
    with db_session() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
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
            """,
            (limit,),
        )
        rows = cursor.fetchall()

        return [
            {
                "session_id": row["session_id"],
                "created_at": row["created_at"],
                "last_message": row["last_message"],
                "last_message_at": row["last_message_at"],
                "title": row["title"],
            }
            for row in rows
        ]


def get_sources(session_id: str) -> list[dict]:
    with db_session() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT message_id, sources_json FROM sources WHERE session_id = ?",
            (session_id,),
        )
        rows = cursor.fetchall()

        return [
            {
                "message_id": row["message_id"],
                "sources_json": row["sources_json"],
            }
            for row in rows
        ]
