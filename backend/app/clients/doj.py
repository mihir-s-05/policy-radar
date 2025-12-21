import logging
from typing import Optional
from datetime import datetime, timedelta

from .base import BaseAPIClient
from ..config import get_settings
from ..models.schemas import SourceItem

logger = logging.getLogger(__name__)


class DOJClient(BaseAPIClient):
    def __init__(self):
        settings = get_settings()
        super().__init__(base_url=settings.doj_base_url)

    def _normalize_press_release(self, release: dict) -> SourceItem:
        release_id = release.get("uuid") or release.get("nid", "")

        url = release.get("url", "")
        if not url and release.get("path"):
            url = f"https://www.justice.gov{release['path']}"

        date = None
        if release.get("created"):
            try:
                date = datetime.fromtimestamp(int(release["created"])).strftime("%Y-%m-%d")
            except (ValueError, TypeError):
                date = str(release.get("created"))
        elif release.get("changed"):
            try:
                date = datetime.fromtimestamp(int(release["changed"])).strftime("%Y-%m-%d")
            except (ValueError, TypeError):
                pass

        components = release.get("component", [])
        agency = None
        if components and isinstance(components, list) and len(components) > 0:
            agency = components[0].get("name") if isinstance(components[0], dict) else str(components[0])

        return SourceItem(
            source_type="doj_press_release",
            id=str(release_id),
            title=release.get("title", "Untitled Press Release"),
            agency=agency or "Department of Justice",
            date=date,
            url=url,
            excerpt=release.get("body", {}).get("summary", "") if isinstance(release.get("body"), dict) else release.get("teaser", ""),
            content_type="press_release",
            raw=release,
        )

    async def search_press_releases(
        self,
        query: Optional[str] = None,
        component: Optional[str] = None,
        topic: Optional[str] = None,
        days: Optional[int] = None,
        limit: int = 10,
        page: int = 0,
    ) -> tuple[list[dict], list[SourceItem]]:
        params = {
            "pagesize": limit,
            "page": page,
            "sort": "date",
            "direction": "DESC",
        }

        if query:
            params["keyword"] = query

        if component:
            params["component"] = component

        if topic:
            params["topic"] = topic

        url = f"{self.base_url}/press_releases.json"
        logger.info(f"Searching DOJ press releases: {query}")

        data = await self._request_with_retry(
            method="GET",
            url=url,
            headers={"Accept": "application/json"},
            params=params,
        )

        releases = []
        if isinstance(data, list):
            releases = data
        elif isinstance(data, dict):
            releases = data.get("results", data.get("data", []))

        if days and releases:
            cutoff = datetime.now() - timedelta(days=days)
            filtered = []
            for release in releases:
                created = release.get("created")
                if created:
                    try:
                        release_date = datetime.fromtimestamp(int(created))
                        if release_date >= cutoff:
                            filtered.append(release)
                    except (ValueError, TypeError):
                        filtered.append(release)
                else:
                    filtered.append(release)
            releases = filtered

        sources = [self._normalize_press_release(r) for r in releases[:limit]]
        return releases[:limit], sources
