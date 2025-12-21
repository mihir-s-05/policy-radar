import os
from functools import lru_cache
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    gov_api_key: str = os.getenv("GOV_API_KEY", "")
    openai_api_key: str = os.getenv("OPENAI_API_KEY", "")

    openai_model: str = os.getenv("OPENAI_MODEL", "gpt-5.2")
    port: int = int(os.getenv("PORT", "8000"))

    regulations_base_url: str = "https://api.regulations.gov/v4"
    govinfo_base_url: str = "https://api.govinfo.gov"

    database_url: str = "sqlite+aiosqlite:///./policy_radar.db"

    cache_ttl: int = 600

    max_retries: int = 3
    initial_backoff: float = 1.0

    class Config:
        env_file = ".env"
        extra = "ignore"


@lru_cache()
def get_settings() -> Settings:
    return Settings()
