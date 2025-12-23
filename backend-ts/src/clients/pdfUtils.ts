import pdfParse from "pdf-parse";

export async function extractPdfText(
    content: Buffer,
    maxLength: number | null = 15000
): Promise<string | null> {
    try {
        const data = await pdfParse(content);
        let text = data.text || "";

        text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        text = text.replace(/[ \t]+/g, " ");
        text = text.replace(/\n{3,}/g, "\n\n");
        text = text.trim();

        if (!text) {
            return null;
        }

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
