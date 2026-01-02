import os
import sqlite3
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Optional

import aiosqlite

from ..config import get_settings


def _resolve_database_path() -> str:
    override = os.getenv("DATABASE_PATH")
    if override:
        return override

    settings = get_settings()
    url = settings.database_url
    if url.startswith("sqlite+aiosqlite:///"):
        return url.replace("sqlite+aiosqlite:///", "", 1)
    if url.startswith("sqlite:///"):
        return url.replace("sqlite:///", "", 1)
    return "policy_radar.db"


DATABASE_PATH = _resolve_database_path()


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


@asynccontextmanager
async def db_session():
    conn = await aiosqlite.connect(DATABASE_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        await conn.commit()
    except Exception:
        await conn.rollback()
        raise
    finally:
        await conn.close()


async def init_db() -> None:
    async with db_session() as conn:
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                session_id TEXT PRIMARY KEY,
                previous_response_id TEXT,
                created_at TEXT NOT NULL
            )
            """
        )

        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions(session_id)
            )
            """
        )

        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS sources (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                message_id INTEGER,
                sources_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions(session_id),
                FOREIGN KEY (message_id) REFERENCES messages(id)
            )
            """
        )


async def create_session() -> str:
    session_id = str(uuid.uuid4())
    created_at = _utc_now_iso()

    async with db_session() as conn:
        await conn.execute(
            "INSERT INTO sessions (session_id, previous_response_id, created_at) VALUES (?, ?, ?)",
            (session_id, None, created_at),
        )

    return session_id


async def get_session_by_id(session_id: str) -> Optional[dict]:
    async with db_session() as conn:
        async with conn.execute(
            "SELECT session_id, previous_response_id, created_at FROM sessions WHERE session_id = ?",
            (session_id,),
        ) as cursor:
            row = await cursor.fetchone()

        if row:
            return {
                "session_id": row["session_id"],
                "previous_response_id": row["previous_response_id"],
                "created_at": row["created_at"],
            }
        return None


async def update_session_response_id(session_id: str, response_id: str) -> None:
    async with db_session() as conn:
        await conn.execute(
            "UPDATE sessions SET previous_response_id = ? WHERE session_id = ?",
            (response_id, session_id),
        )


async def delete_session(session_id: str) -> bool:
    async with db_session() as conn:
        await conn.execute("DELETE FROM sources WHERE session_id = ?", (session_id,))
        await conn.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
        cursor = await conn.execute("DELETE FROM sessions WHERE session_id = ?", (session_id,))
        return cursor.rowcount > 0


async def add_message(session_id: str, role: str, content: str) -> int:
    created_at = _utc_now_iso()

    async with db_session() as conn:
        cursor = await conn.execute(
            "INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)",
            (session_id, role, content, created_at),
        )
        return cursor.lastrowid


async def get_messages(session_id: str) -> list[dict]:
    async with db_session() as conn:
        async with conn.execute(
            "SELECT id, session_id, role, content, created_at FROM messages WHERE session_id = ? ORDER BY id",
            (session_id,),
        ) as cursor:
            rows = await cursor.fetchall()

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


async def save_sources(session_id: str, message_id: int, sources_json: str) -> None:
    created_at = _utc_now_iso()

    async with db_session() as conn:
        await conn.execute(
            "INSERT INTO sources (session_id, message_id, sources_json, created_at) VALUES (?, ?, ?, ?)",
            (session_id, message_id, sources_json, created_at),
        )


async def update_message_content(session_id: str, message_id: int, content: str) -> bool:
    async with db_session() as conn:
        cursor = await conn.execute(
            "UPDATE messages SET content = ? WHERE session_id = ? AND id = ?",
            (content, session_id, message_id),
        )
        return cursor.rowcount > 0


async def list_sessions(limit: int = 50) -> list[dict]:
    async with db_session() as conn:
        async with conn.execute(
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
        ) as cursor:
            rows = await cursor.fetchall()

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


async def get_sources(session_id: str) -> list[dict]:
    async with db_session() as conn:
        async with conn.execute(
            "SELECT message_id, sources_json FROM sources WHERE session_id = ?",
            (session_id,),
        ) as cursor:
            rows = await cursor.fetchall()

        return [
            {
                "message_id": row["message_id"],
                "sources_json": row["sources_json"],
            }
            for row in rows
        ]
