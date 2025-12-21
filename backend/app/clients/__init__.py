"""Government API clients."""
from .regulations import RegulationsClient
from .govinfo import GovInfoClient
from .web_fetcher import WebFetcher
from .congress import CongressClient
from .federal_register import FederalRegisterClient
from .usaspending import USASpendingClient
from .fiscal_data import FiscalDataClient
from .datagov import DataGovClient
from .doj import DOJClient
from .searchgov import SearchGovClient

__all__ = [
    "RegulationsClient",
    "GovInfoClient",
    "WebFetcher",
    "CongressClient",
    "FederalRegisterClient",
    "USASpendingClient",
    "FiscalDataClient",
    "DataGovClient",
    "DOJClient",
    "SearchGovClient",
]
