import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.security import reset_rate_limiter
from app.main import app
from app.clients.web_fetcher import WebFetcher


def _reset_settings(monkeypatch, **env):
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    get_settings.cache_clear()
    reset_rate_limiter()


def test_health_no_auth(monkeypatch):
    _reset_settings(monkeypatch, APP_API_KEY="", RATE_LIMIT_PER_MINUTE="0")

    with TestClient(app) as client:
        response = client.get("/api/health")
        assert response.status_code == 200
        assert response.json().get("status") == "healthy"


def test_auth_enforced(monkeypatch):
    _reset_settings(monkeypatch, APP_API_KEY="test-key", RATE_LIMIT_PER_MINUTE="0")

    with TestClient(app) as client:
        unauthorized = client.get("/api/health")
        assert unauthorized.status_code == 401

        authorized = client.get("/api/health", headers={"X-API-Key": "test-key"})
        assert authorized.status_code == 200


def test_rate_limiting(monkeypatch):
    _reset_settings(monkeypatch, APP_API_KEY="", RATE_LIMIT_PER_MINUTE="2")

    with TestClient(app) as client:
        assert client.get("/api/health").status_code == 200
        assert client.get("/api/health").status_code == 200
        limited = client.get("/api/health")
        assert limited.status_code == 429


@pytest.mark.asyncio
async def test_fetch_url_blocks_private(monkeypatch):
    _reset_settings(monkeypatch, ALLOW_LOCAL_FETCH="false", FETCH_ALLOWED_DOMAINS=".gov")
    fetcher = WebFetcher()
    result = await fetcher.fetch_url("http://127.0.0.1")
    assert result.get("error")
