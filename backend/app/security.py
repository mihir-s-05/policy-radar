import asyncio
import time
from typing import Optional

from fastapi import HTTPException, Request

from .config import get_settings


def _extract_bearer_token(auth_header: Optional[str]) -> Optional[str]:
    if not auth_header:
        return None
    parts = auth_header.split()
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1]
    return None


async def require_api_key(request: Request) -> None:
    settings = get_settings()
    expected = settings.app_api_key
    if not expected:
        return

    provided = (
        request.headers.get("x-api-key")
        or _extract_bearer_token(request.headers.get("authorization"))
        or request.query_params.get("api_key")
    )
    if not provided or provided != expected:
        raise HTTPException(status_code=401, detail="Missing or invalid API key.")


class RateLimiter:
    def __init__(self, limit_per_minute: int = 60):
        self.limit_per_minute = limit_per_minute
        self.window_seconds = 60
        self._lock = asyncio.Lock()
        self._buckets: dict[str, tuple[float, int]] = {}

    def _get_client_key(self, request: Request) -> str:
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            return forwarded.split(",")[0].strip()
        if request.client:
            return request.client.host
        return "unknown"

    async def check(self, request: Request) -> None:
        if self.limit_per_minute <= 0:
            return

        now = time.time()
        key = self._get_client_key(request)

        async with self._lock:
            window_start, count = self._buckets.get(key, (now, 0))
            if now - window_start >= self.window_seconds:
                window_start = now
                count = 0

            if count >= self.limit_per_minute:
                retry_after = int(self.window_seconds - (now - window_start))
                raise HTTPException(
                    status_code=429,
                    detail={
                        "message": "Rate limit exceeded. Please try again later.",
                        "retry_after": max(retry_after, 1),
                    },
                )

            self._buckets[key] = (window_start, count + 1)


_RATE_LIMITER: Optional[RateLimiter] = None


def get_rate_limiter() -> RateLimiter:
    global _RATE_LIMITER
    if _RATE_LIMITER is None:
        settings = get_settings()
        _RATE_LIMITER = RateLimiter(limit_per_minute=settings.rate_limit_per_minute)
    return _RATE_LIMITER


def reset_rate_limiter() -> None:
    global _RATE_LIMITER
    _RATE_LIMITER = None


async def rate_limit(request: Request) -> None:
    limiter = get_rate_limiter()
    await limiter.check(request)
