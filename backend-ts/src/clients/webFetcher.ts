import { getSettings } from "../config.js";
import { extractPdfText } from "./pdfUtils.js";

export function htmlToText(html: string, maxLength: number | null = 15000): string {
    let text = html;
    text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
    text = text.replace(/<head[^>]*>[\s\S]*?<\/head>/gi, "");
    text = text.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "");
    text = text.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "");
    text = text.replace(/<!--[\s\S]*?-->/g, "");

    text = text.replace(/<\/(p|div|h[1-6]|li|tr|section|article)[^>]*>/gi, "\n");
    text = text.replace(/<(br|hr)[^>]*\/?>(\s*)/gi, "\n");

    text = text.replace(/<[^>]+>/g, " ");

    const entities: Record<string, string> = {
        "&nbsp;": " ",
        "&amp;": "&",
        "&lt;": "<",
        "&gt;": ">",
        "&quot;": "\"",
        "&#39;": "'",
        "&apos;": "'",
        "&mdash;": "--",
        "&ndash;": "-",
        "&hellip;": "...",
        "&copy;": "(c)",
        "&reg;": "(R)",
        "&trade;": "(TM)",
    };
    for (const [entity, value] of Object.entries(entities)) {
        text = text.replace(new RegExp(entity, "g"), value);
    }

    text = text.replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)));
    text = text.replace(/&#x([0-9a-fA-F]+);/g, (_, num) => String.fromCharCode(parseInt(num, 16)));

    text = text.replace(/[ \t]+/g, " ");
    text = text.replace(/\n[ \t]+/g, "\n");
    text = text.replace(/[ \t]+\n/g, "\n");
    text = text.replace(/\n{3,}/g, "\n\n");
    text = text.trim();

    if (maxLength !== null && maxLength > 0 && text.length > maxLength) {
        let truncated = text.slice(0, maxLength);
        const lastPeriod = truncated.lastIndexOf(".");
        if (lastPeriod > maxLength * 0.8) {
            truncated = truncated.slice(0, lastPeriod + 1);
        }
        text = truncated + "\n\n[Content truncated due to length...]";
    }

    return text;
}

export class WebFetcher {
    private timeout: number;
    private settings = getSettings();

    constructor(timeout: number = 30000) {
        this.timeout = timeout;
    }

    private normalizeUrl(url: string): string {
        let normalized = (url || "").trim();
        if (!normalized) {
            throw new Error("Missing URL");
        }

        try {
            const parsed = new URL(normalized);
            if (!parsed.protocol) {
                normalized = `https://${normalized}`;
            }
        } catch {
            normalized = `https://${normalized}`;
        }

        const parsed = new URL(normalized);
        if (!["http:", "https:"].includes(parsed.protocol)) {
            throw new Error("Unsupported URL scheme");
        }

        return normalized;
    }

    private parseRetryAfter(value: string | null): number | null {
        if (!value) return null;
        const numeric = Number(value);
        if (Number.isFinite(numeric)) return numeric;
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) {
            const now = Date.now();
            return Math.max(0, (parsed - now) / 1000);
        }
        return null;
    }

    private isProbablyPdf(contentType: string, url: string, content: Buffer): boolean {
        if (contentType.includes("application/pdf")) return true;
        if (url.toLowerCase().endsWith(".pdf")) return true;
        return content.slice(0, 4).toString() === "%PDF";
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

    private buildHeaders(variant: "bot" | "browser" = "bot"): Record<string, string> {
        if (variant === "browser") {
            return {
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
                Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
                "Accept-Encoding": "gzip, deflate",
            };
        }

        return {
            "User-Agent": "PolicyRadarBot/1.0 (Federal Policy Research Tool)",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Accept-Encoding": "gzip, deflate",
        };
    }

    private async fetchBestFileFormat(
        fileFormats: Array<{ format?: string; fileUrl?: string }>,
        maxLength: number | null
    ): Promise<Record<string, unknown> | null> {
        const preferred = ["html", "htm", "txt", "xml", "pdf"];
        const byFormat: Record<string, string> = {};
        for (const fmt of fileFormats) {
            if (fmt.fileUrl) {
                byFormat[(fmt.format || "").toLowerCase()] = fmt.fileUrl;
            }
        }

        for (const fmt of preferred) {
            const fileUrl = byFormat[fmt];
            if (!fileUrl) continue;
            const result = await this.fetchUrl(fileUrl, maxLength);
            if (result.text) {
                return result;
            }
        }

        return null;
    }

    private async fetchPdfImagesOnly(_url: string): Promise<{ images: unknown[]; skipped: number }> {
        return { images: [], skipped: 0 };
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
        image_count?: number;
    }> {
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
            image_count?: number;
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

            let backoff = this.settings.initialBackoff * 1000;
            const maxAttempts = this.settings.maxRetries + 1;
            let lastError: Error | null = null;

            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                let shouldRetry = false;
                let retryWait: number | null = null;

                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), this.timeout);

                for (const variant of ["bot", "browser"] as const) {
                    let response: Response | null = null;
                    try {
                        response = await fetch(normalizedUrl, {
                            headers: this.buildHeaders(variant),
                            signal: controller.signal,
                            redirect: "follow",
                        });
                    } catch (error) {
                        lastError = error as Error;
                        shouldRetry = true;
                        break;
                    }

                    if (!response) {
                        shouldRetry = true;
                        break;
                    }

                    if (response.status === 403 && variant === "bot") {
                        continue;
                    }

                if (response.status === 429) {
                    const retryAfter = this.parseRetryAfter(response.headers.get("Retry-After"));
                    if (attempt < maxAttempts - 1) {
                        shouldRetry = true;
                        retryWait = retryAfter !== null ? retryAfter * 1000 : backoff;
                    } else {
                        result.error = "Rate limited (429). Please try again later.";
                        clearTimeout(timeoutId);
                        return result;
                    }
                    break;
                }

                    if (response.status === 408 || response.status >= 500) {
                        if (attempt < maxAttempts - 1) {
                            shouldRetry = true;
                            retryWait = backoff;
                        } else {
                            result.error = `HTTP ${response.status}`;
                            clearTimeout(timeoutId);
                            return result;
                        }
                        break;
                    }

                    if (response.status !== 200) {
                        result.error = `HTTP ${response.status}`;
                        clearTimeout(timeoutId);
                        return result;
                    }

                    const contentType = (response.headers.get("content-type") || "").toLowerCase();
                    const rawContent = Buffer.from(await response.arrayBuffer());

                    if (this.isProbablyPdf(contentType, normalizedUrl, rawContent)) {
                        result.content_type = contentType || "application/pdf";
                        result.content_format = "pdf";
                        result.pdf_url = normalizedUrl;

                        const pdfText = await extractPdfText(rawContent, maxLength);
                        const imageData = await this.fetchPdfImagesOnly(normalizedUrl);

                        if (pdfText) {
                            result.text = pdfText;
                        }
                        if (imageData.images.length) {
                            result.images = imageData.images;
                            result.image_count = imageData.images.length;
                            if (imageData.skipped) {
                                result.images_skipped = imageData.skipped;
                            }
                        }

                        if (result.text || result.images) {
                            clearTimeout(timeoutId);
                            return result;
                        }

                        result.error = "PDF content could not be extracted.";
                        clearTimeout(timeoutId);
                        return result;
                    }

                    if (!this.isSupportedContentType(contentType, rawContent)) {
                        const label = contentType || "unknown";
                        result.error = `Unsupported content type: ${label}`;
                        clearTimeout(timeoutId);
                        return result;
                    }

                    result.content_type = contentType;
                    if (contentType.includes("html") || contentType.includes("xml")) {
                        result.content_format = "html";
                    } else if (contentType.startsWith("text/")) {
                        result.content_format = "text";
                    } else {
                        result.content_format = "text";
                    }

                    const html = rawContent.toString("utf-8");

                    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
                    if (titleMatch) {
                        result.title = htmlToText(titleMatch[1], 200);
                    }

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

                    result.text = htmlToText(mainContent, maxLength);
                    clearTimeout(timeoutId);
                    return result;
                }

                clearTimeout(timeoutId);
                if (shouldRetry && attempt < maxAttempts - 1) {
                    const waitTime = retryWait !== null ? retryWait : backoff;
                    console.warn(`Fetch attempt ${attempt + 1} failed. Retrying in ${waitTime / 1000}s.`);
                    await new Promise((resolve) => setTimeout(resolve, waitTime));
                    backoff = Math.min(backoff * 2, 30000);
                    continue;
                }

                if (lastError) {
                    result.error = `Request failed: ${lastError}`;
                } else {
                    result.error = "Request failed after retries";
                }
                return result;
            }
        } catch (error) {
            if ((error as Error).name === "AbortError") {
                result.error = "Request timed out";
            } else {
                result.error = `Request failed: ${(error as Error).message}`;
            }
            return result;
        }

        return result;
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
        image_count?: number;
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
            image_count?: number;
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
        let fileFormats: Array<{ format?: string; fileUrl?: string }> = [];
        let apiError: string | null = null;

        try {
            const apiUrl = `https://api.regulations.gov/v4/documents/${documentId}`;
            const response = await fetch(apiUrl, {
                headers: {
                    "X-Api-Key": this.settings.govApiKey,
                    Accept: "application/json",
                },
            });

            if (response.ok) {
                const data = (await response.json()) as Record<string, unknown>;
                const docData = data.data as Record<string, unknown> | undefined;
                attrs = (docData?.attributes as Record<string, unknown>) || {};
                fileFormats = (attrs.fileFormats as Array<{ format?: string; fileUrl?: string }>) || [];
            } else {
                apiError = `HTTP ${response.status}`;
            }
        } catch (error) {
            apiError = (error as Error).message;
            console.warn(`Could not fetch API details for ${documentId}: ${error}`);
        }

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
        let images: unknown[] = [];
        let imagesSkipped: number | null = null;
        let pdfUrl: string | null = null;

        if (Array.isArray(fileFormats)) {
            for (const fmt of fileFormats) {
                if ((fmt.format || "").toLowerCase() === "pdf" && fmt.fileUrl) {
                    pdfUrl = fmt.fileUrl;
                    break;
                }
            }
        }

        let fileResult: Record<string, unknown> | null = null;
        if (Array.isArray(fileFormats) && fileFormats.length) {
            fileResult = await this.fetchBestFileFormat(fileFormats, maxLength);
        }

        if (fileResult) {
            if (fileResult.text) {
                bodyText = fileResult.text as string;
            }
            if (fileResult.title && !result.title) {
                result.title = fileResult.title as string;
            }
            if (fileResult.content_format) {
                result.content_format = fileResult.content_format as string;
            }
            if (fileResult.content_type) {
                result.content_type = fileResult.content_type as string;
            }
            if (fileResult.pdf_url) {
                result.pdf_url = fileResult.pdf_url as string;
            }
            if (Array.isArray(fileResult.images)) {
                images = fileResult.images;
                imagesSkipped = (fileResult.images_skipped as number) || imagesSkipped;
            }
        }

        if (!bodyText && !images.length) {
            const fallback = await this.fetchUrl(url, maxLength);
            if (fallback.text) {
                bodyText = fallback.text;
            }
            if (fallback.images) {
                images = fallback.images;
                imagesSkipped = fallback.images_skipped || imagesSkipped;
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
            if (fallback.pdf_url && !result.pdf_url) {
                result.pdf_url = fallback.pdf_url;
            }
            if (!result.error && fallback.error) {
                result.error = fallback.error;
            }
        }

        if (!images.length && pdfUrl) {
            const pdfImages = await this.fetchPdfImagesOnly(pdfUrl);
            if (pdfImages.images.length) {
                images = pdfImages.images;
                imagesSkipped = pdfImages.skipped;
                result.pdf_url = pdfUrl;
            }
        }

        if (pdfUrl && !result.pdf_url) {
            result.pdf_url = pdfUrl;
        }

        if (images.length) {
            result.images = images;
            result.image_count = images.length;
            if (imagesSkipped) {
                result.images_skipped = imagesSkipped;
            }
        }

        if (additionalContent.length > 0) {
            const apiContent = additionalContent.join("\n");
            if (bodyText) {
                result.text = `${apiContent}\n\n---\n\n${bodyText}`;
            } else {
                result.text = apiContent;
            }
        } else if (bodyText) {
            result.text = bodyText;
        }

        if (result.text || result.images) {
            result.error = null;
        } else if (!result.error) {
            result.error = apiError || "No content available.";
        }

        return result;
    }
}
