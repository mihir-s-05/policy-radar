import logging
from typing import Optional

from .base import BaseAPIClient
from ..config import get_settings
from ..models.schemas import SourceItem

logger = logging.getLogger(__name__)


class CongressClient(BaseAPIClient):
    def __init__(self):
        settings = get_settings()
        super().__init__(base_url=settings.congress_base_url)
        self.api_key = settings.gov_api_key

    def _get_headers(self) -> dict:
        return {
            "X-Api-Key": self.api_key,
            "Accept": "application/json",
        }

    def _normalize_bill(self, bill: dict) -> SourceItem:
        bill_type = bill.get("type", "").lower()
        bill_number = bill.get("number", "")
        congress = bill.get("congress", "")

        url = f"https://www.congress.gov/bill/{congress}th-congress/{bill_type}/{bill_number}"

        update_date = bill.get("updateDate") or bill.get("latestAction", {}).get("actionDate")

        summary = None
        if bill.get("latestAction"):
            summary = bill["latestAction"].get("text", "")

        return SourceItem(
            source_type="congress_bill",
            id=f"{congress}-{bill_type}-{bill_number}",
            title=bill.get("title", "Untitled Bill"),
            agency=None,
            date=update_date,
            url=url,
            excerpt=summary,
            content_type="bill",
            raw=bill,
        )

    def _normalize_vote(self, vote: dict, chamber: str = "house") -> SourceItem:
        vote_number = vote.get("rollNumber") or vote.get("rollCallNumber", "")
        congress = vote.get("congress", "")
        session = vote.get("session", "")

        url = f"https://www.congress.gov/roll-call-vote/{congress}th-congress-{session}/{chamber}/{vote_number}"

        question = vote.get("question", "Roll Call Vote")
        result = vote.get("result", "")
        title = f"{question}" + (f" - {result}" if result else "")

        vote_date = vote.get("date") or vote.get("updateDate")

        return SourceItem(
            source_type="congress_vote",
            id=f"{congress}-{session}-{chamber}-{vote_number}",
            title=title,
            agency=chamber.capitalize(),
            date=vote_date,
            url=url,
            excerpt=vote.get("description"),
            content_type="vote",
            raw=vote,
        )

    async def search_bills(
        self,
        query: str,
        congress: Optional[int] = None,
        bill_type: Optional[str] = None,
        limit: int = 10,
        offset: int = 0,
    ) -> tuple[list[dict], list[SourceItem]]:
        endpoint = "/bill"
        if congress:
            endpoint = f"/bill/{congress}"

        params = {
            "format": "json",
            "limit": min(limit, 250),
            "offset": offset,
        }

        url = f"{self.base_url}{endpoint}"
        logger.info(f"Fetching Congress bills: {url}")

        data = await self._request_with_retry(
            method="GET",
            url=url,
            headers=self._get_headers(),
            params=params,
        )

        bills = data.get("bills", [])

        if query:
            query_lower = query.lower()
            bills = [
                b for b in bills
                if query_lower in (b.get("title", "") or "").lower()
                or query_lower in (b.get("number", "") or "").lower()
            ]

        sources = [self._normalize_bill(bill) for bill in bills[:limit]]
        return bills[:limit], sources

    async def get_bill(
        self,
        congress: int,
        bill_type: str,
        bill_number: int,
    ) -> tuple[Optional[dict], Optional[SourceItem]]:
        url = f"{self.base_url}/bill/{congress}/{bill_type.lower()}/{bill_number}"

        params = {"format": "json"}

        logger.info(f"Fetching Congress bill: {url}")

        data = await self._request_with_retry(
            method="GET",
            url=url,
            headers=self._get_headers(),
            params=params,
        )

        bill = data.get("bill", {})
        if bill:
            return bill, self._normalize_bill(bill)
        return None, None

    async def search_votes(
        self,
        chamber: str = "house",
        congress: Optional[int] = None,
        limit: int = 10,
    ) -> tuple[list[dict], list[SourceItem]]:
        if not congress:
            congress = 118

        endpoint = f"/{chamber}/rollCall/{congress}"
        url = f"{self.base_url}{endpoint}"

        params = {
            "format": "json",
            "limit": min(limit, 250),
        }

        logger.info(f"Fetching Congress votes: {url}")

        data = await self._request_with_retry(
            method="GET",
            url=url,
            headers=self._get_headers(),
            params=params,
        )

        votes = data.get("roll_calls", data.get("rollCalls", []))
        if not votes and "vote" in data:
            votes = [data["vote"]]

        sources = [self._normalize_vote(vote, chamber) for vote in votes[:limit]]
        return votes[:limit], sources
