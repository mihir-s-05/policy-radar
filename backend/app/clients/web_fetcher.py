import asyncio
import ipaddress
import logging
import re
import socket
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Optional
from urllib.parse import urlparse

import httpx

try:
    import h2  # noqa: F401
    _HTTP2_AVAILABLE = True
except ImportError:
    _HTTP2_AVAILABLE = False

from ..config import get_settings
from .html_utils import html_to_text
from .pdf_utils import (
    extract_pdf_images_sync,
    extract_pdf_text_sync,
    PDF_IMAGE_AVAILABLE,
    PDF_TEXT_AVAILABLE,
)

logger = logging.getLogger(__name__)


class WebFetcher:
    _shared_clients: dict[float, httpx.AsyncClient] = {}

    def __init__(self, timeout: float = 30.0):
        self.timeout = timeout
        self.settings = get_settings()
        self._client = self._get_shared_client(timeout)

    @classmethod
    def _get_shared_client(cls, timeout: float) -> httpx.AsyncClient:
        client = cls._shared_clients.get(timeout)
        if client:
            return client
        client = httpx.AsyncClient(
            timeout=httpx.Timeout(timeout),
            follow_redirects=True,
            max_redirects=10,
            http2=_HTTP2_AVAILABLE,
            limits=httpx.Limits(max_connections=10, max_keepalive_connections=5),
        )
        cls._shared_clients[timeout] = client
        return client

    @classmethod
    async def close_shared_clients(cls) -> None:
        for client in cls._shared_clients.values():
            await client.aclose()
        cls._shared_clients = {}

    def _normalize_url(self, url: str) -> str:
        url = (url or "").strip()
        if not url:
            raise ValueError("Missing URL")

        parsed = urlparse(url)
        if not parsed.scheme:
            url = f"https://{url}"
            parsed = urlparse(url)

        if parsed.scheme not in {"http", "https"}:
            raise ValueError("Unsupported URL scheme")

        return url

    def _is_host_allowed(self, host: str) -> bool:
        allowed = self.settings.fetch_allowed_domains
        if not allowed:
            return True

        host = host.lower()
        for entry in allowed:
            domain = entry.lower().strip()
            if not domain:
                continue
            if domain.startswith("."):
                if host.endswith(domain):
                    return True
            elif host == domain or host.endswith(f".{domain}"):
                return True
        return False

    def _is_blocked_ip(self, ip: ipaddress._BaseAddress) -> bool:
        return (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
        )

    async def _validate_host(self, host: str) -> None:
        if not host:
            raise ValueError("Missing host")

        if self.settings.allow_local_fetch:
            return

        if not self._is_host_allowed(host):
            raise ValueError("URL host is not allowed.")

        try:
            ip = ipaddress.ip_address(host)
            if self._is_blocked_ip(ip):
                raise ValueError("URL resolves to a private or local address.")
            return
        except ValueError:
            pass

        try:
            infos = await asyncio.to_thread(socket.getaddrinfo, host, None)
        except Exception:
            raise ValueError("Unable to resolve host.")

        for info in infos:
            addr = info[4][0]
            try:
                ip = ipaddress.ip_address(addr)
            except ValueError:
                continue
            if self._is_blocked_ip(ip):
                raise ValueError("URL resolves to a private or local address.")

    async def _normalize_and_validate_url(self, url: str) -> str:
        normalized = self._normalize_url(url)
        parsed = urlparse(normalized)
        await self._validate_host(parsed.hostname or "")
        return normalized

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

    def _is_probably_pdf(self, content_type: str, url: str, content: bytes) -> bool:
        if "application/pdf" in content_type:
            return True
        if url.lower().endswith(".pdf"):
            return True
        return content[:4] == b"%PDF"

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

    def _is_supported_content_type(self, content_type: str, content: bytes) -> bool:
        if not content_type:
            return self._looks_like_text(content)

        if content_type.startswith("text/"):
            return True

        if "html" in content_type or "xml" in content_type or "json" in content_type:
            return True

        if "octet-stream" in content_type or "binary" in content_type:
            return self._looks_like_text(content)

        return False

    def _build_headers(self, variant: str = "bot") -> dict:
        if variant == "browser":
            return {
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/122.0.0.0 Safari/537.36"
                ),
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
                "Accept-Encoding": "gzip, deflate",
            }

        return {
            "User-Agent": "PolicyRadarBot/1.0 (Federal Policy Research Tool)",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Accept-Encoding": "gzip, deflate",
        }

    async def _read_response_bytes(
        self,
        response: httpx.Response,
        max_bytes: int,
    ) -> Optional[bytes]:
        if max_bytes <= 0:
            return await response.aread()

        content_length = response.headers.get("content-length")
        if content_length:
            try:
                if int(content_length) > max_bytes:
                    return None
            except ValueError:
                pass

        collected = bytearray()
        async for chunk in response.aiter_bytes():
            collected.extend(chunk)
            if len(collected) > max_bytes:
                await response.aclose()
                return None
        return bytes(collected)

    async def _fetch_response_bytes(
        self,
        url: str,
        headers: dict,
        max_bytes: int,
    ) -> tuple[int, httpx.Headers, Optional[bytes]]:
        async with self._client.stream("GET", url, headers=headers) as response:
            content = await self._read_response_bytes(response, max_bytes)
            return response.status_code, response.headers, content

    async def _fetch_best_file_format(
        self,
        file_formats: list[dict],
        max_length: Optional[int],
    ) -> Optional[dict]:
        preferred = ("html", "htm", "txt", "xml", "pdf")
        by_format = {
            (fmt.get("format") or "").lower(): fmt.get("fileUrl")
            for fmt in file_formats
            if fmt.get("fileUrl")
        }

        for fmt in preferred:
            file_url = by_format.get(fmt)
            if not file_url:
                continue
            result = await self.fetch_url(file_url, max_length=max_length)
            if result.get("text"):
                return result

        return None

    async def _fetch_pdf_images_only(self, url: str) -> tuple[list[dict], int]:
        if not PDF_IMAGE_AVAILABLE or not self.settings.pdf_extract_images:
            return [], 0

        try:
            normalized_url = await self._normalize_and_validate_url(url)
        except ValueError:
            return [], 0

        max_bytes = self.settings.fetch_max_response_bytes
        status, headers, content = await self._fetch_response_bytes(
            normalized_url,
            headers=self._build_headers("bot"),
            max_bytes=max_bytes,
        )
        if status == 403:
            status, headers, content = await self._fetch_response_bytes(
                normalized_url,
                headers=self._build_headers("browser"),
                max_bytes=max_bytes,
            )
        if status != 200 or content is None:
            return [], 0

        content_type = (headers.get("content-type") or "").lower()
        if not self._is_probably_pdf(content_type, normalized_url, content):
            return [], 0

        images, skipped = await asyncio.to_thread(
            extract_pdf_images_sync,
            content,
        )
        if images:
            logger.info(
                "PDF images extracted from %s: images=%s skipped=%s",
                normalized_url,
                len(images),
                skipped,
            )
        return images, skipped

    async def fetch_url(
        self,
        url: str,
        max_length: Optional[int] = 15000,
    ) -> dict:
        logger.info(f"Fetching URL content: {url}")

        result = {
            "url": url,
            "title": None,
            "text": None,
            "error": None,
            "content_type": None,
            "content_format": None,
            "pdf_url": None,
        }

        try:
            normalized_url = await self._normalize_and_validate_url(url)
            result["url"] = normalized_url

            backoff = self.settings.initial_backoff
            max_attempts = self.settings.max_retries + 1
            last_error: Optional[Exception] = None
            max_bytes = self.settings.fetch_max_response_bytes

            for attempt in range(max_attempts):
                should_retry = False
                retry_wait: Optional[float] = None

                for variant in ("bot", "browser"):
                    try:
                        status, headers, raw_content = await self._fetch_response_bytes(
                            normalized_url,
                            headers=self._build_headers(variant),
                            max_bytes=max_bytes,
                        )
                    except httpx.TimeoutException as e:
                        last_error = e
                        should_retry = True
                        break
                    except httpx.RequestError as e:
                        last_error = e
                        should_retry = True
                        break

                    if status == 403 and variant == "bot":
                        continue

                    if raw_content is None:
                        result["error"] = f"Response too large (limit {max_bytes} bytes)."
                        return result

                    if status == 429:
                        retry_after = self._parse_retry_after(
                            headers.get("Retry-After")
                        )
                        if attempt < max_attempts - 1:
                            should_retry = True
                            retry_wait = retry_after or backoff
                        else:
                            result["error"] = "Rate limited (429). Please try again later."
                            return result
                        break

                    if status == 408 or status >= 500:
                        if attempt < max_attempts - 1:
                            should_retry = True
                            retry_wait = backoff
                        else:
                            result["error"] = f"HTTP {status}"
                            return result
                        break

                    if status != 200:
                        result["error"] = f"HTTP {status}"
                        return result

                    content_type = (headers.get("content-type") or "").lower()

                    if self._is_probably_pdf(content_type, normalized_url, raw_content):
                        result["content_type"] = content_type or "application/pdf"
                        result["content_format"] = "pdf"
                        result["pdf_url"] = normalized_url
                        pdf_text = await asyncio.to_thread(
                            extract_pdf_text_sync,
                            raw_content,
                            max_length,
                        )
                        images = []
                        skipped = 0
                        should_extract_images = self.settings.pdf_extract_images or not pdf_text
                        if should_extract_images:
                            images, skipped = await asyncio.to_thread(
                                extract_pdf_images_sync,
                                raw_content,
                            )

                        logger.info(
                            "PDF extracted from %s: text=%s images=%s skipped=%s",
                            normalized_url,
                            len(pdf_text) if pdf_text else 0,
                            len(images),
                            skipped,
                        )

                        if pdf_text:
                            result["text"] = pdf_text
                        if images:
                            result["images"] = images
                            result["image_count"] = len(images)
                            if skipped:
                                result["images_skipped"] = skipped

                        if result.get("text") or images:
                            return result

                        if not PDF_TEXT_AVAILABLE and not PDF_IMAGE_AVAILABLE:
                            result["error"] = (
                                "PDF handling requires pypdf (text) or pymupdf (images)."
                            )
                        elif not PDF_TEXT_AVAILABLE:
                            result["error"] = (
                                "PDF text extraction requires pypdf."
                            )
                        elif not PDF_IMAGE_AVAILABLE:
                            result["error"] = (
                                "PDF images require pymupdf."
                            )
                        else:
                            result["error"] = (
                                "PDF content could not be extracted."
                            )
                        return result

                    if not self._is_supported_content_type(content_type, raw_content):
                        label = content_type if content_type else "unknown"
                        result["error"] = f"Unsupported content type: {label}"
                        return result

                    result["content_type"] = content_type
                    if "html" in content_type or "xml" in content_type:
                        result["content_format"] = "html"
                    elif content_type.startswith("text/"):
                        result["content_format"] = "text"
                    else:
                        result["content_format"] = "text"

                    encoding = "utf-8"
                    charset_match = re.search(r"charset=([\\w-]+)", content_type)
                    if charset_match:
                        encoding = charset_match.group(1)
                    html = raw_content.decode(encoding, errors="replace")

                    title_match = re.search(
                        r'<title[^>]*>(.*?)</title>',
                        html,
                        re.IGNORECASE | re.DOTALL,
                    )
                    if title_match:
                        result["title"] = html_to_text(
                            title_match.group(1),
                            max_length=200,
                        )

                    main_content = html

                    main_patterns = [
                        r'<main[^>]*>(.*?)</main>',
                        r'<article[^>]*>(.*?)</article>',
                        r'<div[^>]*class="[^"]*content[^"]*"[^>]*>(.*?)</div>',
                        r'<div[^>]*id="[^"]*content[^"]*"[^>]*>(.*?)</div>',
                    ]

                    for pattern in main_patterns:
                        match = re.search(
                            pattern,
                            html,
                            re.IGNORECASE | re.DOTALL,
                        )
                        if match and len(match.group(1)) > 500:
                            main_content = match.group(1)
                            break

                    result["text"] = html_to_text(main_content, max_length)
                    return result

                if should_retry and attempt < max_attempts - 1:
                    wait_time = retry_wait if retry_wait is not None else backoff
                    logger.warning(
                        "Fetch attempt %s failed. Retrying in %.2fs.",
                        attempt + 1,
                        wait_time,
                    )
                    await asyncio.sleep(wait_time)
                    backoff = min(backoff * 2, 30.0)
                    continue

            if last_error:
                result["error"] = f"Request failed: {last_error}"
            else:
                result["error"] = "Request failed after retries"
            return result

        except ValueError as e:
            result["error"] = str(e)
        except httpx.TimeoutException:
            result["error"] = "Request timed out"
        except httpx.RequestError as e:
            result["error"] = f"Request failed: {str(e)}"
        except Exception as e:
            logger.exception(f"Error fetching URL {url}")
            result["error"] = f"Unexpected error: {str(e)}"

        return result

    async def fetch_regulations_document_content(
        self,
        document_id: str,
        max_length: Optional[int] = 15000,
    ) -> dict:
        url = f"https://www.regulations.gov/document/{document_id}"
        result = {
            "url": url,
            "title": None,
            "text": None,
            "error": None,
            "content_type": None,
            "content_format": None,
            "pdf_url": None,
            "document_id": document_id,
        }

        attrs = {}
        file_formats = []
        api_error = None

        try:
            api_url = f"https://api.regulations.gov/v4/documents/{document_id}"
            headers = {
                "X-Api-Key": self.settings.gov_api_key,
                "Accept": "application/json",
            }

            response = await self._client.get(api_url, headers=headers, timeout=self.timeout)

            if response.status_code == 200:
                data = response.json()
                attrs = data.get("data", {}).get("attributes", {}) or {}
                file_formats = attrs.get("fileFormats") or []
            else:
                api_error = f"HTTP {response.status_code}"
        except Exception as e:
            api_error = str(e)
            logger.warning(f"Could not fetch API details for {document_id}: {e}")

        additional_content = []
        if attrs.get("title"):
            additional_content.append(f"Title: {attrs['title']}")
            result["title"] = attrs["title"]
        if attrs.get("agencyId"):
            additional_content.append(f"Agency: {attrs['agencyId']}")
        if attrs.get("documentType"):
            additional_content.append(f"Document Type: {attrs['documentType']}")
        if attrs.get("postedDate"):
            additional_content.append(f"Posted: {attrs['postedDate']}")
        if attrs.get("summary"):
            additional_content.append(f"\nSummary:\n{attrs['summary']}")
        if attrs.get("abstract"):
            additional_content.append(f"\nAbstract:\n{attrs['abstract']}")

        body_text = None
        images = []
        images_skipped = None
        pdf_url = None

        if isinstance(file_formats, list):
            for fmt in file_formats:
                if (fmt.get("format") or "").lower() == "pdf" and fmt.get("fileUrl"):
                    pdf_url = fmt["fileUrl"]
                    break

        file_result = None
        if isinstance(file_formats, list) and file_formats:
            file_result = await self._fetch_best_file_format(
                file_formats,
                max_length=max_length,
            )

        if file_result:
            if file_result.get("text"):
                body_text = file_result.get("text")
            if file_result.get("title") and not result.get("title"):
                result["title"] = file_result.get("title")
            if file_result.get("content_format"):
                result["content_format"] = file_result.get("content_format")
            if file_result.get("content_type"):
                result["content_type"] = file_result.get("content_type")
            if file_result.get("pdf_url"):
                result["pdf_url"] = file_result.get("pdf_url")
            if file_result.get("images"):
                images = file_result.get("images") or images
                images_skipped = file_result.get("images_skipped", images_skipped)

        if not body_text and not images:
            fallback = await self.fetch_url(url, max_length)
            if fallback.get("text"):
                body_text = fallback.get("text")
            if fallback.get("images"):
                images = fallback.get("images") or images
                images_skipped = fallback.get("images_skipped", images_skipped)
            if fallback.get("title") and not result.get("title"):
                result["title"] = fallback.get("title")
            if fallback.get("content_format") and not result.get("content_format"):
                result["content_format"] = fallback.get("content_format")
            if fallback.get("content_type") and not result.get("content_type"):
                result["content_type"] = fallback.get("content_type")
            if fallback.get("pdf_url") and not result.get("pdf_url"):
                result["pdf_url"] = fallback.get("pdf_url")
            if not result.get("error") and fallback.get("error"):
                result["error"] = fallback.get("error")

        if not images and pdf_url:
            pdf_images, skipped = await self._fetch_pdf_images_only(pdf_url)
            if pdf_images:
                images = pdf_images
                images_skipped = skipped
                result["pdf_url"] = pdf_url

        if pdf_url and not result.get("pdf_url"):
            result["pdf_url"] = pdf_url

        if images:
            result["images"] = images
            result["image_count"] = len(images)
            if images_skipped:
                result["images_skipped"] = images_skipped

        if additional_content:
            api_content = "\n".join(additional_content)
            if body_text:
                result["text"] = api_content + "\n\n---\n\n" + body_text
            else:
                result["text"] = api_content
        elif body_text:
            result["text"] = body_text

        if result.get("text") or result.get("images"):
            result["error"] = None
        elif not result.get("error"):
            result["error"] = api_error or "No content available."

        return result
