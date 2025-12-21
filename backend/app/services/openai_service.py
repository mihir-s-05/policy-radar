import asyncio
import json
import logging
from typing import Optional, AsyncGenerator
from openai import OpenAI

from ..config import get_settings
from ..models.schemas import SourceItem, Step
from .tool_executor import ToolExecutor, get_tool_label

logger = logging.getLogger(__name__)

MAX_TOOL_TEXT_CHARS = 20000
MAX_TOOL_IMAGES = 2
MAX_IMAGE_BYTES = 200_000
MAX_IMAGE_TOTAL_BYTES = 250_000
SYSTEM_INSTRUCTIONS = """You are a neutral policy research assistant specializing in U.S. federal regulatory activity.

CRITICAL RULES:
1. Always use the available tools to search for up-to-date information. Never guess or make up information about regulations or federal activity.
2. Provide citations as links for every factual claim. Include at least one source per factual paragraph.
3. Do not provide legal advice. Always include this disclaimer at the end: "Note: This is not legal advice. Please verify information with official sources."
4. Be non-partisan and objective. Present information neutrally without political bias.
5. Keep responses readable and well-organized. Use bullet points or numbered lists for multiple items.

When searching:
- Use regs_search_documents for proposed rules, final rules, notices, and other regulatory documents
- Use regs_search_dockets for broader rulemaking proceedings
- Use govinfo_search for Federal Register content and other official government publications
- The user has specified a time window - respect it by using the 'days' parameter on regs_search_documents and govinfo_search

READING FULL DOCUMENT CONTENT:
- After finding documents, use regs_read_document_content or govinfo_read_package_content to read the full text
- This allows you to understand and summarize the actual content, not just metadata
- Read the full content when the user asks for details, summaries, or analysis of specific documents
- Use fetch_url_content as a fallback for any government URL
- Some tools may include extracted PDF images as separate inputs. Use them when relevant.
- Use search_pdf_memory to retrieve previously indexed PDF content for this session when needed.

Format your response clearly with:
- A summary of what you found
- Key details organized logically
- Direct links to sources
- The required disclaimer at the end"""

TOOLS = [
    {
        "type": "function",
        "name": "regs_search_documents",
        "description": "Search for regulatory documents on Regulations.gov including proposed rules, final rules, notices, and other documents. Returns the most recent documents matching the search criteria.",
        "parameters": {
            "type": "object",
            "properties": {
                "search_term": {
                    "type": "string",
                    "description": "Search keywords for finding documents (e.g., 'asylum', 'water quality', 'immigration')"
                },
                "days": {
                    "type": "integer",
                    "description": "Number of days to look back from today (e.g., 30, 60, 90)",
                    "default": 30
                },
                "page_size": {
                    "type": "integer",
                    "description": "Number of results to return (max 25)",
                    "default": 10
                }
            },
            "required": ["search_term"]
        }
    },
    {
        "type": "function",
        "name": "regs_search_dockets",
        "description": "Search for dockets (rulemaking proceedings) on Regulations.gov. Dockets contain the full record of a rulemaking including all related documents and public comments.",
        "parameters": {
            "type": "object",
            "properties": {
                "search_term": {
                    "type": "string",
                    "description": "Search keywords for finding dockets"
                },
                "page_size": {
                    "type": "integer",
                    "description": "Number of results to return",
                    "default": 10
                }
            },
            "required": ["search_term"]
        }
    },
    {
        "type": "function",
        "name": "regs_get_document",
        "description": "Get detailed information about a specific document from Regulations.gov by its document ID.",
        "parameters": {
            "type": "object",
            "properties": {
                "document_id": {
                    "type": "string",
                    "description": "The Regulations.gov document ID (e.g., 'EPA-HQ-OW-2024-0001-0001')"
                },
                "include_attachments": {
                    "type": "boolean",
                    "description": "Whether to include attachment information",
                    "default": False
                }
            },
            "required": ["document_id"]
        }
    },
    {
        "type": "function",
        "name": "govinfo_search",
        "description": "Search GovInfo for Federal Register content and other official government publications. Supports keywords, collection filters, and time windows.",
        "parameters": {
            "type": "object",
            "properties": {
                "keywords": {
                    "type": "string",
                    "description": "Search keywords (e.g., 'immigration', 'water quality'). Use concise topic terms."
                },
                "collection": {
                    "type": "string",
                    "description": "Optional collection code filter (e.g., 'FR' for Federal Register)."
                },
                "days": {
                    "type": "integer",
                    "description": "Number of days to look back from today (e.g., 30, 60, 90).",
                    "default": 30
                },
                "query": {
                    "type": "string",
                    "description": "Advanced query override (e.g., 'collection:FR AND immigration AND publishdate:range(2024-01-01,)'). Use only when needed."
                },
                "page_size": {
                    "type": "integer",
                    "description": "Number of results to return",
                    "default": 10
                }
            },
            "required": ["keywords"]
        }
    },
    {
        "type": "function",
        "name": "govinfo_package_summary",
        "description": "Get detailed summary information about a specific GovInfo package by its package ID.",
        "parameters": {
            "type": "object",
            "properties": {
                "package_id": {
                    "type": "string",
                    "description": "The GovInfo package ID"
                }
            },
            "required": ["package_id"]
        }
    },
    {
        "type": "function",
        "name": "regs_read_document_content",
        "description": "Read and extract the full text content of a Regulations.gov document. Use this after searching to get the complete document text for analysis and summarization.",
        "parameters": {
            "type": "object",
            "properties": {
                "document_id": {
                    "type": "string",
                    "description": "The Regulations.gov document ID to read (e.g., 'EPA-HQ-OW-2024-0001-0001')"
                }
            },
            "required": ["document_id"]
        }
    },
    {
        "type": "function",
        "name": "govinfo_read_package_content",
        "description": "Read and extract the full text content of a GovInfo package (Federal Register entry, bill, etc.). Use this after searching to get the complete document text for analysis and summarization.",
        "parameters": {
            "type": "object",
            "properties": {
                "package_id": {
                    "type": "string",
                    "description": "The GovInfo package ID to read"
                }
            },
            "required": ["package_id"]
        }
    },
    {
        "type": "function",
        "name": "fetch_url_content",
        "description": "Fetch and extract text content from any government URL. Use this as a fallback when you have a URL but need to read its content.",
        "parameters": {
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "The URL to fetch content from (should be a .gov or official government URL)"
                },
                "max_length": {
                    "type": "integer",
                    "description": "Optional maximum length of text to return. Increase for longer documents.",
                    "default": 15000
                },
                "full_text": {
                    "type": "boolean",
                    "description": "Set true to return the full extracted text without truncation.",
                    "default": False
                }
            },
            "required": ["url"]
        }
    },
    {
        "type": "function",
        "name": "search_pdf_memory",
        "description": "Search indexed PDF content stored in memory for this session. Use this to recall details from PDFs already processed.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search query for the PDF memory."
                },
                "top_k": {
                    "type": "integer",
                    "description": "Number of matches to return.",
                    "default": 5
                }
            },
            "required": ["query"]
        }
    }
]


class OpenAIService:
    def __init__(self, session_id: Optional[str] = None):
        settings = get_settings()
        self.client = OpenAI(api_key=settings.openai_api_key)
        self.model = settings.openai_model
        self.tool_executor = ToolExecutor(session_id=session_id)

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

    def _prepare_tool_output(self, tool_name: str, result: dict) -> tuple[dict, Optional[dict]]:
        images = result.get("images")
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

        if not images:
            return safe_result, None

        image_inputs = []
        image_meta = []
        source_label = (
            result.get("url")
            or result.get("document_id")
            or result.get("package_id")
            or tool_name
        )

        skipped_images = 0
        total_image_bytes = 0
        for image in images:
            if len(image_inputs) >= MAX_TOOL_IMAGES:
                skipped_images += 1
                continue
            byte_size = image.get("byte_size") or 0
            if byte_size and byte_size > MAX_IMAGE_BYTES:
                skipped_images += 1
                continue
            if byte_size and total_image_bytes + byte_size > MAX_IMAGE_TOTAL_BYTES:
                skipped_images += 1
                continue
            data = image.get("data_base64")
            mime_type = image.get("mime_type", "image/png")
            if data:
                image_inputs.append(
                    {
                        "type": "input_image",
                        "image_url": f"data:{mime_type};base64,{data}",
                    }
                )
                total_image_bytes += byte_size
            image_meta.append(
                {
                    "id": image.get("id"),
                    "page": image.get("page"),
                    "source": image.get("source"),
                    "mime_type": mime_type,
                    "width": image.get("width"),
                    "height": image.get("height"),
                    "byte_size": image.get("byte_size"),
                }
            )

        message_item = None
        if image_inputs:
            lines = [f"Images extracted from {source_label}:"]
            for meta in image_meta:
                label = meta.get("id") or "image"
                details = []
                if meta.get("page"):
                    details.append(f"page {meta['page']}")
                if meta.get("source"):
                    details.append(str(meta["source"]))
                if details:
                    label = f"{label} ({', '.join(details)})"
                lines.append(f"- {label}")
            image_inputs.insert(0, {"type": "input_text", "text": "\n".join(lines)})
            message_item = {
                "type": "message",
                "role": "user",
                "content": image_inputs,
            }

        if image_meta:
            safe_result["image_count"] = len(image_meta)
            safe_result["image_metadata"] = image_meta
            if skipped_images:
                safe_result["images_skipped_for_model"] = skipped_images
            logger.info(
                "Prepared %s image(s) for model input from %s",
                len(image_meta),
                source_label,
            )
        elif skipped_images:
            safe_result["image_count"] = 0
            safe_result["images_skipped_for_model"] = skipped_images
            logger.info(
                "Skipped %s image(s) for model input from %s",
                skipped_images,
                source_label,
            )

        return safe_result, message_item

    def _format_user_message(self, message: str, mode: str, days: int) -> str:
        mode_context = {
            "regulations": "Search Regulations.gov only.",
            "govinfo": "Search GovInfo only.",
            "both": "Search both Regulations.gov and GovInfo for comprehensive results.",
        }

        return f"""User query: {message}

Search context:
- Time window: Last {days} days
- Search mode: {mode_context.get(mode, mode_context['both'])}

Please search for relevant information and provide a comprehensive answer with citations."""

    def _get_available_tools(self, mode: str) -> list[dict]:
        fetch_url_tool = [t for t in TOOLS if t["name"] == "fetch_url_content"]
        memory_tool = [t for t in TOOLS if t["name"] == "search_pdf_memory"]

        if mode == "regulations":
            regs_tools = [t for t in TOOLS if t["name"].startswith("regs_")]
            return regs_tools + fetch_url_tool + memory_tool
        elif mode == "govinfo":
            govinfo_tools = [t for t in TOOLS if t["name"].startswith("govinfo_")]
            return govinfo_tools + fetch_url_tool + memory_tool
        else:
            return TOOLS

    async def chat(
        self,
        message: str,
        mode: str,
        days: int,
        model: Optional[str] = None,
        previous_response_id: Optional[str] = None,
    ) -> tuple[str, list[SourceItem], Optional[str], list[Step], str, str]:
        self.tool_executor.clear_sources()
        steps: list[Step] = []
        step_counter = 0

        model_to_use = model or self.model
        formatted_message = self._format_user_message(message, mode, days)
        available_tools = self._get_available_tools(mode)

        input_messages = [{"role": "user", "content": formatted_message}]

        response = self.client.responses.create(
            model=model_to_use,
            instructions=SYSTEM_INSTRUCTIONS,
            input=input_messages,
            tools=available_tools,
            parallel_tool_calls=False,
            previous_response_id=previous_response_id,
        )

        current_response_id = response.id
        reasoning_summary = None

        while True:
            function_calls = [
                item for item in response.output
                if item.type == "function_call"
            ]

            if not function_calls:
                break

            function_outputs = []
            for call in function_calls:
                step_counter += 1
                step_id = str(step_counter)
                tool_name = call.name
                args = json.loads(call.arguments)

                if tool_name in ("regs_search_documents", "govinfo_search") and "days" not in args:
                    args["days"] = days

                step = Step(
                    step_id=step_id,
                    status="running",
                    label=get_tool_label(tool_name, args),
                    tool_name=tool_name,
                    args=args,
                )
                steps.append(step)

                result, preview = await self.tool_executor.execute_tool(tool_name, args)
                safe_result, image_message = self._prepare_tool_output(tool_name, result)

                step.status = "done" if "error" not in safe_result else "error"
                step.result_preview = preview
                if tool_name == "search_pdf_memory":
                    step.label = self._format_pdf_search_label(
                        args.get("query", ""),
                        preview,
                    )

                function_outputs.append({
                    "type": "function_call_output",
                    "call_id": call.call_id,
                    "output": json.dumps(safe_result),
                })
                if image_message:
                    function_outputs.append(image_message)

            response = self.client.responses.create(
                model=model_to_use,
                instructions=SYSTEM_INSTRUCTIONS,
                input=function_outputs,
                tools=available_tools,
                parallel_tool_calls=False,
                previous_response_id=current_response_id,
            )
            current_response_id = response.id

        answer_text = ""
        for item in response.output:
            if item.type == "message":
                for content in item.content:
                    if content.type == "output_text":
                        answer_text = content.text
                        break

        sources = self.tool_executor.get_collected_sources()

        return answer_text, sources, reasoning_summary, steps, current_response_id, model_to_use

    async def chat_stream(
        self,
        message: str,
        mode: str,
        days: int,
        model: Optional[str] = None,
        previous_response_id: Optional[str] = None,
    ) -> AsyncGenerator[dict, None]:
        self.tool_executor.clear_sources()
        step_counter = 0

        model_to_use = model or self.model
        formatted_message = self._format_user_message(message, mode, days)
        available_tools = self._get_available_tools(mode)

        input_messages = [{"role": "user", "content": formatted_message}]

        response = self.client.responses.create(
            model=model_to_use,
            instructions=SYSTEM_INSTRUCTIONS,
            input=input_messages,
            tools=available_tools,
            parallel_tool_calls=False,
            previous_response_id=previous_response_id,
        )

        current_response_id = response.id

        while True:
            function_calls = [
                item for item in response.output
                if item.type == "function_call"
            ]

            if not function_calls:
                break

            function_outputs = []
            for call in function_calls:
                step_counter += 1
                step_id = str(step_counter)
                tool_name = call.name
                args = json.loads(call.arguments)

                if tool_name in ("regs_search_documents", "govinfo_search") and "days" not in args:
                    args["days"] = days

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
                safe_result, image_message = self._prepare_tool_output(tool_name, result)

                label_override = None
                if tool_name == "search_pdf_memory":
                    label_override = self._format_pdf_search_label(
                        args.get("query", ""),
                        preview,
                    )

                yield {
                    "event": "step",
                    "data": {
                        "step_id": step_id,
                        "status": "done" if "error" not in safe_result else "error",
                        "result_preview": preview,
                        "label": label_override,
                    }
                }

                function_outputs.append({
                    "type": "function_call_output",
                    "call_id": call.call_id,
                    "output": json.dumps(safe_result),
                })
                if image_message:
                    function_outputs.append(image_message)

            response = self.client.responses.create(
                model=model_to_use,
                instructions=SYSTEM_INSTRUCTIONS,
                input=function_outputs,
                tools=available_tools,
                parallel_tool_calls=False,
                previous_response_id=current_response_id,
            )
            current_response_id = response.id

        final_text = ""
        for item in response.output:
            if item.type == "message":
                for content in item.content:
                    if content.type == "output_text":
                        text = content.text
                        chunk_size = 50
                        for i in range(0, len(text), chunk_size):
                            chunk = text[i:i + chunk_size]
                            yield {
                                "event": "assistant_delta",
                                "data": {"delta": chunk}
                            }
                            final_text += chunk
                            await asyncio.sleep(0.01)

        sources = self.tool_executor.get_collected_sources()

        yield {
            "event": "done",
            "data": {
                "answer_text": final_text,
                "sources": [s.model_dump() for s in sources],
                "response_id": current_response_id,
                "model": model_to_use,
            }
        }
