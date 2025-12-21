from typing import Optional, Literal
from pydantic import BaseModel, Field


class SourceItem(BaseModel):
    source_type: Literal[
        "regulations_document",
        "regulations_docket",
        "govinfo_result",
        "govinfo_package",
        "congress_bill",
        "congress_vote",
        "federal_register",
        "usaspending",
        "fiscal_data",
        "datagov",
        "doj_press_release",
        "searchgov",
    ]
    id: str
    title: str
    agency: Optional[str] = None
    date: Optional[str] = None
    url: str
    excerpt: Optional[str] = None
    pdf_url: Optional[str] = None
    content_type: Optional[str] = None
    raw: Optional[dict] = None


class SourceSelection(BaseModel):
    auto: bool = True
    govinfo: bool = True
    regulations: bool = True
    congress: bool = True
    federal_register: bool = True
    usaspending: bool = True
    fiscal_data: bool = True
    datagov: bool = True
    doj: bool = True
    searchgov: bool = True


class CustomModelConfig(BaseModel):
    base_url: str
    model_name: str
    api_key: Optional[str] = None


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
    mode: Optional[Literal["regulations", "govinfo", "both"]] = None
    sources: Optional[SourceSelection] = None
    days: int = Field(default=30, ge=7, le=90)
    model: Optional[str] = None
    provider: Optional[Literal["openai", "anthropic", "gemini", "custom"]] = None
    api_mode: Optional[Literal["responses", "chat_completions"]] = None
    custom_model: Optional[CustomModelConfig] = None
    api_key: Optional[str] = None


class ChatResponse(BaseModel):
    answer_text: str
    sources: list[SourceItem] = Field(default_factory=list)
    reasoning_summary: Optional[str] = None
    steps: list[Step] = Field(default_factory=list)
    model: Optional[str] = None


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


class ProviderInfo(BaseModel):
    name: str
    display_name: str
    base_url: str
    models: list[str] = Field(default_factory=list)
    api_key_detected: bool = False
    api_mode: Literal["responses", "chat_completions"] = "chat_completions"


class ConfigResponse(BaseModel):
    model: str
    available_models: list[str] = Field(default_factory=list)
    default_api_mode: Literal["responses", "chat_completions"] = "responses"
    providers: dict[str, ProviderInfo] = Field(default_factory=dict)


class ValidateModelRequest(BaseModel):
    provider: Literal["openai", "anthropic", "gemini", "custom"]
    model_name: str
    api_key: Optional[str] = None
    base_url: Optional[str] = None


class ValidateModelResponse(BaseModel):
    valid: bool
    message: str


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
