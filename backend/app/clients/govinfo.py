import logging
import re
from typing import Optional
from datetime import datetime, timedelta

from .base import BaseAPIClient
from ..config import get_settings
from ..models.schemas import SourceItem

logger = logging.getLogger(__name__)


def html_to_text(html: str, max_length: int = 15000) -> str:
    html = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r'<style[^>]*>.*?</style>', '', html, flags=re.DOTALL | re.IGNORECASE)

    html = re.sub(r'</(p|div|h[1-6]|li|tr|br)[^>]*>', '\n', html, flags=re.IGNORECASE)
    html = re.sub(r'<(br|hr)[^>]*/?>', '\n', html, flags=re.IGNORECASE)

    text = re.sub(r'<[^>]+>', '', html)

    text = text.replace('&nbsp;', ' ')
    text = text.replace('&amp;', '&')
    text = text.replace('&lt;', '<')
    text = text.replace('&gt;', '>')
    text = text.replace('&quot;', '"')
    text = text.replace('&#39;', "'")

    text = re.sub(r'[ \t]+', ' ', text)
    text = re.sub(r'\n\s*\n', '\n\n', text)
    text = text.strip()

    if len(text) > max_length:
        text = text[:max_length] + "\n\n[Content truncated due to length...]"

    return text


class GovInfoClient(BaseAPIClient):
    def __init__(self):
        settings = get_settings()
        super().__init__(base_url=settings.govinfo_base_url)
        self.api_key = settings.gov_api_key

    def _add_api_key(self, params: Optional[dict] = None) -> dict:
        params = params or {}
        params["api_key"] = self.api_key
        return params

    def _normalize_search_result(self, result: dict) -> SourceItem:
        package_id = result.get("packageId", "")
        title = result.get("title", "Untitled")

        url = f"https://www.govinfo.gov/app/details/{package_id}"
        if result.get("granuleId"):
            url = f"https://www.govinfo.gov/app/details/{package_id}/{result['granuleId']}"

        date = result.get("lastModified") or result.get("dateIssued")

        agency = None
        if result.get("governmentAuthor"):
            authors = result.get("governmentAuthor", [])
            if isinstance(authors, list) and authors:
                agency = authors[0]
            elif isinstance(authors, str):
                agency = authors

        return SourceItem(
            source_type="govinfo_result",
            id=package_id,
            title=title,
            agency=agency,
            date=date,
            url=url,
            excerpt=result.get("abstract") or result.get("description"),
        )

    def _normalize_package(self, package: dict) -> SourceItem:
        package_id = package.get("packageId", "")
        title = package.get("title", "Untitled Package")

        url = f"https://www.govinfo.gov/app/details/{package_id}"

        return SourceItem(
            source_type="govinfo_package",
            id=package_id,
            title=title,
            agency=package.get("publisher"),
            date=package.get("lastModified") or package.get("dateIssued"),
            url=url,
            excerpt=package.get("abstract") or package.get("description"),
        )

    async def search(
        self,
        query: str,
        page_size: int = 10,
        offset_mark: str = "*",
        sorts: Optional[list[dict]] = None,
    ) -> tuple[dict, list[SourceItem]]:
        if sorts is None:
            sorts = [{"field": "lastModified", "sortOrder": "DESC"}]

        url = f"{self.base_url}/search"
        params = self._add_api_key()

        body = {
            "query": query,
            "pageSize": str(page_size),
            "offsetMark": offset_mark,
            "sorts": sorts,
        }

        logger.info(f"Searching GovInfo: {query}")

        data = await self._request_with_retry(
            method="POST",
            url=url,
            params=params,
            json=body,
            use_cache=False,
        )

        results = data.get("results", [])
        sources = [self._normalize_search_result(r) for r in results]

        return data, sources

    async def get_package_summary(
        self, package_id: str
    ) -> tuple[dict, SourceItem]:
        url = f"{self.base_url}/packages/{package_id}/summary"
        params = self._add_api_key()

        logger.info(f"Fetching GovInfo package: {package_id}")

        data = await self._request_with_retry(
            method="GET",
            url=url,
            params=params,
        )

        source = self._normalize_package(data)

        return data, source

    async def get_package_content(
        self, package_id: str, max_length: int = 15000
    ) -> tuple[str, SourceItem]:
        summary, source = await self.get_package_summary(package_id)

        url = f"{self.base_url}/packages/{package_id}/htm"
        params = self._add_api_key()

        logger.info(f"Fetching GovInfo package content: {package_id}")

        try:
            import httpx
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.get(url, params=params)

                if response.status_code == 200:
                    content_type = response.headers.get("content-type", "")
                    if "html" in content_type or "text" in content_type:
                        text = html_to_text(response.text, max_length)
                        return text, source

                xml_url = f"{self.base_url}/packages/{package_id}/xml"
                response = await client.get(xml_url, params=params)

                if response.status_code == 200:
                    text = html_to_text(response.text, max_length)
                    return text, source

        except Exception as e:
            logger.warning(f"Could not fetch content for {package_id}: {e}")

        fallback = summary.get("abstract") or summary.get("description") or "No content available."
        return fallback, source

    async def get_collection(
        self,
        collection_code: str,
        start_datetime: Optional[str] = None,
        page_size: int = 10,
        offset_mark: str = "*",
    ) -> tuple[dict, list[SourceItem]]:
        if start_datetime is None:
            start = datetime.utcnow() - timedelta(days=30)
            start_datetime = start.strftime("%Y-%m-%dT%H:%M:%SZ")

        url = f"{self.base_url}/collections/{collection_code}/{start_datetime}"
        params = self._add_api_key({
            "pageSize": page_size,
            "offsetMark": offset_mark,
        })

        logger.info(f"Fetching GovInfo collection: {collection_code}")

        data = await self._request_with_retry(
            method="GET",
            url=url,
            params=params,
        )

        packages = data.get("packages", [])
        sources = [self._normalize_package(p) for p in packages]

        return data, sources


def build_govinfo_query(
    keywords: str,
    collection: Optional[str] = None,
    days: Optional[int] = None,
) -> str:
    keywords = (keywords or "").strip()
    parts = []
    lowered = keywords.lower()

    if collection and "collection:" not in lowered:
        parts.append(f"collection:{collection}")

    if keywords:
        parts.append(keywords)

    if days and "publishdate:range" not in lowered and "dateissued:range" not in lowered:
        start_date = (datetime.utcnow() - timedelta(days=days)).strftime("%Y-%m-%d")
        parts.append(f"publishdate:range({start_date},)")

    return " AND ".join(parts)
