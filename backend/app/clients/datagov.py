import logging
from typing import Optional

from .base import BaseAPIClient
from ..config import get_settings
from ..models.schemas import SourceItem

logger = logging.getLogger(__name__)


class DataGovClient(BaseAPIClient):
    def __init__(self):
        settings = get_settings()
        super().__init__(base_url=settings.datagov_base_url)
        self.api_key = settings.gov_api_key

    def _get_headers(self) -> dict:
        headers = {"Accept": "application/json"}
        if self.api_key:
            headers["X-Api-Key"] = self.api_key
        return headers

    def _normalize_dataset(self, dataset: dict) -> SourceItem:
        resources = dataset.get("resources", [])
        pdf_url = None
        for resource in resources:
            if resource.get("format", "").upper() == "PDF":
                pdf_url = resource.get("url")
                break

        organization = dataset.get("organization", {})
        agency = organization.get("title") if organization else None

        dataset_id = dataset.get("id") or dataset.get("name", "")
        url = f"https://catalog.data.gov/dataset/{dataset_id}"

        return SourceItem(
            source_type="datagov",
            id=dataset_id,
            title=dataset.get("title", "Untitled Dataset"),
            agency=agency,
            date=dataset.get("metadata_modified") or dataset.get("metadata_created"),
            url=url,
            excerpt=dataset.get("notes", "")[:500] if dataset.get("notes") else None,
            pdf_url=pdf_url,
            content_type="dataset",
            raw=dataset,
        )

    async def search_datasets(
        self,
        query: str,
        organization: Optional[str] = None,
        groups: Optional[list[str]] = None,
        res_format: Optional[str] = None,
        rows: int = 10,
        start: int = 0,
    ) -> tuple[list[dict], list[SourceItem]]:
        fq_parts = []
        if organization:
            fq_parts.append(f'organization:"{organization}"')
        if groups:
            for group in groups:
                fq_parts.append(f'groups:"{group}"')
        if res_format:
            fq_parts.append(f'res_format:"{res_format}"')

        params = {
            "q": query,
            "rows": rows,
            "start": start,
        }

        if fq_parts:
            params["fq"] = " AND ".join(fq_parts)

        url = f"{self.base_url}/package_search"
        logger.info(f"Searching data.gov: {query}")

        data = await self._request_with_retry(
            method="GET",
            url=url,
            headers=self._get_headers(),
            params=params,
        )

        result = data.get("result", {})
        datasets = result.get("results", [])
        sources = [self._normalize_dataset(ds) for ds in datasets]

        return datasets, sources
