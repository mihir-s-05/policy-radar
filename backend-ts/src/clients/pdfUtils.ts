import pdfParse from "pdf-parse";

export const PDF_TEXT_AVAILABLE = true;
export const PDF_IMAGE_AVAILABLE = false; // Images require more complex setup

export async function extractPdfText(
    content: Buffer,
    maxLength: number | null = 15000
): Promise<string | null> {
    try {
        const data = await pdfParse(content);
        let text = data.text || "";

        // Clean up text
        text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        text = text.replace(/[ \t]+/g, " ");
        text = text.replace(/\n{3,}/g, "\n\n");
        text = text.trim();

        if (!text) {
            return null;
        }

        // Truncate if needed
        if (maxLength && text.length > maxLength) {
            let truncated = text.slice(0, maxLength);
            const lastPeriod = truncated.lastIndexOf(".");
            if (lastPeriod > maxLength * 0.8) {
                truncated = truncated.slice(0, lastPeriod + 1);
            }
            text = truncated + "\n\n[Content truncated due to length...]";
        }

        return text;
    } catch (error) {
        console.warn("Failed to extract PDF text:", error);
        return null;
    }
}

export interface PdfImage {
    id: string;
    page: number;
    source: string;
    mime_type: string;
    width: number | null;
    height: number | null;
    byte_size: number;
    data_base64: string;
}

export async function extractPdfImages(
    _content: Buffer,
    _maxImages: number = 2,
    _maxPages: number = 2,
    _maxBytes: number = 200000,
    _maxPageDim: number = 800
): Promise<{ images: PdfImage[]; skipped: number }> {
    // Image extraction requires pymupdf equivalent (pdf2pic, pdfjs-dist, etc.)
    // This is a placeholder - implementing full image extraction requires additional deps
    return { images: [], skipped: 0 };
}
