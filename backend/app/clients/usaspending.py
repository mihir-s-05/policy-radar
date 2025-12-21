import logging
from typing import Optional, Any
from datetime import datetime, timedelta

from .base import BaseAPIClient
from ..config import get_settings
from ..models.schemas import SourceItem

logger = logging.getLogger(__name__)


class USASpendingClient(BaseAPIClient):
    def __init__(self):
        settings = get_settings()
        super().__init__(base_url=settings.usaspending_base_url)

    _DEFAULT_FIELDS = [
        "Award ID",
        "Recipient Name",
        "Award Amount",
        "Start Date",
        "End Date",
        "Awarding Agency",
        "Award Description",
    ]

    def _format_currency(self, amount: Optional[float]) -> str:
        if amount is None:
            return "N/A"
        if abs(amount) >= 1_000_000_000:
            return f"${amount / 1_000_000_000:.2f}B"
        if abs(amount) >= 1_000_000:
            return f"${amount / 1_000_000:.2f}M"
        if abs(amount) >= 1_000:
            return f"${amount / 1_000:.2f}K"
        return f"${amount:.2f}"

    def _format_spending_brief(self, data: dict, query_context: str = "") -> str:
        lines = ["# USAspending Summary\n"]

        if query_context:
            lines.append(f"**Query Context:** {query_context}\n")

        results = data.get("results", [])

        if not results:
            lines.append("No spending data found for the specified criteria.\n")
            return "\n".join(lines)

        lines.append(f"**Total Results:** {len(results)}\n")

        total_obligations = sum(
            r.get("Award Amount", 0)
            or r.get("total_obligations", 0)
            or r.get("obligated_amount", 0)
            or r.get("amount", 0)
            or 0
            for r in results
        )
        if total_obligations:
            lines.append(f"**Total Obligations:** {self._format_currency(total_obligations)}\n")

        lines.append("\n## Top Results\n")

        for i, result in enumerate(results[:10], 1):
            name = (
                result.get("Recipient Name")
                or result.get("recipient_name")
                or result.get("Awarding Agency")
                or result.get("awarding_agency", {}).get("toptier_agency", {}).get("name")
                or result.get("name")
                or f"Result {i}"
            )
            amount = (
                result.get("Award Amount")
                or result.get("total_obligations")
                or result.get("obligated_amount")
                or result.get("amount")
            )
            
            lines.append(f"### {i}. {name}")
            if amount:
                lines.append(f"- **Amount:** {self._format_currency(amount)}")
            
            description = result.get("Award Description") or result.get("description")
            if description:
                lines.append(f"- **Description:** {str(description)[:200]}...")
            
            if result.get("Award ID") or result.get("award_id") or result.get("internal_id"):
                award_id = result.get("Award ID") or result.get("award_id") or result.get("internal_id")
                lines.append(f"- **Award ID:** {award_id}")

            lines.append("")

        return "\n".join(lines)

    def _normalize_spending(self, result: dict) -> SourceItem:
        item_id = (
            result.get("generated_internal_id")
            or result.get("generated_unique_award_id")
            or result.get("Award ID")
            or result.get("award_id")
            or result.get("internal_id")
            or str(hash(str(result)))[:12]
        )

        title = (
            result.get("Recipient Name")
            or result.get("recipient_name")
            or (result.get("Award Description") or result.get("description") or "")[:100]
            or f"Spending Record {item_id}"
        )

        agency = None
        if result.get("Awarding Agency"):
            agency = result.get("Awarding Agency")
        elif result.get("awarding_agency"):
            agency = result["awarding_agency"].get("toptier_agency", {}).get("name")

        url = f"https://www.usaspending.gov/award/{item_id}" if item_id else "https://www.usaspending.gov"

        amount = result.get("Award Amount") or result.get("total_obligations") or result.get("obligated_amount")
        excerpt = f"Amount: {self._format_currency(amount)}" if amount else None
        description = result.get("Award Description") or result.get("description")
        if description:
            excerpt = (excerpt + " - " if excerpt else "") + str(description)[:200]
        
        return SourceItem(
            source_type="usaspending",
            id=str(item_id),
            title=title,
            agency=agency,
            date=(
                result.get("Start Date")
                or result.get("action_date")
                or result.get("period_of_performance_start_date")
            ),
            url=url,
            excerpt=excerpt,
            content_type="spending",
            raw=result,
        )

    async def search_spending(
        self,
        keywords: Optional[list[str]] = None,
        agency: Optional[str] = None,
        recipient: Optional[str] = None,
        award_type: Optional[str] = None,
        days: int = 365,
        limit: int = 10,
    ) -> tuple[list[dict], list[SourceItem], str]:
        filters: dict[str, Any] = {}

        if keywords:
            cleaned = [k.strip() for k in keywords if isinstance(k, str) and k.strip()]
            cleaned = [k for k in cleaned if len(k) >= 3]
            if cleaned:
                filters["keywords"] = cleaned

        if agency:
            agency = agency.strip()
        if agency:
            filters["agencies"] = [{"type": "awarding", "tier": "toptier", "name": agency}]

        if recipient:
            recipient = recipient.strip()
        if recipient:
            filters["recipient_search_text"] = [recipient]

        type_map = {
            "contracts": ["A", "B", "C", "D"],
            "grants": ["02", "03", "04", "05"],
            "loans": ["07", "08"],
            "direct_payments": ["06", "10"],
        }

        effective_award_type = (award_type or "contracts").strip().lower()
        if effective_award_type not in type_map:
            raise ValueError(
                f"Unsupported award_type '{award_type}'. Supported: {', '.join(sorted(type_map.keys()))}"
            )
        filters["award_type_codes"] = type_map[effective_award_type]

        end_date = datetime.now()
        start_date = end_date - timedelta(days=days)
        filters["time_period"] = [{
            "start_date": start_date.strftime("%Y-%m-%d"),
            "end_date": end_date.strftime("%Y-%m-%d"),
        }]

        payload = {
            "filters": filters,
            "fields": list(self._DEFAULT_FIELDS),
            "limit": limit,
            "page": 1,
            "sort": "Award Amount",
            "order": "desc",
        }

        url = f"{self.base_url}/search/spending_by_award"
        logger.info(f"Searching USAspending: keywords={keywords}")

        data = await self._request_with_retry(
            method="POST",
            url=url,
            json=payload,
        )

        results = data.get("results", [])
        sources = [self._normalize_spending(r) for r in results]
        brief = self._format_spending_brief(data, str(keywords))

        return results, sources, brief
