"""Hosted billing and ownership boundaries; no network or model calls."""
import json
import sqlite3

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app
from app.models import database
from app.security import reset_rate_limiter
from app.api import routes


A = {"X-Session-Token": "a" * 64}
B = {"X-Session-Token": "b" * 64}


@pytest.fixture
def public_client(monkeypatch, tmp_path):
    monkeypatch.setattr(database, "DATABASE_PATH", str(tmp_path / "test.db"))
    for name, value in {
        "PUBLIC_MODE": "true", "APP_API_KEY": "", "RATE_LIMIT_PER_MINUTE": "0",
        "OPENAI_API_KEY": "host-secret-must-never-be-used",
        "ANTHROPIC_API_KEY": "host-secret-must-never-be-used",
        "GOOGLE_API_KEY": "host-secret-must-never-be-used",
        "HUGGINGFACE_API_KEY": "host-secret-must-never-be-used",
    }.items():
        monkeypatch.setenv(name, value)
    get_settings.cache_clear()
    reset_rate_limiter()

    async def no_network(*args, **kwargs):
        raise AssertionError("Test attempted an external request")
    monkeypatch.setattr(httpx.AsyncClient, "request", no_network)
    with TestClient(app) as client:
        yield client
    get_settings.cache_clear()
    reset_rate_limiter()


def session(client, headers=A):
    response = client.post("/api/session", headers=headers)
    assert response.status_code == 200
    return response.json()["session_id"]


def test_host_credentials_are_ignored(public_client):
    settings = get_settings()
    assert not any([settings.openai_api_key, settings.anthropic_api_key,
                    settings.google_api_key, settings.huggingface_api_key])
    config = public_client.get("/api/config")
    assert config.status_code == 200
    data = config.json()
    assert data["public_mode"]
    assert "openai_oauth" not in data["providers"]
    assert all(not provider["api_key_detected"] for provider in data["providers"].values())
    assert data["model"] == "gpt-6.1-sol"
    assert data["providers"]["anthropic"]["models"] == ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]
    assert data["providers"]["gemini"]["models"] == ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.1-pro-preview"]


@pytest.mark.parametrize("provider", ["openai", "anthropic", "gemini"])
@pytest.mark.parametrize("endpoint", ["/api/chat", "/api/chat/stream"])
def test_missing_key_rejected_before_work(public_client, provider, endpoint):
    sid = session(public_client)
    response = public_client.post(endpoint, headers=A, json={"session_id": sid, "message": "Synthetic test", "provider": provider})
    assert response.status_code == 400
    assert public_client.get(f"/api/sessions/{sid}/messages", headers=A).json()["messages"] == []
    response = public_client.post("/api/validate-model", json={"provider": provider, "model_name": "synthetic"})
    assert response.status_code == 400


@pytest.mark.parametrize("provider", ["openai", "huggingface"])
@pytest.mark.parametrize("endpoint", ["/api/chat", "/api/chat/stream"])
def test_paid_embeddings_need_visitor_key(public_client, endpoint, provider):
    sid = session(public_client)
    response = public_client.post(endpoint, headers=A, json={
        "session_id": sid, "message": "Synthetic test", "api_key": "visitor-key",
        "embedding_config": {"provider": provider, "model": "synthetic-embedding-model"},
    })
    assert response.status_code == 400


def test_legacy_local_sessions_stay_private(public_client):
    with sqlite3.connect(database.DATABASE_PATH) as conn:
        conn.execute("INSERT INTO sessions(session_id, created_at) VALUES ('legacy-private', '2026-01-01T00:00:00Z')")
    assert public_client.get("/api/sessions", headers=A).json()["sessions"] == []
    assert public_client.get("/api/sessions/legacy-private/messages", headers=A).status_code == 404


def test_session_boundaries(public_client):
    sid = session(public_client)
    other = session(public_client, B)
    assert [item["session_id"] for item in public_client.get("/api/sessions", headers=A).json()["sessions"]] == [sid]
    assert [item["session_id"] for item in public_client.get("/api/sessions", headers=B).json()["sessions"]] == [other]
    assert public_client.get("/api/sessions").status_code == 401
    assert public_client.get(f"/api/sessions/{sid}/messages", headers=B).status_code == 404
    assert public_client.delete(f"/api/sessions/{sid}", headers=B).status_code == 404
    assert public_client.patch(f"/api/sessions/{sid}/messages/1", headers=B, json={"content": "Synthetic edit"}).status_code == 404
    for endpoint in ["/api/chat", "/api/chat/stream"]:
        assert public_client.post(endpoint, headers=B, json={"session_id": sid, "message": "Synthetic test", "api_key": "visitor-key"}).status_code == 404


@pytest.mark.parametrize("provider", ["openai", "anthropic", "gemini"])
@pytest.mark.parametrize("endpoint", ["/api/chat", "/api/chat/stream"])
def test_visitor_key_reaches_provider(public_client, monkeypatch, provider, endpoint):
    keys = []

    class FakeService:
        def __init__(self, **kwargs):
            keys.append(kwargs["api_key"])

        async def chat(self, **kwargs):
            return "Synthetic response", [], None, [], "synthetic-response-id", "synthetic-model"

        chat_completions = chat

        async def chat_stream(self, **kwargs):
            yield {"event": "done", "data": {"answer_text": "Synthetic response", "sources": [], "response_id": "synthetic-response-id"}}

        chat_completions_stream = chat_stream

    monkeypatch.setattr(routes, "OpenAIService", FakeService)
    monkeypatch.setattr(routes, "GeminiService", FakeService)
    sid = session(public_client)
    response = public_client.post(endpoint, headers=A, json={"session_id": sid, "message": "Synthetic test", "provider": provider, "api_key": "visitor-key"})
    assert response.status_code == 200
    assert "Synthetic response" in response.text
    assert keys == ["visitor-key"]
    with sqlite3.connect(database.DATABASE_PATH) as conn:
        stored = json.dumps(conn.execute("SELECT content FROM messages").fetchall())
    assert "visitor-key" not in stored
    assert "host-secret" not in stored


def test_shared_oauth_and_custom_endpoints_disabled(public_client):
    for path in ["start", "status"]:
        assert public_client.get(f"/api/oauth/openai/{path}").status_code == 403
    assert public_client.post("/api/validate-model", json={"provider": "custom", "model_name": "synthetic", "api_key": "visitor-key", "base_url": "http://127.0.0.1"}).status_code == 400
