import { getSettings } from "../config.js";
import type { SourceItem } from "../models/schemas.js";
import { htmlToText } from "./govinfo.js";
import { extractPdfText } from "./pdfUtils.js";

export class WebFetcher {
    private timeout: number;
    private settings = getSettings();

    constructor(timeout: number = 30000) {
        this.timeout = timeout;
    }

    private normalizeUrl(url: string): string {
        url = (url || "").trim();
        if (!url) {
            throw new Error("Missing URL");
        }

        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            url = `https://${url}`;
        }

        const parsed = new URL(url);
        if (!["http:", "https:"].includes(parsed.protocol)) {
            throw new Error("Unsupported URL scheme");
        }

        return url;
    }

    private isProbablyPdf(contentType: string, url: string, content: Buffer): boolean {
        if (contentType.includes("application/pdf")) {
            return true;
        }
        if (url.toLowerCase().endsWith(".pdf")) {
            return true;
        }
        // Check PDF magic bytes
        return content.slice(0, 4).toString() === "%PDF";
    }

    private isSupportedContentType(contentType: string, content: Buffer): boolean {
        if (!contentType) {
            return this.looksLikeText(content);
        }

        if (contentType.startsWith("text/")) {
            return true;
        }

        if (contentType.includes("html") || contentType.includes("xml") || contentType.includes("json")) {
            return true;
        }

        if (contentType.includes("octet-stream") || contentType.includes("binary")) {
            return this.looksLikeText(content);
        }

        return false;
    }

    private looksLikeText(content: Buffer): boolean {
        if (!content.length) return true;
        const sample = content.slice(0, 1024);
        if (sample.includes(0)) return false;
        const printable = [...sample].filter(
            (b) => (b >= 32 && b <= 126) || [9, 10, 13].includes(b)
        ).length;
        return printable / sample.length > 0.85;
    }

    private buildHeaders(variant: "bot" | "browser" = "bot"): Record<string, string> {
        if (variant === "browser") {
            return {
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
                Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
            };
        }

        return {
            "User-Agent": "PolicyRadarBot/1.0 (Federal Policy Research Tool)",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        };
    }

    async fetchUrl(
        url: string,
        maxLength: number | null = 15000
    ): Promise<{
        url: string;
        title: string | null;
        text: string | null;
        error: string | null;
        content_type: string | null;
        content_format: string | null;
        pdf_url: string | null;
        images?: unknown[];
        images_skipped?: number;
    }> {
        console.log(`Fetching URL content: ${url}`);

        const result: {
            url: string;
            title: string | null;
            text: string | null;
            error: string | null;
            content_type: string | null;
            content_format: string | null;
            pdf_url: string | null;
            images?: unknown[];
            images_skipped?: number;
        } = {
            url,
            title: null,
            text: null,
            error: null,
            content_type: null,
            content_format: null,
            pdf_url: null,
        };

        try {
            const normalizedUrl = this.normalizeUrl(url);
            result.url = normalizedUrl;

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.timeout);

            let response: Response | null = null;
            let lastError: Error | null = null;

            // Try bot headers first, then browser headers
            for (const variant of ["bot", "browser"] as const) {
                try {
                    response = await fetch(normalizedUrl, {
                        headers: this.buildHeaders(variant),
                        signal: controller.signal,
                        redirect: "follow",
                    });

                    if (response.status === 403 && variant === "bot") {
                        continue;
                    }

                    break;
                } catch (error) {
                    lastError = error as Error;
                }
            }

            clearTimeout(timeoutId);

            if (!response) {
                result.error = lastError?.message || "Request failed";
                return result;
            }

            if (!response.ok) {
                result.error = `HTTP ${response.status}`;
                return result;
            }

            const contentType = (response.headers.get("content-type") || "").toLowerCase();
            const rawContent = Buffer.from(await response.arrayBuffer());

            // Handle PDFs
            if (this.isProbablyPdf(contentType, normalizedUrl, rawContent)) {
                result.content_type = contentType || "application/pdf";
                result.content_format = "pdf";
                result.pdf_url = normalizedUrl;

                const pdfText = await extractPdfText(rawContent, maxLength);
                if (pdfText) {
                    result.text = pdfText;
                } else {
                    result.error = "PDF content could not be extracted.";
                }

                return result;
            }

            // Handle unsupported content types
            if (!this.isSupportedContentType(contentType, rawContent)) {
                result.error = `Unsupported content type: ${contentType || "unknown"}`;
                return result;
            }

            result.content_type = contentType;
            result.content_format = contentType.includes("html") || contentType.includes("xml") ? "html" : "text";

            const html = rawContent.toString("utf-8");

            // Extract title
            const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
            if (titleMatch) {
                result.title = htmlToText(titleMatch[1], 200);
            }

            // Extract main content
            let mainContent = html;
            const mainPatterns = [
                /<main[^>]*>([\s\S]*?)<\/main>/i,
                /<article[^>]*>([\s\S]*?)<\/article>/i,
                /<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
                /<div[^>]*id="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
            ];

            for (const pattern of mainPatterns) {
                const match = html.match(pattern);
                if (match && match[1].length > 500) {
                    mainContent = match[1];
                    break;
                }
            }

            result.text = htmlToText(mainContent, maxLength || undefined);

            return result;
        } catch (error) {
            if ((error as Error).name === "AbortError") {
                result.error = "Request timed out";
            } else {
                result.error = `Request failed: ${(error as Error).message}`;
            }
            return result;
        }
    }

    async fetchRegulationsDocumentContent(
        documentId: string,
        maxLength: number | null = 15000
    ): Promise<{
        url: string;
        title: string | null;
        text: string | null;
        error: string | null;
        content_type: string | null;
        content_format: string | null;
        pdf_url: string | null;
        document_id: string;
        images?: unknown[];
        images_skipped?: number;
    }> {
        const url = `https://www.regulations.gov/document/${documentId}`;
        const result: {
            url: string;
            title: string | null;
            text: string | null;
            error: string | null;
            content_type: string | null;
            content_format: string | null;
            pdf_url: string | null;
            document_id: string;
            images?: unknown[];
            images_skipped?: number;
        } = {
            url,
            title: null,
            text: null,
            error: null,
            content_type: null,
            content_format: null,
            pdf_url: null,
            document_id: documentId,
        };

        let attrs: Record<string, unknown> = {};
        let fileFormats: { format?: string; fileUrl?: string }[] = [];
        let apiError: string | null = null;

        // Fetch document metadata from API
        try {
            const apiUrl = `https://api.regulations.gov/v4/documents/${documentId}`;
            const response = await fetch(apiUrl, {
                headers: {
                    "X-Api-Key": this.settings.govApiKey,
                    Accept: "application/json",
                },
            });

            if (response.ok) {
                const data = await response.json() as Record<string, unknown>;
                const docData = data.data as Record<string, unknown> | undefined;
                attrs = (docData?.attributes as Record<string, unknown>) || {};
                fileFormats = (attrs.fileFormats as { format?: string; fileUrl?: string }[]) || [];
            } else {
                apiError = `HTTP ${response.status}`;
            }
        } catch (error) {
            apiError = (error as Error).message;
            console.warn(`Could not fetch API details for ${documentId}: ${error}`);
        }

        // Build additional content from metadata
        const additionalContent: string[] = [];
        if (attrs.title) {
            additionalContent.push(`Title: ${attrs.title}`);
            result.title = attrs.title as string;
        }
        if (attrs.agencyId) {
            additionalContent.push(`Agency: ${attrs.agencyId}`);
        }
        if (attrs.documentType) {
            additionalContent.push(`Document Type: ${attrs.documentType}`);
        }
        if (attrs.postedDate) {
            additionalContent.push(`Posted: ${attrs.postedDate}`);
        }
        if (attrs.summary) {
            additionalContent.push(`\nSummary:\n${attrs.summary}`);
        }
        if (attrs.abstract) {
            additionalContent.push(`\nAbstract:\n${attrs.abstract}`);
        }

        let bodyText: string | null = null;
        let pdfUrl: string | null = null;

        // Find PDF URL
        for (const fmt of fileFormats) {
            if ((fmt.format || "").toLowerCase() === "pdf" && fmt.fileUrl) {
                pdfUrl = fmt.fileUrl;
                break;
            }
        }

        // Try to fetch file content
        const preferredFormats = ["html", "htm", "txt", "xml", "pdf"];
        for (const targetFormat of preferredFormats) {
            const fmt = fileFormats.find(
                (f) => (f.format || "").toLowerCase() === targetFormat && f.fileUrl
            );
            if (fmt?.fileUrl) {
                const fetchResult = await this.fetchUrl(fmt.fileUrl, maxLength);
                if (fetchResult.text) {
                    bodyText = fetchResult.text;
                    result.content_format = fetchResult.content_format;
                    result.content_type = fetchResult.content_type;
                    if (fetchResult.pdf_url) {
                        result.pdf_url = fetchResult.pdf_url;
                    }
                    break;
                }
            }
        }

        // Fallback to webpage
        if (!bodyText) {
            const fallback = await this.fetchUrl(url, maxLength);
            if (fallback.text) {
                bodyText = fallback.text;
            }
            if (fallback.title && !result.title) {
                result.title = fallback.title;
            }
            if (fallback.content_format && !result.content_format) {
                result.content_format = fallback.content_format;
            }
            if (fallback.content_type && !result.content_type) {
                result.content_type = fallback.content_type;
            }
        }

        if (pdfUrl && !result.pdf_url) {
            result.pdf_url = pdfUrl;
        }

        // Combine content
        if (additionalContent.length > 0) {
            const apiContent = additionalContent.join("\n");
            result.text = bodyText ? `${apiContent}\n\n---\n\n${bodyText}` : apiContent;
        } else if (bodyText) {
            result.text = bodyText;
        }

        if (!result.text && !result.error) {
            result.error = apiError || "No content available.";
        }

        return result;
    }
}
