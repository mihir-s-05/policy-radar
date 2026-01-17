import asyncio
import json
import logging
from typing import Optional, AsyncGenerator

from google import genai
from google.genai import types

from ..config import get_settings
from ..models.schemas import SourceItem, Step, SourceSelection, EmbeddingConfig
from .tool_executor import ToolExecutor, get_tool_label
from .openai_service import (
    TOOLS,
    SYSTEM_INSTRUCTIONS,
    SOURCE_DISPLAY_NAMES,
    SOURCE_DESCRIPTIONS,
    TOOL_TO_SOURCE,
    TOOLS_WITH_DAYS_PARAM,
    MAX_TOOL_TEXT_CHARS,
)

logger = logging.getLogger(__name__)


def convert_tools_to_gemini_format(tools: list[dict]) -> list[dict]:
    """Convert OpenAI-style tool definitions to Gemini function declarations."""
    gemini_declarations = []
    for tool in tools:
        declaration = {
            "name": tool["name"],
            "description": tool.get("description", ""),
            "parameters": tool.get("parameters", {"type": "object", "properties": {}})
        }
        gemini_declarations.append(declaration)
    return gemini_declarations


class GeminiService:
    """Native Gemini API service for chat with function calling support."""

    def __init__(
        self,
        session_id: Optional[str] = None,
        api_key: Optional[str] = None,
        embedding_config: Optional[EmbeddingConfig] = None,
    ):
        settings = get_settings()
        effective_api_key = api_key or settings.google_api_key

        if not effective_api_key:
            raise ValueError("Google API key is required for Gemini service")

        self.client = genai.Client(api_key=effective_api_key)
        self.model = settings.gemini_models[0] if settings.gemini_models else "gemini-2.0-flash"
        self.tool_executor = ToolExecutor(
            session_id=session_id,
            embedding_config=embedding_config,
        )

    async def _check_cancel(self, cancel_event: Optional[asyncio.Event]) -> None:
        if cancel_event and cancel_event.is_set():
            raise asyncio.CancelledError()

    async def _run_sync_in_executor(self, func, *args, **kwargs):
        """Run synchronous Gemini SDK calls in executor to not block event loop."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, lambda: func(*args, **kwargs))

    def _truncate_for_model(self, text: str) -> tuple[str, bool]:
        if not text or len(text) <= MAX_TOOL_TEXT_CHARS:
            return text, False

        truncated = text[:MAX_TOOL_TEXT_CHARS]
        last_period = truncated.rfind(".")
        if last_period > MAX_TOOL_TEXT_CHARS * 0.8:
            truncated = truncated[:last_period + 1]
        truncated += "\n\n[Content truncated for model context...]"
        return truncated, True

    def _shorten_label_value(self, value: str, max_len: int = 60) -> str:
        if not value:
            return ""
        if len(value) <= max_len:
            return value
        return value[: max_len - 3] + "..."

    def _format_pdf_search_label(self, query: str, preview: Optional[dict]) -> str:
        base = f"Search PDF memory: {self._shorten_label_value(query, 50)}"
        if not preview:
            return base
        documents = preview.get("documents") or []
        if not documents:
            return base
        first_doc = documents[0] or {}
        doc_label = first_doc.get("doc_key") or first_doc.get("pdf_url") or ""
        doc_label = self._shorten_label_value(doc_label, 50)
        if not doc_label:
            return base
        if len(documents) > 1:
            return f"{base} (top: {doc_label} +{len(documents) - 1})"
        return f"{base} (top: {doc_label})"

    def _prepare_tool_output(self, tool_name: str, result: dict) -> dict:
        """Prepare tool output for Gemini, removing images and truncating text."""
        safe_result = {k: v for k, v in result.items() if k != "images"}

        if "full_text" in safe_result and safe_result.get("full_text"):
            original_len = len(safe_result["full_text"])
            truncated, did_truncate = self._truncate_for_model(safe_result["full_text"])
            if did_truncate:
                safe_result["full_text"] = truncated
                safe_result["full_text_length"] = original_len
                safe_result["full_text_truncated"] = True
                logger.info(
                    "Truncated full_text for %s from %s chars to %s chars",
                    tool_name,
                    original_len,
                    len(truncated),
                )

        if "text" in safe_result and safe_result.get("text"):
            original_len = len(safe_result["text"])
            truncated, did_truncate = self._truncate_for_model(safe_result["text"])
            if did_truncate:
                safe_result["text"] = truncated
                safe_result["text_length"] = original_len
                safe_result["text_truncated"] = True
                logger.info(
                    "Truncated text for %s from %s chars to %s chars",
                    tool_name,
                    original_len,
                    len(truncated),
                )

        return safe_result

    def _format_user_message(
        self,
        message: str,
        days: int,
        selected_sources: Optional[set[str]] = None,
        auto_rationale: Optional[str] = None,
    ) -> str:
        sources_line = "Auto"
        if selected_sources:
            sources_line = ", ".join(
                SOURCE_DISPLAY_NAMES.get(s, s) for s in sorted(selected_sources)
            )
        rationale_line = f"\n- Auto selection: {auto_rationale}" if auto_rationale else ""

        return f"""User query: {message}

Search context:
- Time window: Last {days} days
- Sources: {sources_line}{rationale_line}

Please search for relevant information and provide a comprehensive answer with citations."""

    def _get_configured_sources(self) -> set[str]:
        settings = get_settings()
        configured = set(SOURCE_DISPLAY_NAMES.keys())

        if not settings.gov_api_key:
            configured.discard("regulations")
            configured.discard("govinfo")
            configured.discard("congress")

        if not (settings.searchgov_affiliate and settings.searchgov_access_key):
            configured.discard("searchgov")

        return configured

    def _filter_tools_for_sources(self, tools: list[dict], selected_sources: set[str]) -> list[dict]:
        filtered = []
        for tool in tools:
            tool_name = tool.get("name")
            source_key = TOOL_TO_SOURCE.get(tool_name)
            if source_key is None or source_key in selected_sources:
                filtered.append(tool)
        return filtered

    def _resolve_source_preferences(
        self,
        mode: str,
        sources: Optional[SourceSelection],
    ) -> tuple[bool, set[str]]:
        configured_sources = self._get_configured_sources()

        if sources is None:
            if mode == "regulations":
                return False, {"regulations"} & configured_sources
            if mode == "govinfo":
                return False, {"govinfo"} & configured_sources
            return True, set(SOURCE_DISPLAY_NAMES.keys()) & configured_sources

        requested_sources = {
            key for key in SOURCE_DISPLAY_NAMES.keys()
            if getattr(sources, key, False)
        }

        auto_enabled = bool(getattr(sources, "auto", False))

        if not requested_sources:
            if auto_enabled:
                requested_sources = set(SOURCE_DISPLAY_NAMES.keys())
            else:
                return False, set()

        if mode == "regulations":
            requested_sources &= {"regulations"}
        elif mode == "govinfo":
            requested_sources &= {"govinfo"}

        requested_sources &= configured_sources
        return auto_enabled, requested_sources

    def _apply_days_default(self, tool_name: str, args: dict, days: int) -> None:
        if tool_name in TOOLS_WITH_DAYS_PARAM and "days" not in args:
            args["days"] = days

    def _get_available_tools(self, mode: str, selected_sources: Optional[set[str]] = None) -> list[dict]:
        fetch_url_tool = [t for t in TOOLS if t["name"] == "fetch_url_content"]
        memory_tool = [t for t in TOOLS if t["name"] == "search_pdf_memory"]

        if mode == "regulations":
            regs_tools = [t for t in TOOLS if t["name"].startswith("regs_")]
            tools = regs_tools + fetch_url_tool + memory_tool
        elif mode == "govinfo":
            govinfo_tools = [t for t in TOOLS if t["name"].startswith("govinfo_")]
            tools = govinfo_tools + fetch_url_tool + memory_tool
        else:
            tools = TOOLS

        if selected_sources is None:
            return tools
        return self._filter_tools_for_sources(tools, selected_sources)

    def _extract_json_object(self, text: str) -> Optional[dict]:
        if not text:
            return None
        text = text.strip()
        import re
        try:
            parsed = json.loads(text)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            pass

        match = re.search(r"\{.*\}", text, flags=re.DOTALL)
        if not match:
            return None
        try:
            parsed = json.loads(match.group(0))
            return parsed if isinstance(parsed, dict) else None
        except Exception:
            return None

    async def _auto_select_sources(
        self,
        message: str,
        allowed_sources: set[str],
        model_to_use: str,
        cancel_event: Optional[asyncio.Event] = None,
    ) -> tuple[set[str], Optional[str]]:
        """Use Gemini to intelligently select sources based on the query."""
        if not allowed_sources:
            return set(), None
        if len(allowed_sources) == 1:
            return set(allowed_sources), "Only one source available."

        options_text = "\n".join(
            f"- {key}: {SOURCE_DISPLAY_NAMES[key]} - {SOURCE_DESCRIPTIONS.get(key, '')}"
            for key in sorted(allowed_sources)
        )

        selector_prompt = f"""You route user queries to the most relevant data sources.
Use the routing guidance and choose the sources most likely to contain authoritative results.
Return STRICT JSON only: {{"sources":["source_key",...], "rationale":"short"}}.
Choose 1-6 sources; choose fewer when the query is narrow.
Only choose from the allowed list.

User query: {message}

Allowed sources:
{options_text}

Routing guidance:
- regulations: rulemakings, dockets, proposed/final rules, agency regulatory actions
- govinfo: official publications and broad federal documents
- federal_register: rules, notices, presidential documents in the Federal Register
- congress: bills, legislation status, roll call votes, sponsors, committees
- usaspending: federal awards, contracts, grants, recipients, agencies, award totals
- fiscal_data: Treasury fiscal time series (debt, receipts, outlays, interest rates)
- datagov: datasets, open data resources, data catalog discovery
- doj: DOJ press releases, enforcement announcements
- searchgov: broad .gov site search"""

        try:
            await self._check_cancel(cancel_event)

            response = await self._run_sync_in_executor(
                self.client.models.generate_content,
                model=model_to_use,
                contents=selector_prompt,
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    temperature=0.1,
                ),
            )

            raw = response.text if hasattr(response, 'text') else ""
            data = self._extract_json_object(raw) or {}

            chosen = [
                s for s in (data.get("sources") or [])
                if isinstance(s, str) and s in allowed_sources
            ]
            chosen_sources = set(chosen[:6])
            rationale = data.get("rationale")

            if chosen_sources:
                return chosen_sources, rationale if isinstance(rationale, str) else None

            logger.warning(
                "Auto source selection returned no valid sources. Raw: %s Parsed: %s",
                raw,
                data,
            )
            return set(allowed_sources), "No valid selection returned; using all allowed sources."

        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("Auto source selection failed; using all allowed sources: %s", exc)
            return set(allowed_sources), "Auto selection failed; using all allowed sources."

    async def chat(
        self,
        message: str,
        mode: str,
        days: int,
        model: Optional[str] = None,
        sources: Optional[SourceSelection] = None,
        cancel_event: Optional[asyncio.Event] = None,
    ) -> tuple[str, list[SourceItem], Optional[str], list[Step], str, str]:
        """Synchronous (non-streaming) chat with Gemini using function calling."""
        self.tool_executor.clear_sources()
        steps: list[Step] = []
        step_counter = 0

        model_to_use = model or self.model
        auto_enabled, allowed_sources = self._resolve_source_preferences(mode, sources)
        if not allowed_sources:
            raise ValueError("No sources enabled/available for this request.")

        selected_sources = allowed_sources
        auto_rationale = None
        if auto_enabled:
            step_counter += 1
            selected_sources, auto_rationale = await self._auto_select_sources(
                message=message,
                allowed_sources=allowed_sources,
                model_to_use=model_to_use,
                cancel_event=cancel_event,
            )
            if not selected_sources:
                selected_sources = allowed_sources
            steps.append(
                Step(
                    step_id=str(step_counter),
                    status="done",
                    label="Auto-select sources",
                    tool_name="auto_select_sources",
                    args={"allowed_sources": sorted(allowed_sources)},
                    result_preview={
                        "selected_sources": sorted(selected_sources),
                        "rationale": auto_rationale,
                    },
                )
            )

        formatted_message = self._format_user_message(
            message=message,
            days=days,
            selected_sources=selected_sources,
            auto_rationale=auto_rationale,
        )
        available_tools = self._get_available_tools(mode, selected_sources=selected_sources)
        gemini_tools = convert_tools_to_gemini_format(available_tools)

        # Create tool configuration for Gemini
        tools_config = types.Tool(function_declarations=gemini_tools)

        # Build conversation contents
        contents = [
            types.Content(
                role="user",
                parts=[types.Part.from_text(text=formatted_message)]
            )
        ]

        await self._check_cancel(cancel_event)

        # Make initial request with tools
        response = await self._run_sync_in_executor(
            self.client.models.generate_content,
            model=model_to_use,
            contents=contents,
            config=types.GenerateContentConfig(
                system_instruction=SYSTEM_INSTRUCTIONS,
                tools=[tools_config],
                temperature=1.0,
            ),
        )

        # Process function calls iteratively
        max_iterations = 20
        iteration = 0

        while iteration < max_iterations:
            await self._check_cancel(cancel_event)
            iteration += 1

            # Check if response contains function calls
            function_calls = []
            if response.candidates and response.candidates[0].content:
                for part in response.candidates[0].content.parts:
                    if hasattr(part, 'function_call') and part.function_call:
                        function_calls.append(part.function_call)

            if not function_calls:
                break

            # Add assistant response to contents
            contents.append(response.candidates[0].content)

            # Execute each function call
            function_response_parts = []
            for call in function_calls:
                await self._check_cancel(cancel_event)
                step_counter += 1
                step_id = str(step_counter)
                tool_name = call.name
                args = dict(call.args) if call.args else {}

                self._apply_days_default(tool_name, args, days)

                step = Step(
                    step_id=step_id,
                    status="running",
                    label=get_tool_label(tool_name, args),
                    tool_name=tool_name,
                    args=args,
                )
                steps.append(step)

                result, preview = await self.tool_executor.execute_tool(tool_name, args)
                safe_result = self._prepare_tool_output(tool_name, result)

                step.status = "done" if "error" not in safe_result else "error"
                step.result_preview = preview
                if tool_name == "search_pdf_memory":
                    step.label = self._format_pdf_search_label(args.get("query", ""), preview)

                # Create function response part
                function_response_parts.append(
                    types.Part.from_function_response(
                        name=tool_name,
                        response={"result": safe_result}
                    )
                )

            # Add function responses as user message
            contents.append(
                types.Content(
                    role="user",
                    parts=function_response_parts
                )
            )

            # Get next response
            await self._check_cancel(cancel_event)
            response = await self._run_sync_in_executor(
                self.client.models.generate_content,
                model=model_to_use,
                contents=contents,
                config=types.GenerateContentConfig(
                    system_instruction=SYSTEM_INSTRUCTIONS,
                    tools=[tools_config],
                    temperature=1.0,
                ),
            )

        # Extract final answer text
        answer_text = ""
        if response.candidates and response.candidates[0].content:
            for part in response.candidates[0].content.parts:
                if hasattr(part, 'text') and part.text:
                    answer_text += part.text

        collected_sources = self.tool_executor.get_collected_sources()
        response_id = f"gemini-{model_to_use}-{iteration}"

        return answer_text, collected_sources, None, steps, response_id, model_to_use

    async def chat_stream(
        self,
        message: str,
        mode: str,
        days: int,
        model: Optional[str] = None,
        sources: Optional[SourceSelection] = None,
        cancel_event: Optional[asyncio.Event] = None,
    ) -> AsyncGenerator[dict, None]:
        """Streaming chat with Gemini using function calling."""
        self.tool_executor.clear_sources()
        step_counter = 0

        model_to_use = model or self.model
        auto_enabled, allowed_sources = self._resolve_source_preferences(mode, sources)
        if not allowed_sources:
            raise ValueError("No sources enabled/available for this request.")

        selected_sources = allowed_sources
        auto_rationale = None
        if auto_enabled:
            step_counter += 1
            auto_step_id = str(step_counter)
            yield {
                "event": "step",
                "data": {
                    "step_id": auto_step_id,
                    "status": "running",
                    "label": "Auto-select sources",
                    "tool_name": "auto_select_sources",
                    "args": {"allowed_sources": sorted(allowed_sources)},
                },
            }
            selected_sources, auto_rationale = await self._auto_select_sources(
                message=message,
                allowed_sources=allowed_sources,
                model_to_use=model_to_use,
                cancel_event=cancel_event,
            )
            if not selected_sources:
                selected_sources = allowed_sources
            yield {
                "event": "step",
                "data": {
                    "step_id": auto_step_id,
                    "status": "done",
                    "result_preview": {
                        "selected_sources": sorted(selected_sources),
                        "rationale": auto_rationale,
                    },
                },
            }

        formatted_message = self._format_user_message(
            message=message,
            days=days,
            selected_sources=selected_sources,
            auto_rationale=auto_rationale,
        )
        available_tools = self._get_available_tools(mode, selected_sources=selected_sources)
        gemini_tools = convert_tools_to_gemini_format(available_tools)

        tools_config = types.Tool(function_declarations=gemini_tools)

        contents = [
            types.Content(
                role="user",
                parts=[types.Part.from_text(text=formatted_message)]
            )
        ]

        await self._check_cancel(cancel_event)

        response = await self._run_sync_in_executor(
            self.client.models.generate_content,
            model=model_to_use,
            contents=contents,
            config=types.GenerateContentConfig(
                system_instruction=SYSTEM_INSTRUCTIONS,
                tools=[tools_config],
                temperature=1.0,
            ),
        )

        max_iterations = 20
        iteration = 0

        while iteration < max_iterations:
            await self._check_cancel(cancel_event)
            iteration += 1

            function_calls = []
            if response.candidates and response.candidates[0].content:
                for part in response.candidates[0].content.parts:
                    if hasattr(part, 'function_call') and part.function_call:
                        function_calls.append(part.function_call)

            if not function_calls:
                break

            contents.append(response.candidates[0].content)

            function_response_parts = []
            for call in function_calls:
                await self._check_cancel(cancel_event)
                step_counter += 1
                step_id = str(step_counter)
                tool_name = call.name
                args = dict(call.args) if call.args else {}

                self._apply_days_default(tool_name, args, days)

                yield {
                    "event": "step",
                    "data": {
                        "step_id": step_id,
                        "status": "running",
                        "label": get_tool_label(tool_name, args),
                        "tool_name": tool_name,
                        "args": args,
                    }
                }

                result, preview = await self.tool_executor.execute_tool(tool_name, args)
                safe_result = self._prepare_tool_output(tool_name, result)

                label_override = None
                if tool_name == "search_pdf_memory":
                    label_override = self._format_pdf_search_label(args.get("query", ""), preview)

                yield {
                    "event": "step",
                    "data": {
                        "step_id": step_id,
                        "status": "done" if "error" not in safe_result else "error",
                        "result_preview": preview,
                        "label": label_override,
                    }
                }

                function_response_parts.append(
                    types.Part.from_function_response(
                        name=tool_name,
                        response={"result": safe_result}
                    )
                )

            contents.append(
                types.Content(
                    role="user",
                    parts=function_response_parts
                )
            )

            await self._check_cancel(cancel_event)
            response = await self._run_sync_in_executor(
                self.client.models.generate_content,
                model=model_to_use,
                contents=contents,
                config=types.GenerateContentConfig(
                    system_instruction=SYSTEM_INSTRUCTIONS,
                    tools=[tools_config],
                    temperature=1.0,
                ),
            )

        # Extract and stream final answer text
        final_text = ""
        if response.candidates and response.candidates[0].content:
            for part in response.candidates[0].content.parts:
                if hasattr(part, 'text') and part.text:
                    final_text += part.text

        # Stream text in chunks
        chunk_size = 50
        for i in range(0, len(final_text), chunk_size):
            await self._check_cancel(cancel_event)
            chunk = final_text[i:i + chunk_size]
            yield {
                "event": "assistant_delta",
                "data": {"delta": chunk}
            }
            await asyncio.sleep(0.01)

        collected_sources = self.tool_executor.get_collected_sources()

        yield {
            "event": "done",
            "data": {
                "answer_text": final_text,
                "sources": [s.model_dump() for s in collected_sources],
                "response_id": f"gemini-{model_to_use}-{iteration}",
                "model": model_to_use,
            }
        }
