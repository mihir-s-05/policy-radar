import json
import logging
import re
from typing import Optional

from ..clients.regulations import RegulationsClient, get_date_range
from ..clients.govinfo import GovInfoClient, build_govinfo_query
from ..clients.web_fetcher import WebFetcher
from ..models.schemas import SourceItem, Step
from .pdf_memory import get_pdf_memory_store

logger = logging.getLogger(__name__)


class ToolExecutor:
    def __init__(self, session_id: Optional[str] = None):
        self.regulations_client = RegulationsClient()
        self.govinfo_client = GovInfoClient()
        self.web_fetcher = WebFetcher()
        self._all_sources: list[SourceItem] = []
        self.session_id = session_id
        self.pdf_memory = get_pdf_memory_store()
        self._max_tool_text_length = 20000

    def set_session(self, session_id: Optional[str]) -> None:
        self.session_id = session_id

    def _extract_regulations_document_id(self, url: str) -> Optional[str]:
        if not url:
            return None
        match = re.search(r"regulations\.gov/document/([^/?#]+)", url)
        if match:
            return match.group(1)
        return None

    def _should_index_pdf(self, data: dict) -> bool:
        if not data:
            return False
        if data.get("content_format") == "pdf":
            return True
        if data.get("content_type", "").lower().startswith("application/pdf"):
            return True
        if data.get("pdf_url"):
            return True
        if data.get("images"):
            return True
        return False

    async def _index_pdf_text(
        self,
        doc_key: str,
        text: str,
        source_url: Optional[str],
        source_type: str,
        pdf_url: Optional[str] = None,
        content_format: Optional[str] = None,
    ) -> None:
        if not self.session_id or not text:
            return
        text_to_index = text
        if pdf_url and content_format != "pdf":
            logger.info("Fetching PDF text for RAG indexing: %s", pdf_url)
            max_index_length = None
            if self.pdf_memory.settings.rag_max_chunks > 0:
                max_index_length = (
                    self.pdf_memory.settings.rag_max_chunks
                    * self.pdf_memory.settings.rag_chunk_size
                )
            pdf_data = await self.web_fetcher.fetch_url(
                url=pdf_url,
                max_length=max_index_length,
            )
            if pdf_data.get("text"):
                text_to_index = pdf_data.get("text", "")
        metadata = {
            "source_url": source_url,
            "source_type": source_type,
        }
        if pdf_url:
            metadata["pdf_url"] = pdf_url
        try:
            await self.pdf_memory.add_document(
                session_id=self.session_id,
                doc_key=doc_key,
                text=text_to_index,
                metadata=metadata,
            )
        except Exception as exc:
            logger.warning(
                "Failed to index PDF text for %s (%s): %s",
                doc_key,
                source_type,
                exc,
            )

    def get_collected_sources(self) -> list[SourceItem]:
        return self._all_sources

    def clear_sources(self):
        self._all_sources = []

    async def execute_tool(
        self, tool_name: str, args: dict
    ) -> tuple[dict, Optional[dict]]:
        logger.info(f"Executing tool: {tool_name} with args: {args}")

        try:
            if tool_name == "regs_search_documents":
                return await self._exec_regs_search_documents(args)
            elif tool_name == "regs_search_dockets":
                return await self._exec_regs_search_dockets(args)
            elif tool_name == "regs_get_document":
                return await self._exec_regs_get_document(args)
            elif tool_name == "regs_read_document_content":
                return await self._exec_regs_read_document_content(args)
            elif tool_name == "govinfo_search":
                return await self._exec_govinfo_search(args)
            elif tool_name == "govinfo_package_summary":
                return await self._exec_govinfo_package_summary(args)
            elif tool_name == "govinfo_read_package_content":
                return await self._exec_govinfo_read_package_content(args)
            elif tool_name == "fetch_url_content":
                return await self._exec_fetch_url_content(args)
            elif tool_name == "search_pdf_memory":
                return await self._exec_search_pdf_memory(args)
            else:
                return {"error": f"Unknown tool: {tool_name}"}, None

        except Exception as e:
            logger.exception(f"Error executing tool {tool_name}")
            return {"error": str(e)}, {"error": str(e)}

    async def _exec_regs_search_documents(
        self, args: dict
    ) -> tuple[dict, dict]:
        search_term = args.get("search_term", "")
        days = args.get("days", 30)
        page_size = args.get("page_size", 10)

        date_ge, date_le = get_date_range(days)

        documents, sources = await self.regulations_client.search_documents(
            search_term=search_term,
            date_ge=date_ge,
            date_le=date_le,
            page_size=page_size,
        )

        self._all_sources.extend(sources)

        result = {
            "count": len(documents),
            "date_range": {"from": date_ge, "to": date_le},
            "documents": [
                {
                    "id": doc.get("id"),
                    "title": doc.get("attributes", {}).get("title"),
                    "agency": doc.get("attributes", {}).get("agencyId"),
                    "posted_date": doc.get("attributes", {}).get("postedDate"),
                    "document_type": doc.get("attributes", {}).get("documentType"),
                    "url": f"https://www.regulations.gov/document/{doc.get('id')}",
                }
                for doc in documents
            ],
        }

        preview = {
            "count": len(documents),
            "top_titles": [
                doc.get("attributes", {}).get("title", "")[:80]
                for doc in documents[:3]
            ],
        }

        return result, preview

    async def _exec_regs_search_dockets(self, args: dict) -> tuple[dict, dict]:
        search_term = args.get("search_term", "")
        page_size = args.get("page_size", 10)

        dockets, sources = await self.regulations_client.search_dockets(
            search_term=search_term,
            page_size=page_size,
        )

        self._all_sources.extend(sources)

        result = {
            "count": len(dockets),
            "dockets": [
                {
                    "id": docket.get("id"),
                    "title": docket.get("attributes", {}).get("title"),
                    "agency": docket.get("attributes", {}).get("agencyId"),
                    "last_modified": docket.get("attributes", {}).get("lastModifiedDate"),
                    "docket_type": docket.get("attributes", {}).get("docketType"),
                    "url": f"https://www.regulations.gov/docket/{docket.get('id')}",
                }
                for docket in dockets
            ],
        }

        preview = {
            "count": len(dockets),
            "top_titles": [
                docket.get("attributes", {}).get("title", "")[:80]
                for docket in dockets[:3]
            ],
        }

        return result, preview

    async def _exec_regs_get_document(self, args: dict) -> tuple[dict, dict]:
        document_id = args.get("document_id", "")
        include_attachments = args.get("include_attachments", False)

        doc, source = await self.regulations_client.get_document(
            document_id=document_id,
            include_attachments=include_attachments,
        )

        self._all_sources.append(source)

        attrs = doc.get("attributes", {})

        result = {
            "id": doc.get("id"),
            "title": attrs.get("title"),
            "agency": attrs.get("agencyId"),
            "posted_date": attrs.get("postedDate"),
            "document_type": attrs.get("documentType"),
            "summary": attrs.get("summary"),
            "abstract": attrs.get("abstract"),
            "url": f"https://www.regulations.gov/document/{document_id}",
        }

        if include_attachments and "included" in doc:
            result["attachments"] = [
                {
                    "title": att.get("attributes", {}).get("title"),
                    "format": att.get("attributes", {}).get("format"),
                }
                for att in doc.get("included", [])
            ]

        preview = {
            "title": attrs.get("title", "")[:80],
            "agency": attrs.get("agencyId"),
        }

        return result, preview

    async def _exec_govinfo_search(self, args: dict) -> tuple[dict, dict]:
        query = (args.get("query") or "").strip()
        keywords = (args.get("keywords") or "").strip()
        collection = args.get("collection")
        days = args.get("days")
        page_size = args.get("page_size", 10)

        base_query = query or keywords
        if not base_query:
            return {"error": "Missing search query."}, {"error": "Missing search query."}

        query = build_govinfo_query(
            base_query,
            collection=collection,
            days=days,
        )

        data, sources = await self.govinfo_client.search(
            query=query,
            page_size=page_size,
        )

        self._all_sources.extend(sources)

        results = data.get("results", [])

        result = {
            "count": len(results),
            "total_count": data.get("count", len(results)),
            "results": [
                {
                    "package_id": r.get("packageId"),
                    "title": r.get("title"),
                    "collection": r.get("collectionCode"),
                    "date": r.get("lastModified") or r.get("dateIssued"),
                    "url": f"https://www.govinfo.gov/app/details/{r.get('packageId')}",
                }
                for r in results
            ],
        }

        preview = {
            "count": len(results),
            "top_titles": [r.get("title", "")[:80] for r in results[:3]],
        }

        return result, preview

    async def _exec_govinfo_package_summary(self, args: dict) -> tuple[dict, dict]:
        package_id = args.get("package_id", "")

        data, source = await self.govinfo_client.get_package_summary(
            package_id=package_id
        )

        self._all_sources.append(source)

        result = {
            "package_id": data.get("packageId"),
            "title": data.get("title"),
            "collection": data.get("collectionCode"),
            "publisher": data.get("publisher"),
            "date_issued": data.get("dateIssued"),
            "last_modified": data.get("lastModified"),
            "abstract": data.get("abstract"),
            "description": data.get("description"),
            "url": f"https://www.govinfo.gov/app/details/{package_id}",
        }

        preview = {
            "title": data.get("title", "")[:80],
            "collection": data.get("collectionCode"),
        }

        return result, preview

    async def _exec_regs_read_document_content(self, args: dict) -> tuple[dict, dict]:
        document_id = args.get("document_id", "")

        data = await self.web_fetcher.fetch_regulations_document_content(
            document_id=document_id,
            max_length=15000,
        )

        if data.get("text") and self._should_index_pdf(data):
            await self._index_pdf_text(
                doc_key=document_id,
                text=data.get("text", ""),
                source_url=data.get("pdf_url") or data.get("url"),
                source_type="regulations_document",
                pdf_url=data.get("pdf_url"),
                content_format=data.get("content_format"),
            )

        source = SourceItem(
            source_type="regulations_document",
            id=document_id,
            title=data.get("title") or f"Document {document_id}",
            agency=None,
            date=None,
            url=f"https://www.regulations.gov/document/{document_id}",
            excerpt=data.get("text", "")[:200] if data.get("text") else None,
        )
        self._all_sources.append(source)

        result = {
            "document_id": document_id,
            "title": data.get("title"),
            "url": data.get("url"),
            "full_text": data.get("text"),
            "images": data.get("images"),
            "images_skipped": data.get("images_skipped"),
            "content_format": data.get("content_format"),
            "pdf_url": data.get("pdf_url"),
            "error": data.get("error"),
        }

        if data.get("text"):
            text_preview = data.get("text", "")[:150] + "..."
        elif data.get("images"):
            text_preview = f"{len(data.get('images', []))} images extracted"
        else:
            text_preview = "No content"
        preview = {
            "document_id": document_id,
            "text_length": len(data.get("text", "")),
            "image_count": len(data.get("images", []) or []),
            "preview": text_preview,
        }

        return result, preview

    async def _exec_govinfo_read_package_content(self, args: dict) -> tuple[dict, dict]:
        package_id = args.get("package_id", "")

        text, source, images, images_skipped, content_format, pdf_url = await self.govinfo_client.get_package_content(
            package_id=package_id,
            max_length=15000,
        )

        if text and (content_format == "pdf" or pdf_url or images):
            await self._index_pdf_text(
                doc_key=package_id,
                text=text,
                source_url=pdf_url or source.url,
                source_type="govinfo_package",
                pdf_url=pdf_url,
                content_format=content_format,
            )

        self._all_sources.append(source)

        result = {
            "package_id": package_id,
            "title": source.title,
            "url": source.url,
            "full_text": text,
            "images": images,
            "images_skipped": images_skipped,
            "content_format": content_format,
            "pdf_url": pdf_url,
        }

        if text:
            text_preview = text[:150] + "..." if len(text) > 150 else text
        elif images:
            text_preview = f"{len(images)} images extracted"
        else:
            text_preview = "No content"
        preview = {
            "package_id": package_id,
            "text_length": len(text),
            "image_count": len(images),
            "preview": text_preview,
        }

        return result, preview

    async def _exec_fetch_url_content(self, args: dict) -> tuple[dict, dict]:
        url = args.get("url", "")
        full_text = args.get("full_text", False)
        max_length = args.get("max_length", 15000)
        max_length_applied = None
        if not full_text:
            try:
                max_length = int(max_length)
            except (TypeError, ValueError):
                max_length = 15000
            if max_length <= 0:
                max_length = 15000
        else:
            try:
                max_length = int(max_length)
            except (TypeError, ValueError):
                max_length = self._max_tool_text_length
            if max_length <= 0:
                max_length = self._max_tool_text_length
            max_length = min(max_length, self._max_tool_text_length)
            max_length_applied = max_length

        document_id = self._extract_regulations_document_id(url)
        if document_id:
            logger.info(
                "Using Regulations.gov API fetch for document %s",
                document_id,
            )
            data = await self.web_fetcher.fetch_regulations_document_content(
                document_id=document_id,
                max_length=max_length,
            )
        else:
            data = await self.web_fetcher.fetch_url(url=url, max_length=max_length)

        if data.get("text") and self._should_index_pdf(data):
            await self._index_pdf_text(
                doc_key=url,
                text=data.get("text", ""),
                source_url=data.get("pdf_url") or url,
                source_type="url",
                pdf_url=data.get("pdf_url"),
                content_format=data.get("content_format"),
            )

        if data.get("text") or data.get("images"):
            source = SourceItem(
                source_type="govinfo_result",
                id=url,
                title=data.get("title") or url,
                agency=None,
                date=None,
                url=url,
                excerpt=data.get("text", "")[:200] if data.get("text") else None,
            )
            self._all_sources.append(source)

        result = {
            "url": url,
            "title": data.get("title"),
            "full_text": data.get("text"),
            "images": data.get("images"),
            "images_skipped": data.get("images_skipped"),
            "content_format": data.get("content_format"),
            "pdf_url": data.get("pdf_url"),
            "full_text_requested": full_text,
            "max_length_applied": max_length_applied,
            "error": data.get("error"),
        }

        if data.get("text"):
            text_preview = data.get("text", "")[:150] + "..."
        elif data.get("images"):
            text_preview = f"{len(data.get('images', []))} images extracted"
        else:
            text_preview = "No content"
        preview = {
            "url": url[:50],
            "text_length": len(data.get("text", "")),
            "image_count": len(data.get("images", []) or []),
            "preview": text_preview if not data.get("error") else data.get("error"),
        }

        return result, preview

    async def _exec_search_pdf_memory(self, args: dict) -> tuple[dict, dict]:
        query = (args.get("query") or "").strip()
        top_k = args.get("top_k")
        if top_k is not None:
            try:
                top_k = int(top_k)
            except (TypeError, ValueError):
                top_k = None

        if not self.session_id:
            return {"error": "PDF memory not available without a session."}, {"error": "Missing session"}
        if not query:
            return {"error": "Missing query."}, {"error": "Missing query"}

        matches = await self.pdf_memory.query(
            session_id=self.session_id,
            query_text=query,
            top_k=top_k,
        )
        logger.info(
            "PDF memory search for session %s: '%s' (%s matches)",
            self.session_id,
            query[:80],
            len(matches),
        )

        doc_summaries = []
        seen = set()
        for match in matches:
            meta = match.get("metadata") or {}
            doc_key = meta.get("doc_key")
            pdf_url = meta.get("pdf_url") or meta.get("source_url")
            source_type = meta.get("source_type")
            if not doc_key and not pdf_url:
                continue
            dedupe_key = f"{doc_key}|{pdf_url}|{source_type}"
            if dedupe_key in seen:
                continue
            seen.add(dedupe_key)
            doc_summaries.append(
                {
                    "doc_key": doc_key,
                    "pdf_url": pdf_url,
                    "source_type": source_type,
                }
            )
            if len(doc_summaries) >= 5:
                break

        result = {
            "query": query,
            "count": len(matches),
            "documents": doc_summaries,
            "matches": matches,
        }

        preview = {
            "query": query,
            "count": len(matches),
            "top_score": matches[0].get("score") if matches else None,
            "documents": doc_summaries,
        }

        return result, preview


def get_tool_label(tool_name: str, args: dict) -> str:
    labels = {
        "regs_search_documents": f"Search Regulations.gov documents: {args.get('search_term', '')}",
        "regs_search_dockets": f"Search Regulations.gov dockets: {args.get('search_term', '')}",
        "regs_get_document": f"Get document: {args.get('document_id', '')}",
        "regs_read_document_content": f"Read document content: {args.get('document_id', '')}",
        "govinfo_search": f"Search GovInfo: {args.get('query') or args.get('keywords', '')}",
        "govinfo_package_summary": f"Get package: {args.get('package_id', '')}",
        "govinfo_read_package_content": f"Read package content: {args.get('package_id', '')}",
        "fetch_url_content": f"Fetch URL: {args.get('url', '')[:50]}",
        "search_pdf_memory": f"Search PDF memory: {args.get('query', '')[:50]}",
    }
    return labels.get(tool_name, f"Execute: {tool_name}")
