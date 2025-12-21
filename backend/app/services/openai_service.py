import asyncio
import json
import logging
import re
from typing import Optional, AsyncGenerator
from openai import OpenAI

from ..config import get_settings
from ..models.schemas import SourceItem, Step, SourceSelection
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
- Prefer domain-specific tools when relevant; do not default to just Regulations.gov / GovInfo.
- Use regs_search_documents / regs_search_dockets for rulemaking, proposed/final rules, dockets, and comments.
- Use govinfo_search for official publications (incl. Federal Register) and broad gov publications.
- Use federal_register_search specifically for Federal Register items (rules, proposed rules, notices, presidential documents).
- Use congress_search_bills / congress_search_votes for legislation and roll call votes.
- Use usaspending_search for contracts, grants, awards, recipients, and funding flows.
- Use fiscal_data_query for Treasury Fiscal Data (debt, receipts, outlays, interest rates).
- Use datagov_search for datasets on data.gov and open data catalogs.
- Use doj_search for DOJ press releases and news.
- Use searchgov_search for broad search across government websites (when configured).
- Respect the user's time window by setting the 'days' parameter on any tool that supports it (when applicable).

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

SOURCE_DISPLAY_NAMES: dict[str, str] = {
    "regulations": "Regulations.gov",
    "govinfo": "GovInfo",
    "congress": "Congress.gov",
    "federal_register": "Federal Register",
    "usaspending": "USAspending.gov",
    "fiscal_data": "Treasury Fiscal Data",
    "datagov": "data.gov",
    "doj": "DOJ",
    "searchgov": "Search.gov",
}

TOOL_TO_SOURCE: dict[str, Optional[str]] = {
    "regs_search_documents": "regulations",
    "regs_search_dockets": "regulations",
    "regs_get_document": "regulations",
    "regs_read_document_content": "regulations",
    "govinfo_search": "govinfo",
    "govinfo_package_summary": "govinfo",
    "govinfo_read_package_content": "govinfo",
    "congress_search_bills": "congress",
    "congress_search_votes": "congress",
    "federal_register_search": "federal_register",
    "usaspending_search": "usaspending",
    "fiscal_data_query": "fiscal_data",
    "datagov_search": "datagov",
    "doj_search": "doj",
    "searchgov_search": "searchgov",
    "fetch_url_content": None,
    "search_pdf_memory": None,
}

TOOLS_WITH_DAYS_PARAM = {
    "regs_search_documents",
    "govinfo_search",
    "federal_register_search",
    "usaspending_search",
    "doj_search",
}

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
    },
    {
        "type": "function",
        "name": "congress_search_bills",
        "description": "Search Congress.gov for bills and legislation. Returns bill titles, numbers, sponsors, and status.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search keywords for bills (e.g., 'immigration reform', 'tax credit')"
                },
                "congress": {
                    "type": "integer",
                    "description": "Congress number (e.g., 118 for 118th Congress). Defaults to current.",
                },
                "limit": {
                    "type": "integer",
                    "description": "Number of results to return",
                    "default": 10
                }
            },
            "required": ["query"]
        }
    },
    {
        "type": "function",
        "name": "congress_search_votes",
        "description": "Search Congress.gov for roll call votes. Returns vote results and which members voted yea/nay.",
        "parameters": {
            "type": "object",
            "properties": {
                "chamber": {
                    "type": "string",
                    "description": "Congressional chamber: 'house' or 'senate'",
                    "enum": ["house", "senate"],
                    "default": "house"
                },
                "congress": {
                    "type": "integer",
                    "description": "Congress number (defaults to 118)",
                },
                "limit": {
                    "type": "integer",
                    "description": "Number of results",
                    "default": 10
                }
            },
            "required": []
        }
    },
    {
        "type": "function",
        "name": "federal_register_search",
        "description": "Search the Federal Register for rules, proposed rules, notices, and presidential documents. No API key required.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search keywords"
                },
                "document_type": {
                    "type": "string",
                    "description": "Filter by type: RULE, PRORULE (proposed rule), NOTICE, or PRESDOCU (presidential)",
                    "enum": ["RULE", "PRORULE", "NOTICE", "PRESDOCU"]
                },
                "days": {
                    "type": "integer",
                    "description": "Number of days to look back",
                    "default": 30
                },
                "limit": {
                    "type": "integer",
                    "description": "Number of results",
                    "default": 10
                }
            },
            "required": ["query"]
        }
    },
    {
        "type": "function",
        "name": "usaspending_search",
        "description": "Search USAspending.gov for federal spending, contracts, grants, and awards. Returns a markdown summary suitable for analysis.",
        "parameters": {
            "type": "object",
            "properties": {
                "keywords": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Search keywords (e.g., ['defense', 'aircraft'])"
                },
                "agency": {
                    "type": "string",
                    "description": "Filter by awarding agency name"
                },
                "award_type": {
                    "type": "string",
                    "description": "Type of award: 'contracts', 'grants', 'loans', or 'direct_payments'",
                    "enum": ["contracts", "grants", "loans", "direct_payments"]
                },
                "days": {
                    "type": "integer",
                    "description": "Number of days to look back",
                    "default": 365
                },
                "limit": {
                    "type": "integer",
                    "description": "Number of results",
                    "default": 10
                }
            },
            "required": ["award_type"]
        }
    },
    {
        "type": "function",
        "name": "fiscal_data_query",
        "description": "Query Treasury Fiscal Data API for debt, interest rates, receipts, and outlays. Returns a markdown summary.",
        "parameters": {
            "type": "object",
            "properties": {
                "dataset": {
                    "type": "string",
                    "description": "Dataset to query",
                    "enum": ["debt_to_penny", "interest_rates", "monthly_receipts", "monthly_outlays"],
                    "default": "debt_to_penny"
                },
                "limit": {
                    "type": "integer",
                    "description": "Number of records",
                    "default": 10
                }
            },
            "required": []
        }
    },
    {
        "type": "function",
        "name": "datagov_search",
        "description": "Search data.gov for government datasets. Returns dataset titles, descriptions, and resource links.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search keywords (e.g., 'climate data', 'census')"
                },
                "organization": {
                    "type": "string",
                    "description": "Filter by organization/agency"
                },
                "format": {
                    "type": "string",
                    "description": "Filter by resource format (CSV, JSON, PDF, etc.)"
                },
                "limit": {
                    "type": "integer",
                    "description": "Number of results",
                    "default": 10
                }
            },
            "required": ["query"]
        }
    },
    {
        "type": "function",
        "name": "doj_search",
        "description": "Search Department of Justice press releases and news.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search keywords"
                },
                "component": {
                    "type": "string",
                    "description": "DOJ component (e.g., 'fbi', 'dea', 'civil-rights')"
                },
                "days": {
                    "type": "integer",
                    "description": "Number of days to look back",
                    "default": 30
                },
                "limit": {
                    "type": "integer",
                    "description": "Number of results",
                    "default": 10
                }
            },
            "required": []
        }
    },
    {
        "type": "function",
        "name": "searchgov_search",
        "description": "Search across government websites using Search.gov. Only available if configured with SEARCHGOV_AFFILIATE and SEARCHGOV_ACCESS_KEY.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search keywords"
                },
                "limit": {
                    "type": "integer",
                    "description": "Number of results",
                    "default": 10
                }
            },
            "required": ["query"]
        }
    }
]



class OpenAIService:
    def __init__(
        self,
        session_id: Optional[str] = None,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
    ):
        settings = get_settings()
        effective_api_key = api_key or settings.openai_api_key
        if base_url:
            self.client = OpenAI(api_key=effective_api_key, base_url=base_url)
        else:
            self.client = OpenAI(api_key=effective_api_key)
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

    def _extract_json_object(self, text: str) -> Optional[dict]:
        if not text:
            return None
        text = text.strip()
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
    ) -> tuple[set[str], Optional[str]]:
        if not allowed_sources:
            return set(), None
        if len(allowed_sources) == 1:
            return set(allowed_sources), "Only one source available."

        options_text = "\n".join(
            f"- {key}: {SOURCE_DISPLAY_NAMES[key]}"
            for key in sorted(allowed_sources)
        )

        rubric = """Routing guidance (choose all that apply):
- regulations: rulemakings, dockets, proposed/final rules, CFR changes, agency regulatory actions
- govinfo: official publications, broad federal documents; good companion for regulations/federal register
- federal_register: rules/notices/presidential documents specifically in the Federal Register
- congress: bills, legislation status, roll call votes, sponsors, committees
- usaspending: federal awards/contracts/grants, recipients, agencies, award totals
- fiscal_data: Treasury fiscal time series (debt, receipts, outlays, interest rates)
- datagov: datasets, open data resources, data catalog discovery
- doj: DOJ press releases, enforcement announcements, investigations (public-facing)
- searchgov: broad web search across .gov sites (when query is broad or agency-specific web pages are needed)"""

        selector_messages = [
            {
                "role": "system",
                "content": (
                    "You route user queries to the most relevant data sources. "
                    "Use the routing guidance and choose the sources most likely to contain authoritative results. "
                    "Return STRICT JSON only: {\"sources\": [\"source_key\", ...], \"rationale\": \"short\"}. "
                    "Choose 1-6 sources; choose fewer when the query is narrow. Only choose from the allowed list."
                ),
            },
            {
                "role": "user",
                "content": f"User query: {message}\n\nAllowed sources:\n{options_text}\n\n{rubric}",
            },
        ]

        try:
            response = self.client.chat.completions.create(
                model=model_to_use,
                messages=selector_messages,
                temperature=0,
                max_tokens=200,
            )

            raw = response.choices[0].message.content or ""
            data = self._extract_json_object(raw) or {}
            chosen = [
                s for s in (data.get("sources") or [])
                if isinstance(s, str) and s in allowed_sources
            ]
            chosen_sources = set(chosen[:6])
            rationale = data.get("rationale")
            return chosen_sources, rationale if isinstance(rationale, str) else None
        except Exception as exc:
            logger.warning("Auto source selection failed; falling back to heuristics: %s", exc)

        msg = message.lower()
        picks: list[str] = []
        if any(k in msg for k in ["bill", "hr", "h.r.", "s.", "senate", "house", "congress", "roll call", "vote"]):
            picks.append("congress")
        if any(k in msg for k in ["federal register", "fr ", "presidential", "executive order"]):
            picks.append("federal_register")
            picks.append("govinfo")
        if any(k in msg for k in ["spending", "contract", "grant", "award", "procurement", "usaspending"]):
            picks.append("usaspending")
        if any(k in msg for k in ["debt", "deficit", "receipts", "outlays", "treasury", "interest rate"]):
            picks.append("fiscal_data")
        if any(k in msg for k in ["dataset", "data.gov", "csv", "open data"]):
            picks.append("datagov")
        if any(k in msg for k in ["doj", "justice department", "press release", "indictment"]):
            picks.append("doj")
        if any(k in msg for k in ["regulation", "rulemaking", "proposed rule", "final rule", "docket", "cfr"]):
            picks.append("regulations")
            picks.append("govinfo")

        fallback = [p for p in picks if p in allowed_sources]
        if not fallback:
            fallback = [p for p in ["regulations", "govinfo"] if p in allowed_sources]
        if not fallback:
            fallback = list(sorted(allowed_sources))[:2]

        return set(fallback[:4]), "Heuristic fallback."

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

    def _convert_tools_for_chat_completions(self, tools: list[dict]) -> list[dict]:
        converted = []
        for tool in tools:
            converted.append({
                "type": "function",
                "function": {
                    "name": tool["name"],
                    "description": tool.get("description", ""),
                    "parameters": tool.get("parameters", {"type": "object", "properties": {}})
                }
            })
        return converted

    async def chat_completions(
        self,
        message: str,
        mode: str,
        days: int,
        model: Optional[str] = None,
        sources: Optional[SourceSelection] = None,
    ) -> tuple[str, list[SourceItem], Optional[str], list[Step], str, str]:
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
        chat_tools = self._convert_tools_for_chat_completions(available_tools)

        messages = [
            {"role": "system", "content": SYSTEM_INSTRUCTIONS},
            {"role": "user", "content": formatted_message}
        ]

        response = self.client.chat.completions.create(
            model=model_to_use,
            messages=messages,
            tools=chat_tools if chat_tools else None,
            tool_choice="auto" if chat_tools else None,
        )

        reasoning_summary = None

        while response.choices[0].message.tool_calls:
            tool_calls = response.choices[0].message.tool_calls
            messages.append(response.choices[0].message)

            for call in tool_calls:
                step_counter += 1
                step_id = str(step_counter)
                tool_name = call.function.name
                args = json.loads(call.function.arguments)

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
                safe_result, _ = self._prepare_tool_output(tool_name, result)

                step.status = "done" if "error" not in safe_result else "error"
                step.result_preview = preview
                if tool_name == "search_pdf_memory":
                    step.label = self._format_pdf_search_label(args.get("query", ""), preview)

                messages.append({
                    "role": "tool",
                    "tool_call_id": call.id,
                    "content": json.dumps(safe_result),
                })

            response = self.client.chat.completions.create(
                model=model_to_use,
                messages=messages,
                tools=chat_tools if chat_tools else None,
                tool_choice="auto" if chat_tools else None,
            )

        answer_text = response.choices[0].message.content or ""
        sources = self.tool_executor.get_collected_sources()

        return answer_text, sources, reasoning_summary, steps, response.id or "", model_to_use

    async def chat_completions_stream(
        self,
        message: str,
        mode: str,
        days: int,
        model: Optional[str] = None,
        sources: Optional[SourceSelection] = None,
    ) -> AsyncGenerator[dict, None]:
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
        chat_tools = self._convert_tools_for_chat_completions(available_tools)

        messages = [
            {"role": "system", "content": SYSTEM_INSTRUCTIONS},
            {"role": "user", "content": formatted_message}
        ]

        response = self.client.chat.completions.create(
            model=model_to_use,
            messages=messages,
            tools=chat_tools if chat_tools else None,
            tool_choice="auto" if chat_tools else None,
        )

        while response.choices[0].message.tool_calls:
            tool_calls = response.choices[0].message.tool_calls
            messages.append(response.choices[0].message)

            for call in tool_calls:
                step_counter += 1
                step_id = str(step_counter)
                tool_name = call.function.name
                args = json.loads(call.function.arguments)

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
                safe_result, _ = self._prepare_tool_output(tool_name, result)

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

                messages.append({
                    "role": "tool",
                    "tool_call_id": call.id,
                    "content": json.dumps(safe_result),
                })

            response = self.client.chat.completions.create(
                model=model_to_use,
                messages=messages,
                tools=chat_tools if chat_tools else None,
                tool_choice="auto" if chat_tools else None,
            )

        final_text = response.choices[0].message.content or ""
        chunk_size = 50
        for i in range(0, len(final_text), chunk_size):
            chunk = final_text[i:i + chunk_size]
            yield {
                "event": "assistant_delta",
                "data": {"delta": chunk}
            }
            await asyncio.sleep(0.01)

        sources = self.tool_executor.get_collected_sources()

        yield {
            "event": "done",
            "data": {
                "answer_text": final_text,
                "sources": [s.model_dump() for s in sources],
                "response_id": response.id or "",
                "model": model_to_use,
            }
        }

    async def chat(
        self,
        message: str,
        mode: str,
        days: int,
        model: Optional[str] = None,
        sources: Optional[SourceSelection] = None,
        previous_response_id: Optional[str] = None,
    ) -> tuple[str, list[SourceItem], Optional[str], list[Step], str, str]:
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
        sources: Optional[SourceSelection] = None,
        previous_response_id: Optional[str] = None,
    ) -> AsyncGenerator[dict, None]:
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
