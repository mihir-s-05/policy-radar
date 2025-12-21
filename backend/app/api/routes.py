import json
import logging
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
    return ConfigResponse(
        model=settings.openai_model,
        available_models=settings.available_models,
    )


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

    try:
        add_message(request.session_id, "user", request.message)

        openai_service = OpenAIService(session_id=request.session_id)
        answer_text, sources, reasoning_summary, steps, new_response_id, model_used = (
            await openai_service.chat(
                message=request.message,
                mode=request.mode,
                days=request.days,
                model=request.model,
                previous_response_id=session.get("previous_response_id"),
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

    except RateLimitError as e:
        logger.warning(f"Rate limit error: {e}")
        raise HTTPException(
            status_code=429,
            detail={
                "message": "Rate limit exceeded. Please try again in a moment.",
                "retry_after": e.retry_after,
            },
        )
    except APIError as e:
        logger.error(f"API error: {e}")
        raise HTTPException(status_code=e.status_code, detail=str(e))
    except Exception as e:
        logger.exception("Error processing chat request")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/chat/stream")
async def chat_stream(request: ChatRequest):
    session = get_session_by_id(request.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    async def event_generator():
        try:
            add_message(request.session_id, "user", request.message)

            openai_service = OpenAIService(session_id=request.session_id)
            final_answer = ""
            final_sources = []

            async for event in openai_service.chat_stream(
                message=request.message,
                mode=request.mode,
                days=request.days,
                model=request.model,
                previous_response_id=session.get("previous_response_id"),
            ):
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

        except RateLimitError as e:
            yield {
                "event": "error",
                "data": json.dumps({
                    "error": "rate_limit",
                    "message": "Rate limit exceeded. Please try again in a moment.",
                    "retry_after": e.retry_after,
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

    return EventSourceResponse(event_generator())


@router.get("/health")
async def health_check():
    return {"status": "healthy"}
