import json
import os
from functools import lru_cache
from pydantic_settings import BaseSettings


def _get_bool_env(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


class Settings(BaseSettings):
    gov_api_key: str = os.getenv("GOV_API_KEY", "")
    openai_api_key: str = os.getenv("OPENAI_API_KEY", "")
    anthropic_api_key: str = os.getenv("ANTHROPIC_API_KEY", "")
    google_api_key: str = os.getenv("GOOGLE_API_KEY", "")

    openai_model: str = os.getenv("OPENAI_MODEL", "gpt-5.2")
    embedding_provider: str = os.getenv("EMBEDDING_PROVIDER", "local")
    embedding_model: str = os.getenv(
        "EMBEDDING_MODEL",
        "sentence-transformers/all-MiniLM-L6-v2",
    )
    huggingface_api_key: str = os.getenv("HUGGINGFACE_API_KEY", "")
    huggingface_base_url: str = os.getenv(
        "HUGGINGFACE_BASE_URL",
        "https://api-inference.huggingface.co/pipeline/feature-extraction",
    )
    port: int = int(os.getenv("PORT", "8000"))

    llm_provider: str = os.getenv("LLM_PROVIDER", "openai")
    available_models: list[str] = ["gpt-5.2", "gpt-5-mini", "gpt-5.1", "o3"]
    default_api_mode: str = os.getenv("DEFAULT_API_MODE", "responses")

    openai_base_url: str = "https://api.openai.com/v1"
    anthropic_base_url: str = "https://api.anthropic.com/v1"
    gemini_base_url: str = "https://generativelanguage.googleapis.com/v1beta/openai/"

    anthropic_models: list[str] = [
        "claude-opus-4-5-20251101",
        "claude-sonnet-4-5-20250929",
        "claude-haiku-4-5-20251001",
    ]
    gemini_models: list[str] = [
        "gemini-3-pro",
        "gemini-3-flash-preview",
    ]

    local_embedding_models: list[str] = [
        "sentence-transformers/all-MiniLM-L6-v2",
        "BAAI/bge-small-en-v1.5",
    ]
    openai_embedding_models: list[str] = [
        "text-embedding-3-small",
        "text-embedding-3-large",
    ]
    huggingface_embedding_models: list[str] = [
        "sentence-transformers/all-MiniLM-L6-v2",
        "BAAI/bge-small-en-v1.5",
    ]

    regulations_base_url: str = "https://api.regulations.gov/v4"
    govinfo_base_url: str = "https://api.govinfo.gov"

    congress_base_url: str = "https://api.congress.gov/v3"
    federal_register_base_url: str = "https://www.federalregister.gov/api/v1"
    usaspending_base_url: str = "https://api.usaspending.gov/api/v2"
    fiscal_data_base_url: str = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service"
    datagov_base_url: str = "https://api.gsa.gov/technology/datagov/v3/action"
    doj_base_url: str = "https://www.justice.gov/api/v1"

    searchgov_affiliate: str = os.getenv("SEARCHGOV_AFFILIATE", "")
    searchgov_access_key: str = os.getenv("SEARCHGOV_ACCESS_KEY", "")
    searchgov_base_url: str = "https://api.gsa.gov/technology/searchgov/v2"

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

    app_api_key: str = os.getenv("APP_API_KEY", "")
    rate_limit_per_minute: int = int(os.getenv("RATE_LIMIT_PER_MINUTE", "60"))

    fetch_allowed_domains_raw: str = os.getenv("FETCH_ALLOWED_DOMAINS", ".gov,.mil")
    allow_local_fetch: bool = _get_bool_env("ALLOW_LOCAL_FETCH", False)
    fetch_max_response_bytes: int = int(os.getenv("FETCH_MAX_RESPONSE_BYTES", "10000000"))
    pdf_extract_images: bool = _get_bool_env("PDF_EXTRACT_IMAGES", False)

    @property
    def fetch_allowed_domains(self) -> list[str]:
        value = self.fetch_allowed_domains_raw
        if value is None or value == "":
            return []
        if isinstance(value, str):
            try:
                parsed = json.loads(value)
                if isinstance(parsed, list):
                    return [str(item).strip() for item in parsed if str(item).strip()]
            except Exception:
                pass
            return [part.strip() for part in value.split(",") if part.strip()]
        if isinstance(value, (list, tuple, set)):
            return [str(item).strip() for item in value if str(item).strip()]
        return []

    class Config:
        env_file = ".env"
        extra = "ignore"


@lru_cache()
def get_settings() -> Settings:
    return Settings()
