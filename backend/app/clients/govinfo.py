import asyncio
import logging
from typing import Optional
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
import httpx

try:
    import h2  # noqa: F401
    _HTTP2_AVAILABLE = True
except ImportError:
    _HTTP2_AVAILABLE = False

from .base import BaseAPIClient
from .html_utils import html_to_text
from .pdf_utils import extract_pdf_images_sync, extract_pdf_text_sync
from ..config import get_settings
from ..models.schemas import SourceItem

logger = logging.getLogger(__name__)


class GovInfoClient(BaseAPIClient):
    _shared_content_clients: dict[float, httpx.AsyncClient] = {}

    def __init__(self):
        settings = get_settings()
        super().__init__(base_url=settings.govinfo_base_url)
        self.api_key = settings.gov_api_key
        self._content_client = self._get_content_client(self.timeout)

    @classmethod
    def _get_content_client(cls, timeout: float) -> httpx.AsyncClient:
        client = cls._shared_content_clients.get(timeout)
        if client:
            return client
        client = httpx.AsyncClient(
            timeout=timeout,
            follow_redirects=True,
            http2=_HTTP2_AVAILABLE,
            limits=httpx.Limits(max_connections=10, max_keepalive_connections=5),
        )
        cls._shared_content_clients[timeout] = client
        return client

    @classmethod
    async def close_shared_clients(cls) -> None:
        for client in cls._shared_content_clients.values():
            await client.aclose()
        cls._shared_content_clients = {}

    def _parse_retry_after(self, value: Optional[str]) -> Optional[float]:
        if not value:
            return None

        try:
            return float(value)
        except ValueError:
            try:
                parsed = parsedate_to_datetime(value)
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone.utc)
                now = datetime.now(timezone.utc)
                return max(0.0, (parsed - now).total_seconds())
            except Exception:
                return None

    async def _fetch_url_with_retry(
        self,
        client: httpx.AsyncClient,
        url: str,
        params: Optional[dict],
    ) -> Optional[httpx.Response]:
        backoff = self.settings.initial_backoff
        max_attempts = self.settings.max_retries + 1

        for attempt in range(max_attempts):
            try:
                response = await client.get(url, params=params)
            except httpx.TimeoutException:
                if attempt < max_attempts - 1:
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 2, 30.0)
                    continue
                return None
            except httpx.RequestError:
                if attempt < max_attempts - 1:
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 2, 30.0)
                    continue
                return None

            if response.status_code == 429:
                retry_after = self._parse_retry_after(
                    response.headers.get("Retry-After")
                )
                if attempt < max_attempts - 1:
                    await asyncio.sleep(retry_after or backoff)
                    backoff = min(backoff * 2, 30.0)
                    continue
                return response

            if response.status_code == 408 or response.status_code >= 500:
                if attempt < max_attempts - 1:
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 2, 30.0)
                    continue
                return response

            return response

        return None

    def _looks_like_text(self, content: bytes) -> bool:
        if not content:
            return True
        sample = content[:1024]
        if b"\x00" in sample:
            return False
        printable = sum(
            1 for b in sample
            if 32 <= b <= 126 or b in (9, 10, 13)
        )
        return printable / len(sample) > 0.85

    def _is_supported_text_type(self, content_type: str, content: bytes) -> bool:
        if not content_type:
            return self._looks_like_text(content)

        content_type = content_type.lower()
        if content_type.startswith("text/"):
            return True
        if "html" in content_type or "xml" in content_type or "json" in content_type:
            return True
        if "octet-stream" in content_type or "binary" in content_type:
            return self._looks_like_text(content)
        return False

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
    ) -> tuple[str, SourceItem, list[dict], int, str, Optional[str]]:
        summary, source = await self.get_package_summary(package_id)

        url = f"{self.base_url}/packages/{package_id}/htm"
        params = self._add_api_key()

        logger.info(f"Fetching GovInfo package content: {package_id}")
        images: list[dict] = []
        images_skipped = 0
        content_format = "unknown"
        pdf_url = f"{self.base_url}/packages/{package_id}/pdf"

        try:
            text_result = ""

            client = self._content_client
            for fmt in ("htm", "xml", "txt"):
                if fmt == "htm":
                    target_url = url
                else:
                    target_url = f"{self.base_url}/packages/{package_id}/{fmt}"

                response = await self._fetch_url_with_retry(
                    client,
                    target_url,
                    params,
                )
                if not response or response.status_code != 200:
                    continue

                content_type = response.headers.get("content-type", "")
                if not self._is_supported_text_type(content_type, response.content):
                    continue

                text = html_to_text(response.text, max_length)
                if text:
                    text_result = text
                    content_format = fmt
                    break

            if text_result:
                should_extract_images = self.settings.pdf_extract_images
                if should_extract_images:
                    pdf_response = await self._fetch_url_with_retry(
                        client,
                        pdf_url,
                        params,
                    )
                    if pdf_response and pdf_response.status_code == 200:
                        extracted_images, skipped = await asyncio.to_thread(
                            extract_pdf_images_sync,
                            pdf_response.content,
                        )
                        logger.info(
                            "GovInfo PDF images extracted for %s: images=%s skipped=%s",
                            package_id,
                            len(extracted_images),
                            skipped,
                        )
                        if extracted_images:
                            images = extracted_images
                            images_skipped = skipped

                return text_result, source, images, images_skipped, content_format, pdf_url

            pdf_response = await self._fetch_url_with_retry(
                client,
                pdf_url,
                params,
            )
            if pdf_response and pdf_response.status_code == 200:
                pdf_text = await asyncio.to_thread(
                    extract_pdf_text_sync,
                    pdf_response.content,
                    max_length,
                )
                should_extract_images = self.settings.pdf_extract_images or not pdf_text
                if should_extract_images:
                    extracted_images, skipped = await asyncio.to_thread(
                        extract_pdf_images_sync,
                        pdf_response.content,
                    )
                    logger.info(
                        "GovInfo PDF extracted for %s: text=%s images=%s skipped=%s",
                        package_id,
                        len(pdf_text) if pdf_text else 0,
                        len(extracted_images),
                        skipped,
                    )
                    if extracted_images:
                        images = extracted_images
                        images_skipped = skipped
                if pdf_text or images:
                    content_format = "pdf"
                    return pdf_text or "", source, images, images_skipped, content_format, pdf_url

        except Exception as e:
            logger.warning(f"Could not fetch content for {package_id}: {e}")

        fallback = summary.get("abstract") or summary.get("description") or "No content available."
        return fallback, source, images, images_skipped, content_format, pdf_url

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
