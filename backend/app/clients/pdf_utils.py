import base64
from io import BytesIO
from typing import Optional

try:
    from pypdf import PdfReader
    PDF_TEXT_AVAILABLE = True
except ImportError:
    PDF_TEXT_AVAILABLE = False

try:
    import pdfplumber
    PDF_PLUMBER_AVAILABLE = True
except ImportError:
    PDF_PLUMBER_AVAILABLE = False

PDF_TEXT_AVAILABLE = PDF_TEXT_AVAILABLE or PDF_PLUMBER_AVAILABLE

try:
    import fitz
    PDF_IMAGE_AVAILABLE = True
except ImportError:
    PDF_IMAGE_AVAILABLE = False


def extract_pdf_text_sync(
    content: bytes,
    max_length: Optional[int],
) -> Optional[str]:
    text = None
    if PDF_PLUMBER_AVAILABLE:
        try:
            chunks = []
            total = 0
            with pdfplumber.open(BytesIO(content)) as pdf:
                for page in pdf.pages:
                    page_text = page.extract_text() or ""
                    if not page_text.strip():
                        continue
                    chunks.append(page_text)
                    total += len(page_text)
                    if max_length and total >= max_length:
                        break
            text = "\n\n".join(chunks).strip()
        except Exception:
            text = None

    if not text and PDF_TEXT_AVAILABLE:
        reader = PdfReader(BytesIO(content))
        chunks = []
        total = 0

        for page in reader.pages:
            page_text = page.extract_text() or ""
            if not page_text.strip():
                continue
            chunks.append(page_text)
            total += len(page_text)
            if max_length and total >= max_length:
                break

        text = "\n\n".join(chunks).strip()

    if not text:
        return None

    if max_length and len(text) > max_length:
        truncated = text[:max_length]
        last_period = truncated.rfind(".")
        if last_period > max_length * 0.8:
            truncated = truncated[:last_period + 1]
        text = truncated + "\n\n[Content truncated due to length...]"

    return text


def extract_pdf_images_sync(
    content: bytes,
    max_images: int = 2,
    max_pages: int = 2,
    max_bytes: int = 200_000,
    max_page_dim: int = 800,
) -> tuple[list[dict], int]:
    if not PDF_IMAGE_AVAILABLE:
        return [], 0

    images: list[dict] = []
    skipped = 0
    seen: set[int] = set()

    try:
        doc = fitz.open(stream=content, filetype="pdf")
    except Exception:
        return [], 0

    try:
        for page_index, page in enumerate(doc):
            if page_index >= max_pages or len(images) >= max_images:
                break

            try:
                page_images = page.get_images(full=True)
            except Exception:
                continue

            for image in page_images:
                if len(images) >= max_images:
                    break
                xref = image[0]
                if xref in seen:
                    continue
                seen.add(xref)

                extracted = _extract_image_bytes(doc, xref)
                if not extracted:
                    continue

                image_bytes, mime_type, width, height = extracted
                if len(image_bytes) > max_bytes:
                    skipped += 1
                    continue

                image_id = f"pdfimg-p{page_index + 1}-{len(images) + 1}"
                images.append(
                    {
                        "id": image_id,
                        "page": page_index + 1,
                        "source": "embedded",
                        "mime_type": mime_type,
                        "width": width,
                        "height": height,
                        "byte_size": len(image_bytes),
                        "data_base64": base64.b64encode(image_bytes).decode("ascii"),
                    }
                )

        if not images:
            for page_index, page in enumerate(doc):
                if page_index >= max_pages or len(images) >= max_images:
                    break

                rendered = _render_page_png(page, max_page_dim, max_bytes)
                if not rendered:
                    skipped += 1
                    continue

                image_bytes, width, height = rendered
                image_id = f"pdfpage-p{page_index + 1}"
                images.append(
                    {
                        "id": image_id,
                        "page": page_index + 1,
                        "source": "page_render",
                        "mime_type": "image/png",
                        "width": width,
                        "height": height,
                        "byte_size": len(image_bytes),
                        "data_base64": base64.b64encode(image_bytes).decode("ascii"),
                    }
                )
    finally:
        doc.close()

    return images, skipped


def _extract_image_bytes(
    doc,
    xref: int,
) -> Optional[tuple[bytes, str, Optional[int], Optional[int]]]:
    try:
        info = doc.extract_image(xref)
    except Exception:
        info = None

    if info and info.get("image"):
        image_bytes = info["image"]
        ext = (info.get("ext") or "png").lower()
        width = info.get("width")
        height = info.get("height")
        if ext in {"png", "jpg", "jpeg", "webp"}:
            mime_type = "image/jpeg" if ext in {"jpg", "jpeg"} else f"image/{ext}"
            return image_bytes, mime_type, width, height

    try:
        pix = fitz.Pixmap(doc, xref)
        if pix.n - pix.alpha >= 4:
            pix = fitz.Pixmap(fitz.csRGB, pix)
        image_bytes = pix.tobytes("png")
        return image_bytes, "image/png", pix.width, pix.height
    except Exception:
        return None


def _render_page_png(
    page,
    max_page_dim: int,
    max_bytes: int,
) -> Optional[tuple[bytes, int, int]]:
    rect = page.rect
    max_side = max(rect.width, rect.height)
    if not max_side:
        return None

    zoom = min(1.0, max_page_dim / max_side)
    for _ in range(3):
        try:
            pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
            if pix.n - pix.alpha >= 4:
                pix = fitz.Pixmap(fitz.csRGB, pix)
            image_bytes = pix.tobytes("png")
        except Exception:
            return None

        if len(image_bytes) <= max_bytes or zoom <= 0.2:
            return image_bytes, pix.width, pix.height

        zoom *= 0.7

    return None
