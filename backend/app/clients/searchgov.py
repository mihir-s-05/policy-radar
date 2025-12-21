import logging

from .base import BaseAPIClient
from ..config import get_settings
from ..models.schemas import SourceItem

logger = logging.getLogger(__name__)


class SearchGovClient(BaseAPIClient):
    def __init__(self):
        settings = get_settings()
        super().__init__(base_url=settings.searchgov_base_url)
        self.affiliate = settings.searchgov_affiliate
        self.access_key = settings.searchgov_access_key

    @property
    def is_configured(self) -> bool:
        return bool(self.affiliate and self.access_key)

    def _normalize_result(self, result: dict) -> SourceItem:
        return SourceItem(
            source_type="searchgov",
            id=result.get("link", "")[:100],
            title=result.get("title", "Untitled"),
            agency=None,
            date=result.get("publication_date") or result.get("created_at"),
            url=result.get("link", ""),
            excerpt=result.get("snippet"),
            content_type="web_result",
            raw=result,
        )

    async def search(
        self,
        query: str,
        enable_highlighting: bool = False,
        limit: int = 10,
        offset: int = 0,
    ) -> tuple[list[dict], list[SourceItem]]:
        params = {
            "affiliate": self.affiliate,
            "access_key": self.access_key,
            "query": query,
            "enable_highlighting": str(enable_highlighting).lower(),
            "limit": limit,
            "offset": offset,
        }

        url = f"{self.base_url}/results/i14y"
        logger.info(f"Searching Search.gov: {query}")

        data = await self._request_with_retry(
            method="GET",
            url=url,
            params=params,
        )

        web_results = data.get("web", {}).get("results", [])
        sources = [self._normalize_result(r) for r in web_results]

        return web_results, sources
