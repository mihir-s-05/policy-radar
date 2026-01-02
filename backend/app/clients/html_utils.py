import re
from typing import Optional


def html_to_text(html: str, max_length: Optional[int] = 15000) -> str:
    html = re.sub(r"<script[^>]*>.*?</script>", "", html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r"<style[^>]*>.*?</style>", "", html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r"<head[^>]*>.*?</head>", "", html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r"<nav[^>]*>.*?</nav>", "", html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r"<footer[^>]*>.*?</footer>", "", html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r"<!--.*?-->", "", html, flags=re.DOTALL)

    html = re.sub(r"</(p|div|h[1-6]|li|tr|section|article)[^>]*>", "\n", html, flags=re.IGNORECASE)
    html = re.sub(r"<(br|hr)[^>]*/?>", "\n", html, flags=re.IGNORECASE)

    text = re.sub(r"<[^>]+>", " ", html)

    entities = {
        "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">",
        "&quot;": "\"", "&#39;": "'", "&apos;": "'",
        "&mdash;": "--", "&ndash;": "-", "&hellip;": "...",
        "&copy;": "(c)", "&reg;": "(R)", "&trade;": "(TM)",
    }
    for entity, char in entities.items():
        text = text.replace(entity, char)

    text = re.sub(r"&#(\\d+);", lambda m: chr(int(m.group(1))), text)
    text = re.sub(r"&#x([0-9a-fA-F]+);", lambda m: chr(int(m.group(1), 16)), text)

    text = re.sub(r"[ \\t]+", " ", text)
    text = re.sub(r"\\n[ \\t]+", "\\n", text)
    text = re.sub(r"[ \\t]+\\n", "\\n", text)
    text = re.sub(r"\\n{3,}", "\\n\\n", text)
    text = text.strip()

    if max_length is not None and max_length > 0 and len(text) > max_length:
        truncated = text[:max_length]
        last_period = truncated.rfind(".")
        if last_period > max_length * 0.8:
            truncated = truncated[:last_period + 1]
        text = truncated + "\n\n[Content truncated due to length...]"

    return text
