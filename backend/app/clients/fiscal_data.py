import logging
from typing import Optional, Any

from .base import BaseAPIClient
from ..config import get_settings
from ..models.schemas import SourceItem

logger = logging.getLogger(__name__)


class FiscalDataClient(BaseAPIClient):
    DATASETS = {
        "debt_to_penny": "/v2/accounting/od/debt_to_penny",
        "debt_outstanding": "/v1/debt/mspd/mspd_table_1",
        "treasury_offset": "/v1/debt/top/top_state",
        "interest_rates": "/v1/accounting/od/avg_interest_rates",
        "monthly_receipts": "/v1/accounting/mts/mts_table_4",
        "monthly_outlays": "/v1/accounting/mts/mts_table_5",
        "federal_surplus_deficit": "/v2/accounting/od/statement_net_cost",
    }

    def __init__(self):
        settings = get_settings()
        super().__init__(base_url=settings.fiscal_data_base_url)

    def _format_currency(self, amount: Optional[float]) -> str:
        if amount is None:
            return "N/A"
        try:
            amount = float(amount)
        except (TypeError, ValueError):
            return str(amount)

        if abs(amount) >= 1_000_000_000_000:
            return f"${amount / 1_000_000_000_000:.2f}T"
        if abs(amount) >= 1_000_000_000:
            return f"${amount / 1_000_000_000:.2f}B"
        if abs(amount) >= 1_000_000:
            return f"${amount / 1_000_000:.2f}M"
        return f"${amount:,.2f}"

    def _format_fiscal_brief(self, data: dict, dataset_name: str, query_context: str = "") -> str:
        lines = [f"# Treasury Fiscal Data: {dataset_name}\n"]

        if query_context:
            lines.append(f"**Query Context:** {query_context}\n")

        records = data.get("data", [])
        meta = data.get("meta", {})

        if not records:
            lines.append("No fiscal data found for the specified criteria.\n")
            return "\n".join(lines)

        lines.append(f"**Total Records:** {meta.get('total-count', len(records))}\n")
        lines.append(f"**Data Source:** U.S. Treasury Fiscal Data\n")

        lines.append("\n## Recent Data\n")

        for i, record in enumerate(records[:10], 1):
            lines.append(f"### Record {i}")

            if "record_date" in record:
                lines.append(f"- **Date:** {record['record_date']}")

            if "tot_pub_debt_out_amt" in record:
                lines.append(f"- **Total Public Debt Outstanding:** {self._format_currency(record.get('tot_pub_debt_out_amt'))}")

            if "avg_interest_rate_amt" in record:
                lines.append(f"- **Average Interest Rate:** {record.get('avg_interest_rate_amt')}%")
            if "security_desc" in record:
                lines.append(f"- **Security Type:** {record.get('security_desc')}")

            if "current_month_net_rcpt_amt" in record:
                lines.append(f"- **Monthly Receipts:** {self._format_currency(record.get('current_month_net_rcpt_amt'))}")
            if "current_month_net_outly_amt" in record:
                lines.append(f"- **Monthly Outlays:** {self._format_currency(record.get('current_month_net_outly_amt'))}")

            for key, value in list(record.items())[:5]:
                if key not in ["record_date", "tot_pub_debt_out_amt", "avg_interest_rate_amt", 
                              "security_desc", "current_month_net_rcpt_amt", "current_month_net_outly_amt"]:
                    if value and not key.endswith("_link"):
                        lines.append(f"- **{key.replace('_', ' ').title()}:** {value}")

            lines.append("")

        return "\n".join(lines)

    def _normalize_fiscal(self, record: dict, dataset_name: str) -> SourceItem:
        record_date = record.get("record_date", "")

        if "tot_pub_debt_out_amt" in record:
            title = f"Public Debt: {self._format_currency(record.get('tot_pub_debt_out_amt'))}"
        elif "avg_interest_rate_amt" in record:
            title = f"Interest Rate: {record.get('avg_interest_rate_amt')}% - {record.get('security_desc', 'Treasury')}"
        else:
            title = f"Fiscal Data Record - {record_date}"
        
        return SourceItem(
            source_type="fiscal_data",
            id=f"{dataset_name}-{record_date}",
            title=title,
            agency="U.S. Treasury",
            date=record_date,
            url=f"https://fiscaldata.treasury.gov/datasets/{dataset_name.replace('_', '-')}",
            excerpt=f"Record date: {record_date}",
            content_type="fiscal_data",
            raw=record,
        )

    async def query_dataset(
        self,
        dataset: str,
        filters: Optional[dict] = None,
        fields: Optional[list[str]] = None,
        sort: Optional[str] = None,
        page_size: int = 10,
    ) -> tuple[list[dict], list[SourceItem], str]:
        endpoint = self.DATASETS[dataset]
        url = f"{self.base_url}{endpoint}"

        params: dict[str, Any] = {
            "page[size]": page_size,
            "page[number]": 1,
        }

        if filters:
            for field, condition in filters.items():
                params[f"filter[{field}]"] = condition

        if fields:
            params["fields"] = ",".join(fields)

        if sort:
            params["sort"] = sort
        else:
            params["sort"] = "-record_date"

        logger.info(f"Querying Fiscal Data: {dataset}")

        data = await self._request_with_retry(
            method="GET",
            url=url,
            params=params,
        )

        records = data.get("data", [])
        sources = [self._normalize_fiscal(r, dataset) for r in records]
        brief = self._format_fiscal_brief(data, dataset)

        return records, sources, brief
