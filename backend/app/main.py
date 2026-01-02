import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api import router
from .models.database import init_db
from .config import get_settings
from .clients.base import BaseAPIClient
from .clients.web_fetcher import WebFetcher
from .clients.govinfo import GovInfoClient

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting Policy Radar Chatbot API...")

    settings = get_settings()
    if not settings.gov_api_key:
        logger.warning("GOV_API_KEY environment variable is not set. Some sources will be unavailable.")
    if not settings.openai_api_key:
        logger.warning("OPENAI_API_KEY environment variable is not set. OpenAI provider will be unavailable.")

    await init_db()
    logger.info("Database initialized")

    logger.info(f"Using OpenAI model: {settings.openai_model}")
    logger.info("API ready!")

    yield

    logger.info("Shutting down Policy Radar Chatbot API...")
    await BaseAPIClient.close_shared_clients()
    await WebFetcher.close_shared_clients()
    await GovInfoClient.close_shared_clients()


app = FastAPI(
    title="Policy Radar Chatbot API",
    description="A chatbot for exploring U.S. federal regulatory activity",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://localhost:3000",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)


@app.get("/")
async def root():
    return {
        "name": "Policy Radar Chatbot API",
        "version": "1.0.0",
        "docs": "/docs",
    }


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8000"))
    uvicorn.run("app.main:app", host="0.0.0.0", port=port, reload=True)
