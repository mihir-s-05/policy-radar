import asyncio
import logging
from typing import Optional
import httpx
from cachetools import TTLCache

from ..config import get_settings

logger = logging.getLogger(__name__)

_cache: TTLCache = TTLCache(maxsize=1000, ttl=get_settings().cache_ttl)


class RateLimitError(Exception):
    def __init__(self, message: str, retry_after: Optional[float] = None):
        super().__init__(message)
        self.retry_after = retry_after


class APIError(Exception):
    def __init__(self, message: str, status_code: int = 500):
        super().__init__(message)
        self.status_code = status_code


class BaseAPIClient:
    _shared_clients: dict[float, httpx.AsyncClient] = {}

    def __init__(self, base_url: str, timeout: float = 30.0):
        self.base_url = base_url
        self.timeout = timeout
        self.settings = get_settings()
        self._rate_limit_remaining: Optional[int] = None
        self._rate_limit_limit: Optional[int] = None
        self._client = self._get_shared_client(timeout)

    @classmethod
    def _get_shared_client(cls, timeout: float) -> httpx.AsyncClient:
        client = cls._shared_clients.get(timeout)
        if client:
            return client
        limits = httpx.Limits(max_connections=50, max_keepalive_connections=20)
        client = httpx.AsyncClient(timeout=timeout, limits=limits)
        cls._shared_clients[timeout] = client
        return client

    @classmethod
    async def close_shared_clients(cls) -> None:
        for client in cls._shared_clients.values():
            await client.aclose()
        cls._shared_clients = {}

    def _get_cache_key(self, method: str, url: str, params: Optional[dict] = None) -> str:
        param_str = "&".join(f"{k}={v}" for k, v in sorted((params or {}).items()))
        return f"{method}:{url}?{param_str}"

    def _parse_rate_limit_headers(self, headers: httpx.Headers):
        if "X-RateLimit-Remaining" in headers:
            self._rate_limit_remaining = int(headers["X-RateLimit-Remaining"])
        if "X-RateLimit-Limit" in headers:
            self._rate_limit_limit = int(headers["X-RateLimit-Limit"])

        logger.debug(
            f"Rate limit: {self._rate_limit_remaining}/{self._rate_limit_limit}"
        )

    async def _request_with_retry(
        self,
        method: str,
        url: str,
        headers: Optional[dict] = None,
        params: Optional[dict] = None,
        json: Optional[dict] = None,
        use_cache: bool = True,
    ) -> dict:
        cache_key = self._get_cache_key(method, url, params)
        if use_cache and method.upper() == "GET" and cache_key in _cache:
            logger.debug(f"Cache hit for {cache_key}")
            return _cache[cache_key]

        backoff = self.settings.initial_backoff
        last_error: Optional[Exception] = None

        for attempt in range(self.settings.max_retries + 1):
            try:
                response = await self._client.request(
                    method=method,
                    url=url,
                    headers=headers,
                    params=params,
                    json=json,
                    timeout=self.timeout,
                )

                self._parse_rate_limit_headers(response.headers)

                if response.status_code == 429:
                    retry_after = response.headers.get("Retry-After")
                    wait_time = float(retry_after) if retry_after else backoff

                    logger.warning(
                        f"Rate limited (429). Attempt {attempt + 1}/{self.settings.max_retries + 1}. "
                        f"Waiting {wait_time}s"
                    )

                    if attempt < self.settings.max_retries:
                        await asyncio.sleep(wait_time)
                        backoff *= 2
                        continue
                    else:
                        raise RateLimitError(
                            "Rate limit exceeded. Please try again later.",
                            retry_after=wait_time,
                        )

                if response.status_code >= 400:
                    content_type = response.headers.get("content-type", "")
                    error_text = response.text or ""
                    preview = error_text[:800]
                    if "text/html" in (content_type or "").lower():
                        preview = "HTML error page returned (truncated)."
                    logger.error(
                        "API error %s (%s): %s",
                        response.status_code,
                        content_type,
                        preview,
                    )
                    raise APIError(
                        f"API request failed ({response.status_code} {content_type}): {preview}",
                        status_code=response.status_code,
                    )

                data = response.json()

                if use_cache and method.upper() == "GET":
                    _cache[cache_key] = data

                return data

            except httpx.TimeoutException as e:
                last_error = e
                logger.warning(f"Request timeout. Attempt {attempt + 1}")
                if attempt < self.settings.max_retries:
                    await asyncio.sleep(backoff)
                    backoff *= 2
                    continue

            except httpx.RequestError as e:
                last_error = e
                logger.error(f"Request error: {e}")
                if attempt < self.settings.max_retries:
                    await asyncio.sleep(backoff)
                    backoff *= 2
                    continue

        raise APIError(f"Request failed after retries: {last_error}")

    @property
    def rate_limit_info(self) -> dict:
        return {
            "remaining": self._rate_limit_remaining,
            "limit": self._rate_limit_limit,
        }
