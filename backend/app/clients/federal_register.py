import logging
from typing import Optional
from datetime import datetime, timedelta

from .base import BaseAPIClient
from ..config import get_settings
from ..models.schemas import SourceItem

logger = logging.getLogger(__name__)


class FederalRegisterClient(BaseAPIClient):
    def __init__(self):
        settings = get_settings()
        super().__init__(base_url=settings.federal_register_base_url)

    def _normalize_document(self, doc: dict) -> SourceItem:
        return SourceItem(
            source_type="federal_register",
            id=doc.get("document_number", ""),
            title=doc.get("title", "Untitled Document"),
            agency=", ".join(
                a.get("name", "")
                for a in doc.get("agencies", [])
                if a.get("name")
            ) or None,
            date=doc.get("publication_date"),
            url=doc.get("html_url", ""),
            excerpt=doc.get("abstract"),
            pdf_url=doc.get("pdf_url"),
            content_type=doc.get("type"),
            raw=doc,
        )

    async def search_documents(
        self,
        query: str,
        document_type: Optional[str] = None,
        agency: Optional[str] = None,
        days: Optional[int] = None,
        per_page: int = 10,
        page: int = 1,
    ) -> tuple[list[dict], list[SourceItem]]:
        params = {
            "conditions[term]": query,
            "per_page": min(per_page, 1000),
            "page": page,
            "order": "newest",
        }

        if document_type:
            params["conditions[type][]"] = document_type

        if agency:
            params["conditions[agencies][]"] = agency

        if days:
            end_date = datetime.now()
            start_date = end_date - timedelta(days=days)
            params["conditions[publication_date][gte]"] = start_date.strftime("%Y-%m-%d")

        url = f"{self.base_url}/documents.json"
        logger.info(f"Searching Federal Register: {query}")

        data = await self._request_with_retry(
            method="GET",
            url=url,
            params=params,
        )

        documents = data.get("results", [])
        sources = [self._normalize_document(doc) for doc in documents]

        return documents, sources

    async def get_document(self, document_number: str) -> tuple[Optional[dict], Optional[SourceItem]]:
        url = f"{self.base_url}/documents/{document_number}.json"
        logger.info(f"Fetching Federal Register document: {document_number}")

        data = await self._request_with_retry(
            method="GET",
            url=url,
        )

        if data:
            return data, self._normalize_document(data)
        return None, None
