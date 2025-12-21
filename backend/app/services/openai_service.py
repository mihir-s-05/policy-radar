import asyncio
import json
import logging
from typing import Optional, AsyncGenerator
from openai import OpenAI

from ..config import get_settings
from ..models.schemas import SourceItem, Step
from .tool_executor import ToolExecutor, get_tool_label

logger = logging.getLogger(__name__)

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
    }
]


class OpenAIService:
    def __init__(self):
        settings = get_settings()
        self.client = OpenAI(api_key=settings.openai_api_key)
        self.model = settings.openai_model
        self.tool_executor = ToolExecutor()

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

        if mode == "regulations":
            regs_tools = [t for t in TOOLS if t["name"].startswith("regs_")]
            return regs_tools + fetch_url_tool
        elif mode == "govinfo":
            govinfo_tools = [t for t in TOOLS if t["name"].startswith("govinfo_")]
            return govinfo_tools + fetch_url_tool
        else:
            return TOOLS

    async def chat(
        self,
        message: str,
        mode: str,
        days: int,
        previous_response_id: Optional[str] = None,
    ) -> tuple[str, list[SourceItem], Optional[str], list[Step], str]:
        self.tool_executor.clear_sources()
        steps: list[Step] = []
        step_counter = 0

        formatted_message = self._format_user_message(message, mode, days)
        available_tools = self._get_available_tools(mode)

        input_messages = [{"role": "user", "content": formatted_message}]

        response = self.client.responses.create(
            model=self.model,
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

                step.status = "done" if "error" not in result else "error"
                step.result_preview = preview

                function_outputs.append({
                    "type": "function_call_output",
                    "call_id": call.call_id,
                    "output": json.dumps(result),
                })

            response = self.client.responses.create(
                model=self.model,
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

        return answer_text, sources, reasoning_summary, steps, current_response_id

    async def chat_stream(
        self,
        message: str,
        mode: str,
        days: int,
        previous_response_id: Optional[str] = None,
    ) -> AsyncGenerator[dict, None]:
        self.tool_executor.clear_sources()
        step_counter = 0

        formatted_message = self._format_user_message(message, mode, days)
        available_tools = self._get_available_tools(mode)

        input_messages = [{"role": "user", "content": formatted_message}]

        response = self.client.responses.create(
            model=self.model,
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

                yield {
                    "event": "step",
                    "data": {
                        "step_id": step_id,
                        "status": "done" if "error" not in result else "error",
                        "result_preview": preview,
                    }
                }

                function_outputs.append({
                    "type": "function_call_output",
                    "call_id": call.call_id,
                    "output": json.dumps(result),
                })

            response = self.client.responses.create(
                model=self.model,
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
            }
        }
