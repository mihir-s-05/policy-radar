import json
import logging
import asyncio
from fastapi import APIRouter, HTTPException, Query
from sse_starlette.sse import EventSourceResponse

from ..models.schemas import (
    ChatRequest,
    ChatResponse,
    SessionResponse,
    SessionListResponse,
    DeleteSessionResponse,
    MessagesResponse,
    FetchContentRequest,
    FetchContentResponse,
    UpdateMessageRequest,
    UpdateMessageResponse,
    ConfigResponse,
    ProviderInfo,
    ValidateModelRequest,
    ValidateModelResponse,
    EmbeddingProviderInfo,
    StopChatRequest,
    StopChatResponse,
)
from ..models.database import (
    create_session,
    get_session_by_id,
    update_session_response_id,
    delete_session,
    add_message,
    get_messages,
    save_sources,
    list_sessions,
    get_sources,
    update_message_content,
)
from ..services.openai_service import OpenAIService
from ..services.pdf_memory import get_pdf_memory_store
from ..services.chat_cancellation import get_chat_cancellation_manager
from ..clients.base import RateLimitError, APIError
from ..clients.web_fetcher import WebFetcher
from ..config import get_settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api")


@router.post("/session", response_model=SessionResponse)
async def create_new_session():
    try:
        session_id = create_session()
        logger.info(f"Created new session: {session_id}")
        return SessionResponse(session_id=session_id)
    except Exception as e:
        logger.exception("Error creating session")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/config", response_model=ConfigResponse)
async def get_config():
    settings = get_settings()
    providers = {
        "openai": ProviderInfo(
            name="openai",
            display_name="OpenAI",
            base_url=settings.openai_base_url,
            models=settings.available_models,
            api_key_detected=bool(settings.openai_api_key),
            api_mode="responses",
        ),
        "anthropic": ProviderInfo(
            name="anthropic",
            display_name="Anthropic",
            base_url=settings.anthropic_base_url,
            models=settings.anthropic_models,
            api_key_detected=bool(settings.anthropic_api_key),
            api_mode="chat_completions",
        ),
        "gemini": ProviderInfo(
            name="gemini",
            display_name="Google Gemini",
            base_url=settings.gemini_base_url,
            models=settings.gemini_models,
            api_key_detected=bool(settings.google_api_key),
            api_mode="chat_completions",
        ),
    }
    embedding_providers = {
        "local": EmbeddingProviderInfo(
            name="local",
            display_name="Local",
            models=settings.local_embedding_models,
            api_key_detected=True,
        ),
        "openai": EmbeddingProviderInfo(
            name="openai",
            display_name="OpenAI",
            base_url=settings.openai_base_url,
            models=settings.openai_embedding_models,
            api_key_detected=bool(settings.openai_api_key),
        ),
        "huggingface": EmbeddingProviderInfo(
            name="huggingface",
            display_name="Hugging Face",
            base_url=settings.huggingface_base_url,
            models=settings.huggingface_embedding_models,
            api_key_detected=bool(settings.huggingface_api_key),
        ),
    }
    return ConfigResponse(
        model=settings.openai_model,
        available_models=settings.available_models,
        default_api_mode=settings.default_api_mode,
        providers=providers,
        embedding_provider=settings.embedding_provider,
        embedding_model=settings.embedding_model,
        embedding_providers=embedding_providers,
    )


@router.post("/validate-model", response_model=ValidateModelResponse)
async def validate_model(request: ValidateModelRequest):
    import httpx

    settings = get_settings()

    provider = request.provider
    model_name = request.model_name

    api_key = request.api_key
    base_url = request.base_url

    if provider == "openai":
        api_key = api_key or settings.openai_api_key
        base_url = "https://api.openai.com/v1"
        if not api_key:
            return ValidateModelResponse(valid=False, message="OpenAI API key missing")

        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    f"{base_url}/models",
                    headers={"Authorization": f"Bearer {api_key}"}
                )
                if response.status_code != 200:
                    return ValidateModelResponse(valid=False, message=f"OpenAI API Error: {response.status_code}")

                models_data = response.json()
                model_ids = [m["id"] for m in models_data.get("data", [])]

                if model_name in model_ids:
                    return ValidateModelResponse(valid=True, message=f"Model '{model_name}' found.")
                else:
                    return ValidateModelResponse(valid=False, message=f"Model '{model_name}' not found in OpenAI list.")
        except Exception as e:
            return ValidateModelResponse(valid=False, message=f"Connection failed: {str(e)}")

    elif provider == "anthropic":
        api_key = api_key or settings.anthropic_api_key
        base_url = "https://api.anthropic.com/v1"
        if not api_key:
             return ValidateModelResponse(valid=False, message="Anthropic API key missing")

        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    f"{base_url}/models",
                    headers={
                        "x-api-key": api_key,
                        "anthropic-version": "2023-06-01"
                    }
                )
                if response.status_code != 200:
                    return ValidateModelResponse(valid=False, message=f"Anthropic API Error: {response.status_code}")

                models_data = response.json()
                model_ids = [m["id"] for m in models_data.get("data", [])]

                if model_name in model_ids:
                    return ValidateModelResponse(valid=True, message=f"Model '{model_name}' found.")

                return ValidateModelResponse(valid=False, message=f"Model '{model_name}' not found in Anthropic list.")
        except Exception as e:
             return ValidateModelResponse(valid=False, message=f"Connection failed: {str(e)}")

    elif provider == "gemini":
        api_key = api_key or settings.google_api_key
        base_url = "https://generativelanguage.googleapis.com/v1beta"
        if not api_key:
             return ValidateModelResponse(valid=False, message="Gemini API key missing")

        try:
            full_model_name = f"models/{model_name}" if not model_name.startswith("models/") else model_name
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    f"{base_url}/models?key={api_key}"
                )
                if response.status_code != 200:
                     return ValidateModelResponse(valid=False, message=f"Gemini API Error: {response.status_code}")

                data = response.json()
                models = data.get("models", [])

                found = False
                for m in models:
                    if m["name"] == full_model_name or m["name"] == model_name:
                        found = True
                        break
                    if m["name"].endswith(f"/{model_name}"):
                        found = True
                        break

                if found:
                    return ValidateModelResponse(valid=True, message=f"Model '{model_name}' found.")
                else:
                    return ValidateModelResponse(valid=False, message=f"Model '{model_name}' not found in Gemini list.")

        except Exception as e:
             return ValidateModelResponse(valid=False, message=f"Connection failed: {str(e)}")

    elif provider == "custom":
        if not base_url:
            return ValidateModelResponse(valid=False, message="Base URL required for custom provider")

        try:
            headers = {}
            if api_key:
                headers["Authorization"] = f"Bearer {api_key}"

            async with httpx.AsyncClient() as client:
                response = await client.get(
                    f"{base_url.rstrip('/')}/models",
                    headers=headers,
                    timeout=5.0
                )

                if response.status_code == 200:
                    data = response.json()
                    if "data" in data and isinstance(data["data"], list):
                        ids = [m.get("id") for m in data["data"]]
                        if model_name in ids:
                             return ValidateModelResponse(valid=True, message=f"Model '{model_name}' found via compatible list.")
                        else:
                             return ValidateModelResponse(valid=False, message=f"Model '{model_name}' not found in custom list.")
                    else:
                        return ValidateModelResponse(valid=False, message="Could not parse models list from custom endpoint.")
                else:
                     return ValidateModelResponse(valid=False, message=f"Custom endpoint returned {response.status_code}")

        except Exception as e:
             return ValidateModelResponse(valid=False, message=f"Connection failed: {str(e)}")

    return ValidateModelResponse(valid=False, message="Unknown provider")


@router.get("/sessions", response_model=SessionListResponse)
async def list_chat_sessions(limit: int = Query(default=50, ge=1, le=200)):
    try:
        sessions = list_sessions(limit=limit)
        return SessionListResponse(sessions=sessions)
    except Exception as e:
        logger.exception("Error listing sessions")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/sessions/{session_id}", response_model=DeleteSessionResponse)
async def delete_chat_session(session_id: str):
    session = get_session_by_id(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    try:
        pdf_memory = get_pdf_memory_store()
        try:
            await pdf_memory.delete_session(session_id)
        except Exception as e:
            logger.warning("Failed to clear PDF memory for session %s: %s", session_id, e)
        delete_session(session_id)
        return DeleteSessionResponse(session_id=session_id, deleted=True)
    except Exception as e:
        logger.exception("Error deleting session")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/sessions/{session_id}/messages", response_model=MessagesResponse)
async def get_session_messages(session_id: str):
    session = get_session_by_id(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    try:
        messages = get_messages(session_id)
        sources_rows = get_sources(session_id)
        sources_by_message_id = {
            row["message_id"]: json.loads(row["sources_json"])
            for row in sources_rows
        }

        payload = []
        for message in messages:
            message_id = message["id"]
            payload.append(
                {
                    "id": message_id,
                    "role": message["role"],
                    "content": message["content"],
                    "created_at": message["created_at"],
                    "sources": sources_by_message_id.get(message_id),
                }
            )

        return MessagesResponse(session_id=session_id, messages=payload)
    except Exception as e:
        logger.exception("Error fetching messages")
        raise HTTPException(status_code=500, detail=str(e))


@router.patch(
    "/sessions/{session_id}/messages/{message_id}",
    response_model=UpdateMessageResponse,
)
async def update_message(session_id: str, message_id: int, request: UpdateMessageRequest):
    session = get_session_by_id(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    updated = update_message_content(session_id, message_id, request.content)
    if not updated:
        raise HTTPException(status_code=404, detail="Message not found")

    return UpdateMessageResponse(updated=True)


@router.post("/content/fetch", response_model=FetchContentResponse)
async def fetch_content(request: FetchContentRequest):
    try:
        fetcher = WebFetcher()
        max_length = None if request.full_text else request.max_length
        data = await fetcher.fetch_url(url=request.url, max_length=max_length)
        return FetchContentResponse(
            url=data.get("url"),
            title=data.get("title"),
            full_text=data.get("text"),
            error=data.get("error"),
        )
    except Exception as e:
        logger.exception("Error fetching content")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    session = get_session_by_id(request.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    cancel_manager = get_chat_cancellation_manager()
    cancel_event = None
    if request.request_id:
        cancel_event = await cancel_manager.register(request.request_id)

    try:
        add_message(request.session_id, "user", request.message)

        settings = get_settings()

        base_url = None
        api_key = request.api_key
        model_override = request.model
        provider = request.provider or "openai"
        
        if provider == "anthropic":
            base_url = settings.anthropic_base_url
            api_key = api_key or settings.anthropic_api_key
            api_mode = "chat_completions"
        elif provider == "gemini":
            base_url = settings.gemini_base_url
            api_key = api_key or settings.google_api_key
            api_mode = "chat_completions"
        elif provider == "custom" and request.custom_model:
            base_url = request.custom_model.base_url
            model_override = request.custom_model.model_name
            if request.custom_model.api_key:
                api_key = request.custom_model.api_key
            api_mode = "chat_completions"
        else:
            api_key = api_key or settings.openai_api_key
            api_mode = request.api_mode or settings.default_api_mode

        openai_service = OpenAIService(
            session_id=request.session_id,
            base_url=base_url,
            api_key=api_key,
            embedding_config=request.embedding_config,
        )

        if api_mode == "chat_completions":
            answer_text, sources, reasoning_summary, steps, new_response_id, model_used = (
                await openai_service.chat_completions(
                    message=request.message,
                    mode=request.mode or "both",
                    days=request.days,
                    model=model_override,
                    sources=request.sources,
                    cancel_event=cancel_event,
                )
            )
        else:
            answer_text, sources, reasoning_summary, steps, new_response_id, model_used = (
                await openai_service.chat(
                    message=request.message,
                    mode=request.mode or "both",
                    days=request.days,
                    model=model_override,
                    sources=request.sources,
                    previous_response_id=session.get("previous_response_id"),
                    cancel_event=cancel_event,
                )
            )

        update_session_response_id(request.session_id, new_response_id)

        assistant_message_id = add_message(request.session_id, "assistant", answer_text)
        if sources:
            sources_json = json.dumps([s.model_dump() for s in sources])
            save_sources(request.session_id, assistant_message_id, sources_json)

        return ChatResponse(
            answer_text=answer_text,
            sources=sources,
            reasoning_summary=reasoning_summary,
            steps=steps,
            model=model_used,
        )

    except asyncio.CancelledError:
        raise HTTPException(status_code=499, detail="Request cancelled")
    except RateLimitError as e:
        logger.warning(f"Rate limit error: {e}")
        raise HTTPException(
            status_code=429,
            detail={
                "message": "Rate limit exceeded. Please try again in a moment.",
                "retry_after": e.retry_after,
            },
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except APIError as e:
        logger.error(f"API error: {e}")
        raise HTTPException(status_code=e.status_code, detail=str(e))
    except Exception as e:
        logger.exception("Error processing chat request")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if request.request_id:
            await cancel_manager.clear(request.request_id)


@router.post("/chat/stream")
async def chat_stream(request: ChatRequest):
    session = get_session_by_id(request.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    async def event_generator():
        cancel_manager = get_chat_cancellation_manager()
        cancel_event = None
        if request.request_id:
            cancel_event = await cancel_manager.register(request.request_id)
        try:
            add_message(request.session_id, "user", request.message)

            settings = get_settings()

            base_url = None
            api_key = request.api_key
            model_override = request.model
            provider = request.provider or "openai"
            
            if provider == "anthropic":
                base_url = settings.anthropic_base_url
                api_key = api_key or settings.anthropic_api_key
                api_mode = "chat_completions"
            elif provider == "gemini":
                base_url = settings.gemini_base_url
                api_key = api_key or settings.google_api_key
                api_mode = "chat_completions"
            elif provider == "custom" and request.custom_model:
                base_url = request.custom_model.base_url
                model_override = request.custom_model.model_name
                if request.custom_model.api_key:
                    api_key = request.custom_model.api_key
                api_mode = "chat_completions"
            else:
                api_key = api_key or settings.openai_api_key
                api_mode = request.api_mode or settings.default_api_mode

            openai_service = OpenAIService(
                session_id=request.session_id,
                base_url=base_url,
                api_key=api_key,
                embedding_config=request.embedding_config,
            )

            final_answer = ""
            final_sources = []

            if api_mode == "chat_completions":
                stream_method = openai_service.chat_completions_stream(
                    message=request.message,
                    mode=request.mode or "both",
                    days=request.days,
                    model=model_override,
                    sources=request.sources,
                    cancel_event=cancel_event,
                )
            else:
                stream_method = openai_service.chat_stream(
                    message=request.message,
                    mode=request.mode or "both",
                    days=request.days,
                    model=model_override,
                    sources=request.sources,
                    previous_response_id=session.get("previous_response_id"),
                    cancel_event=cancel_event,
                )

            async for event in stream_method:
                event_type = event.get("event", "message")
                event_data = event.get("data", {})

                if event_type == "done":
                    final_answer = event_data.get("answer_text", "")
                    final_sources = event_data.get("sources", [])
                    new_response_id = event_data.get("response_id")

                    if new_response_id:
                        update_session_response_id(request.session_id, new_response_id)
                    assistant_message_id = add_message(
                        request.session_id,
                        "assistant",
                        final_answer,
                    )
                    if final_sources:
                        sources_json = json.dumps(final_sources)
                        save_sources(request.session_id, assistant_message_id, sources_json)

                yield {
                    "event": event_type,
                    "data": json.dumps(event_data),
                }

        except asyncio.CancelledError:
            logger.info("Chat stream cancelled for request %s", request.request_id)
        except RateLimitError as e:
            yield {
                "event": "error",
                "data": json.dumps({
                    "error": "rate_limit",
                    "message": "Rate limit exceeded. Please try again in a moment.",
                    "retry_after": e.retry_after,
                }),
            }
        except ValueError as e:
            yield {
                "event": "error",
                "data": json.dumps({
                    "error": "bad_request",
                    "message": str(e),
                    "status_code": 400,
                }),
            }
        except APIError as e:
            yield {
                "event": "error",
                "data": json.dumps({
                    "error": "api_error",
                    "message": str(e),
                    "status_code": e.status_code,
                }),
            }
        except Exception as e:
            logger.exception("Error in streaming chat")
            yield {
                "event": "error",
                "data": json.dumps({
                    "error": "internal_error",
                    "message": str(e),
                }),
            }
        finally:
            if request.request_id:
                await cancel_manager.clear(request.request_id)

    return EventSourceResponse(event_generator())


@router.post("/chat/stop", response_model=StopChatResponse)
async def stop_chat(request: StopChatRequest):
    cancel_manager = get_chat_cancellation_manager()
    stopped = await cancel_manager.cancel(request.request_id)
    return StopChatResponse(request_id=request.request_id, stopped=stopped)


@router.get("/health")
async def health_check():
    return {"status": "healthy"}
