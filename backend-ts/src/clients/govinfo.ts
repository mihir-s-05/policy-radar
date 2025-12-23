import { BaseAPIClient } from "./base.js";
import { getSettings } from "../config.js";
import type { SourceItem } from "../models/schemas.js";
import { extractPdfText } from "./pdfUtils.js";

export function htmlToText(html: string, maxLength: number = 15000): string {
    let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");

    text = text.replace(/<\/(p|div|h[1-6]|li|tr|br)[^>]*>/gi, "\n");
    text = text.replace(/<(br|hr)[^>]*\/?>/gi, "\n");

    text = text.replace(/<[^>]+>/g, "");

    text = text.replace(/&nbsp;/g, " ");
    text = text.replace(/&amp;/g, "&");
    text = text.replace(/&lt;/g, "<");
    text = text.replace(/&gt;/g, ">");
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/&#39;/g, "'");

    text = text.replace(/[ \t]+/g, " ");
    text = text.replace(/\n\s*\n/g, "\n\n");
    text = text.trim();

    if (text.length > maxLength) {
        text = text.slice(0, maxLength) + "\n\n[Content truncated due to length...]";
    }

    return text;
}

export class GovInfoClient extends BaseAPIClient {
    private apiKey: string;

    constructor() {
        const settings = getSettings();
        super(settings.govInfoBaseUrl);
        this.apiKey = settings.govApiKey;
    }

    private addApiKey(params: Record<string, string | number> = {}): Record<string, string | number> {
        return { ...params, api_key: this.apiKey };
    }

    private normalizeSearchResult(result: Record<string, unknown>): SourceItem {
        const packageId = result.packageId as string || "";
        const title = result.title as string || "Untitled";

        let url = `https://www.govinfo.gov/app/details/${packageId}`;
        if (result.granuleId) {
            url = `https://www.govinfo.gov/app/details/${packageId}/${result.granuleId}`;
        }

        const date = (result.lastModified as string) || (result.dateIssued as string) || null;

        let agency: string | null = null;
        const authors = result.governmentAuthor;
        if (Array.isArray(authors) && authors.length > 0) {
            agency = authors[0] as string;
        } else if (typeof authors === "string") {
            agency = authors;
        }

        return {
            source_type: "govinfo_result",
            id: packageId,
            title,
            agency,
            date,
            url,
            excerpt: (result.abstract as string) || (result.description as string) || null,
        };
    }

    private normalizePackage(pkg: Record<string, unknown>): SourceItem {
        const packageId = pkg.packageId as string || "";
        const title = pkg.title as string || "Untitled Package";

        const url = `https://www.govinfo.gov/app/details/${packageId}`;

        return {
            source_type: "govinfo_package",
            id: packageId,
            title,
            agency: pkg.publisher as string || null,
            date: (pkg.lastModified as string) || (pkg.dateIssued as string) || null,
            url,
            excerpt: (pkg.abstract as string) || (pkg.description as string) || null,
        };
    }

    async search(options: {
        query: string;
        pageSize?: number;
        offsetMark?: string;
        sorts?: { field: string; sortOrder: string }[];
    }): Promise<{ data: Record<string, unknown>; sources: SourceItem[] }> {
        const {
            query,
            pageSize = 10,
            offsetMark = "*",
            sorts = [{ field: "lastModified", sortOrder: "DESC" }],
        } = options;

        const url = `${this.baseUrl}/search`;
        const params = this.addApiKey();

        const data = await this.requestWithRetry<Record<string, unknown>>({
            method: "POST",
            url,
            params,
            json: {
                query,
                pageSize: String(pageSize),
                offsetMark,
                sorts,
            },
            useCache: false,
        });

        const results = (data.results || []) as Record<string, unknown>[];
        const sources = results.map((r) => this.normalizeSearchResult(r));

        return { data, sources };
    }

    async getPackageSummary(packageId: string): Promise<{ data: Record<string, unknown>; source: SourceItem }> {
        const url = `${this.baseUrl}/packages/${packageId}/summary`;
        const params = this.addApiKey();

        const data = await this.requestWithRetry<Record<string, unknown>>({
            url,
            params,
        });

        const source = this.normalizePackage(data);

        return { data, source };
    }

    async getPackageContent(options: {
        packageId: string;
        maxLength?: number;
    }): Promise<{
        text: string;
        source: SourceItem;
        images: unknown[];
        imagesSkipped: number;
        contentFormat: string;
        pdfUrl: string | null;
    }> {
        const { packageId, maxLength = 15000 } = options;

        const { data: summary, source } = await this.getPackageSummary(packageId);

        const pdfUrl = `${this.baseUrl}/packages/${packageId}/pdf`;

        const formats = ["htm", "xml", "txt"];
        let textResult = "";
        let contentFormat = "unknown";

        for (const fmt of formats) {
            try {
                const contentUrl = new URL(`${this.baseUrl}/packages/${packageId}/${fmt}`);
                contentUrl.searchParams.set("api_key", this.apiKey);
                const response = await fetch(contentUrl.toString(), {
                    headers: { Accept: "text/html,application/xml,text/plain" },
                });

                if (response.ok) {
                    const contentType = response.headers.get("content-type") || "";
                    if (
                        contentType.startsWith("text/") ||
                        contentType.includes("html") ||
                        contentType.includes("xml")
                    ) {
                        const html = await response.text();
                        const text = htmlToText(html, maxLength);
                        if (text) {
                            textResult = text;
                            contentFormat = fmt;
                            break;
                        }
                    }
                }
            } catch (error) {
                console.warn(`Failed to fetch ${fmt} for ${packageId}: ${error}`);
            }
        }

        if (!textResult) {
            try {
                const pdfFetchUrl = new URL(pdfUrl);
                pdfFetchUrl.searchParams.set("api_key", this.apiKey);
                const response = await fetch(pdfFetchUrl.toString());
                if (response.ok) {
                    const pdfBuffer = Buffer.from(await response.arrayBuffer());
                    textResult = await extractPdfText(pdfBuffer, maxLength) || "";
                    contentFormat = "pdf";
                }
            } catch (error) {
                console.warn(`Failed to fetch PDF for ${packageId}: ${error}`);
            }
        }

        if (!textResult) {
            textResult = (summary.abstract as string) || (summary.description as string) || "No content available.";
        }

        return {
            text: textResult,
            source,
            images: [],
            imagesSkipped: 0,
            contentFormat,
            pdfUrl,
        };
    }

    async getCollection(options: {
        collectionCode: string;
        startDatetime?: string;
        pageSize?: number;
        offsetMark?: string;
    }): Promise<{ data: Record<string, unknown>; sources: SourceItem[] }> {
        const {
            collectionCode,
            startDatetime,
            pageSize = 10,
            offsetMark = "*",
        } = options;

        const start = startDatetime || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

        const url = `${this.baseUrl}/collections/${collectionCode}/${start}`;
        const params = this.addApiKey({
            pageSize,
            offsetMark,
        });

        const data = await this.requestWithRetry<Record<string, unknown>>({
            url,
            params,
        });

        const packages = (data.packages || []) as Record<string, unknown>[];
        const sources = packages.map((p) => this.normalizePackage(p));

        return { data, sources };
    }
}

export function buildGovInfoQuery(options: {
    keywords: string;
    collection?: string;
    days?: number;
}): string {
    const { keywords, collection, days } = options;
    const cleanKeywords = (keywords || "").trim();
    const parts: string[] = [];
    const lowered = cleanKeywords.toLowerCase();

    if (collection && !lowered.includes("collection:")) {
        parts.push(`collection:${collection}`);
    }

    if (cleanKeywords) {
        parts.push(cleanKeywords);
    }

    if (days && !lowered.includes("publishdate:range") && !lowered.includes("dateissued:range")) {
        const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
        parts.push(`publishdate:range(${startDate},)`);
    }

    return parts.join(" AND ");
}
