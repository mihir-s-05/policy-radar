import json
import logging
from typing import Optional

from ..clients.regulations import RegulationsClient, get_date_range
from ..clients.govinfo import GovInfoClient, build_govinfo_query
from ..clients.web_fetcher import WebFetcher
from ..models.schemas import SourceItem, Step

logger = logging.getLogger(__name__)


class ToolExecutor:
    def __init__(self):
        self.regulations_client = RegulationsClient()
        self.govinfo_client = GovInfoClient()
        self.web_fetcher = WebFetcher()
        self._all_sources: list[SourceItem] = []

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
            "error": data.get("error"),
        }

        text_preview = data.get("text", "")[:150] + "..." if data.get("text") else "No content"
        preview = {
            "document_id": document_id,
            "text_length": len(data.get("text", "")),
            "preview": text_preview,
        }

        return result, preview

    async def _exec_govinfo_read_package_content(self, args: dict) -> tuple[dict, dict]:
        package_id = args.get("package_id", "")

        text, source = await self.govinfo_client.get_package_content(
            package_id=package_id,
            max_length=15000,
        )

        self._all_sources.append(source)

        result = {
            "package_id": package_id,
            "title": source.title,
            "url": source.url,
            "full_text": text,
        }

        text_preview = text[:150] + "..." if len(text) > 150 else text
        preview = {
            "package_id": package_id,
            "text_length": len(text),
            "preview": text_preview,
        }

        return result, preview

    async def _exec_fetch_url_content(self, args: dict) -> tuple[dict, dict]:
        url = args.get("url", "")
        full_text = args.get("full_text", False)
        max_length = args.get("max_length", 15000)
        if not full_text:
            try:
                max_length = int(max_length)
            except (TypeError, ValueError):
                max_length = 15000
            if max_length <= 0:
                max_length = 15000
        else:
            max_length = None

        data = await self.web_fetcher.fetch_url(url=url, max_length=max_length)

        if data.get("text"):
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
            "error": data.get("error"),
        }

        text_preview = data.get("text", "")[:150] + "..." if data.get("text") else "No content"
        preview = {
            "url": url[:50],
            "text_length": len(data.get("text", "")),
            "preview": text_preview if not data.get("error") else data.get("error"),
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
    }
    return labels.get(tool_name, f"Execute: {tool_name}")
