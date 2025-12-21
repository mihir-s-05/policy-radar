import asyncio
import hashlib
import logging
import os
import re
from typing import Optional

import chromadb
from chromadb.config import Settings as ChromaSettings
from openai import OpenAI

from ..config import get_settings

logger = logging.getLogger(__name__)


class PdfMemoryStore:
    def __init__(self):
        self.settings = get_settings()
        persist_dir = os.path.abspath(self.settings.rag_persist_dir)
        os.makedirs(persist_dir, exist_ok=True)
        self._client = chromadb.PersistentClient(
            path=persist_dir,
            settings=ChromaSettings(anonymized_telemetry=False),
        )
        self._collection = self._client.get_or_create_collection(
            name=self.settings.rag_collection,
            metadata={"hnsw:space": "cosine"},
        )
        self._openai = OpenAI(api_key=self.settings.openai_api_key)
        self._lock = asyncio.Lock()
        logger.info("PDF memory store initialized at %s", persist_dir)

    def _where_all(self, **filters: str) -> dict:
        parts = [{key: value} for key, value in filters.items() if value is not None]
        if not parts:
            return {}
        if len(parts) == 1:
            return parts[0]
        return {"$and": parts}

    def _normalize_text(self, text: str) -> str:
        text = text.replace("\r\n", "\n").replace("\r", "\n")
        text = re.sub(r"[ \t]+", " ", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text.strip()

    def _chunk_text(self, text: str) -> list[str]:
        chunk_size = max(200, self.settings.rag_chunk_size)
        overlap = max(0, min(self.settings.rag_chunk_overlap, chunk_size // 2))
        text = self._normalize_text(text)
        if not text:
            return []

        chunks = []
        start = 0
        while start < len(text):
            end = min(start + chunk_size, len(text))
            chunks.append(text[start:end])
            if end == len(text):
                break
            start = end - overlap

            if self.settings.rag_max_chunks > 0 and len(chunks) >= self.settings.rag_max_chunks:
                break

        if self.settings.rag_max_chunks > 0 and len(chunks) >= self.settings.rag_max_chunks:
            logger.warning(
                "RAG chunk limit reached (%s). Remaining text was not indexed.",
                self.settings.rag_max_chunks,
            )

        return chunks

    def _make_chunk_ids(self, session_id: str, doc_key: str, count: int) -> list[str]:
        key_hash = hashlib.sha1(doc_key.encode("utf-8")).hexdigest()
        prefix = session_id.replace("-", "")[:12]
        return [f"{prefix}_{key_hash}_{i}" for i in range(count)]

    def _embed_texts_sync(self, texts: list[str]) -> list[list[float]]:
        response = self._openai.embeddings.create(
            model=self.settings.embedding_model,
            input=texts,
        )
        return [item.embedding for item in response.data]

    async def _embed_texts(self, texts: list[str]) -> list[list[float]]:
        if not self.settings.openai_api_key:
            logger.error("Missing OPENAI_API_KEY. Cannot embed PDF text.")
            return []

        backoff = self.settings.initial_backoff
        for attempt in range(self.settings.max_retries + 1):
            try:
                return await asyncio.to_thread(self._embed_texts_sync, texts)
            except Exception as exc:
                if attempt >= self.settings.max_retries:
                    logger.error("Embedding failed after retries: %s", exc)
                    return []
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30.0)

        return []

    async def add_document(
        self,
        session_id: str,
        doc_key: str,
        text: str,
        metadata: Optional[dict] = None,
    ) -> None:
        if not session_id or not doc_key or not text:
            return

        chunks = self._chunk_text(text)
        if not chunks:
            return

        doc_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
        base_meta = {
            "session_id": session_id,
            "doc_key": doc_key,
            "doc_hash": doc_hash,
        }
        if metadata:
            base_meta.update(metadata)

        existing = self._collection.get(
            where=self._where_all(
                session_id=session_id,
                doc_key=doc_key,
                doc_hash=doc_hash,
            ),
            limit=1,
        )
        if existing and existing.get("ids"):
            logger.info("PDF already indexed for %s (%s)", session_id, doc_key)
            return

        embeddings = []
        batch_size = 32
        for i in range(0, len(chunks), batch_size):
            batch = chunks[i:i + batch_size]
            batch_embeddings = await self._embed_texts(batch)
            if not batch_embeddings:
                return
            embeddings.extend(batch_embeddings)

        ids = self._make_chunk_ids(session_id, doc_key, len(chunks))
        metadatas = []
        for index in range(len(chunks)):
            item_meta = dict(base_meta)
            item_meta["chunk_index"] = index
            item_meta["total_chunks"] = len(chunks)
            metadatas.append(item_meta)

        async with self._lock:
            self._collection.delete(
                where=self._where_all(
                    session_id=session_id,
                    doc_key=doc_key,
                )
            )
            self._collection.upsert(
                ids=ids,
                documents=chunks,
                metadatas=metadatas,
                embeddings=embeddings,
            )

        logger.info(
            "Indexed %s PDF chunks for session %s (%s)",
            len(chunks),
            session_id,
            doc_key,
        )

    async def query(
        self,
        session_id: str,
        query_text: str,
        top_k: Optional[int] = None,
    ) -> list[dict]:
        if not session_id or not query_text:
            return []

        top_k = top_k or self.settings.rag_top_k
        embeddings = await self._embed_texts([query_text])
        if not embeddings:
            return []

        results = self._collection.query(
            query_embeddings=embeddings,
            n_results=top_k,
            where={"session_id": session_id},
            include=["documents", "metadatas", "distances"],
        )

        matches = []
        for doc, meta, distance in zip(
            results.get("documents", [[]])[0],
            results.get("metadatas", [[]])[0],
            results.get("distances", [[]])[0],
        ):
            score = None
            if distance is not None:
                score = 1.0 - float(distance)
            matches.append(
                {
                    "text": doc,
                    "score": score,
                    "metadata": meta,
                }
            )

        return matches

    async def delete_session(self, session_id: str) -> None:
        if not session_id:
            return
        async with self._lock:
            self._collection.delete(where={"session_id": session_id})
        logger.info("Cleared PDF memory for session %s", session_id)


_PDF_MEMORY_STORE: Optional[PdfMemoryStore] = None


def get_pdf_memory_store() -> PdfMemoryStore:
    global _PDF_MEMORY_STORE
    if _PDF_MEMORY_STORE is None:
        _PDF_MEMORY_STORE = PdfMemoryStore()
    return _PDF_MEMORY_STORE
