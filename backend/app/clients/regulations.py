import logging
from typing import Optional
from datetime import datetime, timedelta

from .base import BaseAPIClient
from ..config import get_settings
from ..models.schemas import SourceItem

logger = logging.getLogger(__name__)


class RegulationsClient(BaseAPIClient):
    def __init__(self):
        settings = get_settings()
        super().__init__(base_url=settings.regulations_base_url)
        self.api_key = settings.gov_api_key

    def _get_headers(self) -> dict:
        return {
            "X-Api-Key": self.api_key,
            "Accept": "application/json",
        }

    def _normalize_document(self, doc: dict) -> SourceItem:
        attrs = doc.get("attributes", {})
        doc_id = doc.get("id", "")

        url = f"https://www.regulations.gov/document/{doc_id}"

        return SourceItem(
            source_type="regulations_document",
            id=doc_id,
            title=attrs.get("title", "Untitled Document"),
            agency=attrs.get("agencyId"),
            date=attrs.get("postedDate"),
            url=url,
            excerpt=attrs.get("summary") or attrs.get("abstract"),
        )

    def _normalize_docket(self, docket: dict) -> SourceItem:
        attrs = docket.get("attributes", {})
        docket_id = docket.get("id", "")

        url = f"https://www.regulations.gov/docket/{docket_id}"

        return SourceItem(
            source_type="regulations_docket",
            id=docket_id,
            title=attrs.get("title", "Untitled Docket"),
            agency=attrs.get("agencyId"),
            date=attrs.get("lastModifiedDate") or attrs.get("modifyDate"),
            url=url,
            excerpt=attrs.get("abstract") or attrs.get("summary"),
        )

    async def search_documents(
        self,
        search_term: str,
        date_ge: Optional[str] = None,
        date_le: Optional[str] = None,
        sort: str = "-postedDate",
        page_size: int = 10,
        page_number: int = 1,
    ) -> tuple[list[dict], list[SourceItem]]:
        params = {
            "filter[searchTerm]": search_term,
            "sort": sort,
            "page[size]": page_size,
            "page[number]": page_number,
        }

        if date_ge:
            params["filter[postedDate][ge]"] = date_ge
        if date_le:
            params["filter[postedDate][le]"] = date_le

        url = f"{self.base_url}/documents"
        logger.info(f"Searching Regulations.gov documents: {search_term}")

        data = await self._request_with_retry(
            method="GET",
            url=url,
            headers=self._get_headers(),
            params=params,
        )

        documents = data.get("data", [])
        sources = [self._normalize_document(doc) for doc in documents]

        return documents, sources

    async def get_document(
        self, document_id: str, include_attachments: bool = False
    ) -> tuple[dict, SourceItem]:
        params = {}
        if include_attachments:
            params["include"] = "attachments"

        url = f"{self.base_url}/documents/{document_id}"
        logger.info(f"Fetching Regulations.gov document: {document_id}")

        data = await self._request_with_retry(
            method="GET",
            url=url,
            headers=self._get_headers(),
            params=params if params else None,
        )

        doc = data.get("data", {})
        source = self._normalize_document(doc)

        return doc, source

    async def search_dockets(
        self,
        search_term: str,
        sort: str = "-lastModifiedDate",
        page_size: int = 10,
        page_number: int = 1,
    ) -> tuple[list[dict], list[SourceItem]]:
        params = {
            "filter[searchTerm]": search_term,
            "sort": sort,
            "page[size]": page_size,
            "page[number]": page_number,
        }

        url = f"{self.base_url}/dockets"
        logger.info(f"Searching Regulations.gov dockets: {search_term}")

        data = await self._request_with_retry(
            method="GET",
            url=url,
            headers=self._get_headers(),
            params=params,
        )

        dockets = data.get("data", [])
        sources = [self._normalize_docket(docket) for docket in dockets]

        return dockets, sources

    async def get_docket(self, docket_id: str) -> tuple[dict, SourceItem]:
        url = f"{self.base_url}/dockets/{docket_id}"
        logger.info(f"Fetching Regulations.gov docket: {docket_id}")

        data = await self._request_with_retry(
            method="GET",
            url=url,
            headers=self._get_headers(),
        )

        docket = data.get("data", {})
        source = self._normalize_docket(docket)

        return docket, source


def get_date_range(days: int) -> tuple[str, str]:
    end_date = datetime.now()
    start_date = end_date - timedelta(days=days)
    return start_date.strftime("%Y-%m-%d"), end_date.strftime("%Y-%m-%d")
