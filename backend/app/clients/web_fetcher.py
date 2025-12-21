import logging
import re
from typing import Optional
import httpx

from ..config import get_settings

logger = logging.getLogger(__name__)


def html_to_text(html: str, max_length: Optional[int] = 15000) -> str:
    html = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r'<style[^>]*>.*?</style>', '', html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r'<head[^>]*>.*?</head>', '', html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r'<nav[^>]*>.*?</nav>', '', html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r'<footer[^>]*>.*?</footer>', '', html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r'<!--.*?-->', '', html, flags=re.DOTALL)

    html = re.sub(r'</(p|div|h[1-6]|li|tr|section|article)[^>]*>', '\n', html, flags=re.IGNORECASE)
    html = re.sub(r'<(br|hr)[^>]*/?>', '\n', html, flags=re.IGNORECASE)

    text = re.sub(r'<[^>]+>', ' ', html)

    entities = {
        '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>',
        '&quot;': '"', '&#39;': "'", '&apos;': "'",
        '&mdash;': '--', '&ndash;': '-', '&hellip;': '...',
        '&copy;': '(c)', '&reg;': '(R)', '&trade;': '(TM)',
    }
    for entity, char in entities.items():
        text = text.replace(entity, char)

    text = re.sub(r'&#(\d+);', lambda m: chr(int(m.group(1))), text)
    text = re.sub(r'&#x([0-9a-fA-F]+);', lambda m: chr(int(m.group(1), 16)), text)

    text = re.sub(r'[ \t]+', ' ', text)
    text = re.sub(r'\n[ \t]+', '\n', text)
    text = re.sub(r'[ \t]+\n', '\n', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    text = text.strip()

    if max_length is not None and max_length > 0 and len(text) > max_length:
        truncated = text[:max_length]
        last_period = truncated.rfind('.')
        if last_period > max_length * 0.8:
            truncated = truncated[:last_period + 1]
        text = truncated + "\n\n[Content truncated due to length...]"

    return text


class WebFetcher:

    def __init__(self, timeout: float = 30.0):
        self.timeout = timeout
        self.settings = get_settings()

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
        }

        try:
            async with httpx.AsyncClient(
                timeout=self.timeout,
                follow_redirects=True,
                max_redirects=5,
            ) as client:
                response = await client.get(url, headers=self._build_headers("bot"))

                if response.status_code == 403:
                    response = await client.get(url, headers=self._build_headers("browser"))

                if response.status_code != 200:
                    result["error"] = f"HTTP {response.status_code}"
                    return result

                content_type = response.headers.get("content-type", "")

                if "application/pdf" in content_type:
                    result["error"] = "PDF content cannot be extracted directly. Use the document ID to get metadata."
                    return result

                if "html" not in content_type and "xml" not in content_type and "text" not in content_type:
                    result["error"] = f"Unsupported content type: {content_type}"
                    return result

                html = response.text

                title_match = re.search(r'<title[^>]*>(.*?)</title>', html, re.IGNORECASE | re.DOTALL)
                if title_match:
                    result["title"] = html_to_text(title_match.group(1), max_length=200)

                main_content = html

                main_patterns = [
                    r'<main[^>]*>(.*?)</main>',
                    r'<article[^>]*>(.*?)</article>',
                    r'<div[^>]*class="[^"]*content[^"]*"[^>]*>(.*?)</div>',
                    r'<div[^>]*id="[^"]*content[^"]*"[^>]*>(.*?)</div>',
                ]

                for pattern in main_patterns:
                    match = re.search(pattern, html, re.IGNORECASE | re.DOTALL)
                    if match and len(match.group(1)) > 500:
                        main_content = match.group(1)
                        break

                result["text"] = html_to_text(main_content, max_length)

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

        result = await self.fetch_url(url, max_length)
        result["document_id"] = document_id

        try:
            api_url = f"https://api.regulations.gov/v4/documents/{document_id}"
            headers = {
                "X-Api-Key": self.settings.gov_api_key,
                "Accept": "application/json",
            }

            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.get(api_url, headers=headers)

                if response.status_code == 200:
                    data = response.json()
                    attrs = data.get("data", {}).get("attributes", {})

                    additional_content = []

                    if attrs.get("title"):
                        additional_content.append(f"Title: {attrs['title']}")
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

                    if additional_content:
                        api_content = "\n".join(additional_content)
                        if result.get("text"):
                            result["text"] = api_content + "\n\n---\n\n" + result["text"]
                        else:
                            result["text"] = api_content

        except Exception as e:
            logger.warning(f"Could not fetch API details for {document_id}: {e}")

        return result
