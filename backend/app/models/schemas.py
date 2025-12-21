from typing import Optional, Literal
from pydantic import BaseModel, Field


class SourceItem(BaseModel):
    source_type: Literal[
        "regulations_document",
        "regulations_docket",
        "govinfo_result",
        "govinfo_package",
    ]
    id: str
    title: str
    agency: Optional[str] = None
    date: Optional[str] = None
    url: str
    excerpt: Optional[str] = None


class Step(BaseModel):
    step_id: str
    status: Literal["running", "done", "error"]
    label: str
    tool_name: str
    args: dict = Field(default_factory=dict)
    result_preview: Optional[dict] = None


class ChatRequest(BaseModel):
    session_id: str
    message: str
    mode: Literal["regulations", "govinfo", "both"] = "both"
    days: int = Field(default=30, ge=7, le=90)


class ChatResponse(BaseModel):
    answer_text: str
    sources: list[SourceItem] = Field(default_factory=list)
    reasoning_summary: Optional[str] = None
    steps: list[Step] = Field(default_factory=list)


class SessionResponse(BaseModel):
    session_id: str


class SessionInfo(BaseModel):
    session_id: str
    created_at: str
    last_message: Optional[str] = None
    last_message_at: Optional[str] = None
    title: Optional[str] = None


class SessionListResponse(BaseModel):
    sessions: list[SessionInfo] = Field(default_factory=list)


class DeleteSessionResponse(BaseModel):
    session_id: str
    deleted: bool


class MessageItem(BaseModel):
    id: int
    role: Literal["user", "assistant"]
    content: str
    created_at: str
    sources: Optional[list[SourceItem]] = None


class MessagesResponse(BaseModel):
    session_id: str
    messages: list[MessageItem] = Field(default_factory=list)


class FetchContentRequest(BaseModel):
    url: str
    max_length: int = Field(default=15000, ge=1, le=500000)
    full_text: bool = False


class FetchContentResponse(BaseModel):
    url: str
    title: Optional[str] = None
    full_text: Optional[str] = None
    error: Optional[str] = None


class UpdateMessageRequest(BaseModel):
    content: str


class UpdateMessageResponse(BaseModel):
    updated: bool


class ConfigResponse(BaseModel):
    model: str


class StepEvent(BaseModel):
    step_id: str
    status: Literal["running", "done", "error"]
    label: Optional[str] = None
    tool_name: Optional[str] = None
    args: Optional[dict] = None
    result_preview: Optional[dict] = None


class ReasoningSummaryEvent(BaseModel):
    text: str


class AssistantDeltaEvent(BaseModel):
    delta: str


class DoneEvent(BaseModel):
    answer_text: str
    sources: list[SourceItem] = Field(default_factory=list)
