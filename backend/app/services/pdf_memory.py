import asyncio
import hashlib
import logging
import os
import re
from typing import Optional

import chromadb
import httpx
from chromadb.config import Settings as ChromaSettings
from openai import OpenAI

from ..config import get_settings
from ..models.schemas import EmbeddingConfig

logger = logging.getLogger(__name__)

class DisabledPdfMemoryStore:
    def __init__(self) -> None:
        self.settings = get_settings()
        self.enabled = False

    async def add_document(
        self,
        session_id: str,
        doc_key: str,
        text: str,
        metadata: Optional[dict] = None,
        embedding_config: Optional[EmbeddingConfig] = None,
    ) -> None:
        return

    async def query(
        self,
        session_id: str,
        query_text: str,
        top_k: Optional[int] = None,
        embedding_config: Optional[EmbeddingConfig] = None,
    ) -> list[dict]:
        return []

    async def delete_session(self, session_id: str) -> None:
        return


class PdfMemoryStore:
    def __init__(self):
        self.settings = get_settings()
        persist_dir = os.path.abspath(self.settings.rag_persist_dir)
        os.makedirs(persist_dir, exist_ok=True)
        self._client = chromadb.PersistentClient(
            path=persist_dir,
            settings=ChromaSettings(anonymized_telemetry=False),
        )
        self._collection_base = self.settings.rag_collection
        self._collections: dict[str, object] = {}
        self._openai = OpenAI(api_key=self.settings.openai_api_key)
        self._openai_clients: dict[tuple[str, str], OpenAI] = {}
        self._local_models: dict[str, object] = {}
        self._local_model_lock = asyncio.Lock()
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

    def _collection_name_for(self, config: EmbeddingConfig) -> str:
        base = self._collection_base
        provider = (config.provider or "local").lower()
        model = (config.model or "default").lower()
        slug = re.sub(r"[^a-z0-9_-]+", "-", f"{provider}-{model}").strip("-")
        digest = hashlib.sha1(f"{provider}:{model}".encode("utf-8")).hexdigest()[:8]
        name = f"{base}-{slug}-{digest}"
        return name[:120]

    def _get_collection(self, config: EmbeddingConfig):
        name = self._collection_name_for(config)
        collection = self._collections.get(name)
        if collection is not None:
            return collection
        collection = self._client.get_or_create_collection(
            name=name,
            metadata={
                "hnsw:space": "cosine",
                "embedding_provider": config.provider,
                "embedding_model": config.model,
            },
        )
        self._collections[name] = collection
        return collection

    def _reset_collection(self, config: EmbeddingConfig) -> None:
        name = self._collection_name_for(config)
        try:
            self._client.delete_collection(name)
        except Exception:
            pass
        self._collections.pop(name, None)

    def _resolve_embedding_config(
        self,
        config: Optional[EmbeddingConfig],
    ) -> EmbeddingConfig:
        if config:
            provider = config.provider
            model = config.model or self.settings.embedding_model
            api_key = config.api_key
            base_url = config.base_url
        else:
            provider = self.settings.embedding_provider
            model = self.settings.embedding_model
            api_key = None
            base_url = None

        if provider == "openai":
            api_key = api_key or self.settings.openai_api_key
            base_url = base_url or self.settings.openai_base_url
        elif provider == "huggingface":
            api_key = api_key or self.settings.huggingface_api_key
            base_url = base_url or self.settings.huggingface_base_url

        return EmbeddingConfig(
            provider=provider,
            model=model,
            api_key=api_key,
            base_url=base_url,
        )

    def _get_openai_client(self, api_key: str, base_url: Optional[str]) -> OpenAI:
        key = (api_key or "", base_url or "")
        existing = self._openai_clients.get(key)
        if existing:
            return existing
        if base_url:
            client = OpenAI(api_key=api_key, base_url=base_url)
        else:
            client = OpenAI(api_key=api_key)
        self._openai_clients[key] = client
        return client

    def _embed_openai_sync(
        self,
        texts: list[str],
        model: str,
        api_key: str,
        base_url: Optional[str],
    ) -> list[list[float]]:
        if not api_key:
            return []
        client = self._get_openai_client(api_key, base_url)
        response = client.embeddings.create(model=model, input=texts)
        return [item.embedding for item in response.data]

    def _embed_local_sync(self, texts: list[str], model_name: str) -> list[list[float]]:
        try:
            from sentence_transformers import SentenceTransformer
        except Exception as exc:
            logger.error("sentence-transformers not installed: %s", exc)
            return []

        model = self._local_models.get(model_name)
        if model is None:
            model = SentenceTransformer(model_name)
            self._local_models[model_name] = model

        embeddings = model.encode(
            texts,
            show_progress_bar=False,
            normalize_embeddings=True,
        )
        try:
            return embeddings.tolist()
        except Exception:
            return [list(item) for item in embeddings]

    def _mean_pool(self, tokens: list[list[float]]) -> list[float]:
        if not tokens:
            return []
        dim = len(tokens[0])
        sums = [0.0] * dim
        count = 0
        for token in tokens:
            if len(token) != dim:
                continue
            for idx, value in enumerate(token):
                sums[idx] += float(value)
            count += 1
        if count == 0:
            return []
        return [value / count for value in sums]

    def _build_huggingface_url(self, base_url: Optional[str], model: str) -> str:
        if not base_url:
            return f"https://api-inference.huggingface.co/pipeline/feature-extraction/{model}"
        if "{model}" in base_url:
            return base_url.format(model=model)
        trimmed = base_url.rstrip("/")
        if trimmed.endswith("/pipeline/feature-extraction"):
            return f"{trimmed}/{model}"
        return base_url

    async def _embed_huggingface(
        self,
        texts: list[str],
        model: str,
        api_key: Optional[str],
        base_url: Optional[str],
    ) -> list[list[float]]:
        url = self._build_huggingface_url(base_url, model)
        headers = {}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        payload = {
            "inputs": texts if len(texts) > 1 else texts[0],
            "options": {"wait_for_model": True},
        }

        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(url, headers=headers, json=payload)
            response.raise_for_status()
            data = response.json()

        if isinstance(data, dict) and data.get("error"):
            logger.error("Hugging Face embedding error: %s", data.get("error"))
            return []

        if isinstance(data, list) and data:
            first = data[0]
            if isinstance(first, list) and first and isinstance(first[0], (int, float)):
                return [self._mean_pool(data)]
            if (
                isinstance(first, list)
                and first
                and isinstance(first[0], list)
                and first[0]
            ):
                return [self._mean_pool(item) for item in data]
            if isinstance(first, (int, float)):
                return [data]

        logger.error("Unexpected Hugging Face embedding response format.")
        return []

    async def _embed_texts(
        self,
        texts: list[str],
        embedding_config: Optional[EmbeddingConfig] = None,
    ) -> list[list[float]]:
        config = self._resolve_embedding_config(embedding_config)

        if config.provider == "openai":
            if not config.api_key:
                logger.error("Missing OpenAI API key. Cannot embed PDF text.")
                return []
            embed_call = lambda: self._embed_openai_sync(
                texts,
                config.model,
                config.api_key or "",
                config.base_url,
            )
        elif config.provider == "huggingface":
            if not config.api_key and "api-inference.huggingface.co" in (config.base_url or ""):
                logger.error("Missing Hugging Face API key. Cannot embed PDF text.")
                return []

            async def embed_call_async() -> list[list[float]]:
                return await self._embed_huggingface(
                    texts,
                    config.model,
                    config.api_key,
                    config.base_url,
                )

            embed_call = embed_call_async
        else:
            async def embed_call_async() -> list[list[float]]:
                async with self._local_model_lock:
                    return await asyncio.to_thread(
                        self._embed_local_sync,
                        texts,
                        config.model,
                    )

            embed_call = embed_call_async

        backoff = self.settings.initial_backoff
        for attempt in range(self.settings.max_retries + 1):
            try:
                if asyncio.iscoroutinefunction(embed_call):
                    return await embed_call()
                return await asyncio.to_thread(embed_call)
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
        embedding_config: Optional[EmbeddingConfig] = None,
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

        resolved_config = self._resolve_embedding_config(embedding_config)
        collection = self._get_collection(resolved_config)

        existing = collection.get(
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
            batch_embeddings = await self._embed_texts(
                batch,
                embedding_config=embedding_config,
            )
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
            try:
                collection.delete(
                    where=self._where_all(
                        session_id=session_id,
                        doc_key=doc_key,
                    )
                )
                collection.upsert(
                    ids=ids,
                    documents=chunks,
                    metadatas=metadatas,
                    embeddings=embeddings,
                )
            except Exception as exc:
                if "dimension" in str(exc).lower():
                    logger.warning(
                        "Embedding dimension mismatch detected; recreating collection for %s.",
                        resolved_config.model,
                    )
                    self._reset_collection(resolved_config)
                    collection = self._get_collection(resolved_config)
                    collection.upsert(
                        ids=ids,
                        documents=chunks,
                        metadatas=metadatas,
                        embeddings=embeddings,
                    )
                else:
                    raise

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
        embedding_config: Optional[EmbeddingConfig] = None,
    ) -> list[dict]:
        if not session_id or not query_text:
            return []

        top_k = top_k or self.settings.rag_top_k
        embeddings = await self._embed_texts(
            [query_text],
            embedding_config=embedding_config,
        )
        if not embeddings:
            return []

        resolved_config = self._resolve_embedding_config(embedding_config)
        collection = self._get_collection(resolved_config)
        results = collection.query(
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
            collections = []
            try:
                collections = list(self._client.list_collections())
            except Exception:
                collections = list(self._collections.values())

            for collection in collections:
                try:
                    collection.delete(where={"session_id": session_id})
                except Exception:
                    continue
        logger.info("Cleared PDF memory for session %s", session_id)


_PDF_MEMORY_STORE: Optional[PdfMemoryStore] = None


def get_pdf_memory_store():
    global _PDF_MEMORY_STORE
    if _PDF_MEMORY_STORE is None:
        try:
            _PDF_MEMORY_STORE = PdfMemoryStore()
        except Exception as exc:
            logger.exception("Failed to initialize PDF memory store; disabling PDF memory: %s", exc)
            _PDF_MEMORY_STORE = DisabledPdfMemoryStore()
    return _PDF_MEMORY_STORE
