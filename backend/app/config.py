import os
from functools import lru_cache
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    gov_api_key: str = os.getenv("GOV_API_KEY", "")
    openai_api_key: str = os.getenv("OPENAI_API_KEY", "")

    openai_model: str = os.getenv("OPENAI_MODEL", "gpt-5.2")
    embedding_model: str = os.getenv("EMBEDDING_MODEL", "text-embedding-3-small")
    port: int = int(os.getenv("PORT", "8000"))

    llm_provider: str = os.getenv("LLM_PROVIDER", "openai")
    available_models: list[str] = ["gpt-5.2", "gpt-5.1", "gpt-5", "o3", "gpt-5-mini"]

    regulations_base_url: str = "https://api.regulations.gov/v4"
    govinfo_base_url: str = "https://api.govinfo.gov"

    database_url: str = "sqlite+aiosqlite:///./policy_radar.db"

    cache_ttl: int = 600

    max_retries: int = 3
    initial_backoff: float = 1.0

    rag_collection: str = os.getenv("RAG_COLLECTION", "pdf_memory")
    rag_persist_dir: str = os.getenv("RAG_PERSIST_DIR", "./chroma")
    rag_chunk_size: int = int(os.getenv("RAG_CHUNK_SIZE", "1200"))
    rag_chunk_overlap: int = int(os.getenv("RAG_CHUNK_OVERLAP", "200"))
    rag_max_chunks: int = int(os.getenv("RAG_MAX_CHUNKS", "500"))
    rag_top_k: int = int(os.getenv("RAG_TOP_K", "5"))

    class Config:
        env_file = ".env"
        extra = "ignore"


@lru_cache()
def get_settings() -> Settings:
    return Settings()
