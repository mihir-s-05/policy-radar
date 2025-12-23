import { BaseAPIClient } from "./base.js";
import { getSettings } from "../config.js";
import type { SourceItem } from "../models/schemas.js";

export class SearchGovClient extends BaseAPIClient {
    private affiliate: string;
    private accessKey: string;

    constructor() {
        const settings = getSettings();
        super(settings.searchGovBaseUrl);
        this.affiliate = settings.searchGovAffiliate;
        this.accessKey = settings.searchGovAccessKey;
    }

    get isConfigured(): boolean {
        return Boolean(this.affiliate && this.accessKey);
    }

    private normalizeResult(result: Record<string, unknown>): SourceItem {
        return {
            source_type: "searchgov",
            id: ((result.link as string) || "").slice(0, 100),
            title: (result.title as string) || "Untitled",
            agency: null,
            date:
                (result.publication_date as string) ||
                (result.created_at as string) ||
                null,
            url: (result.link as string) || "",
            excerpt: result.snippet as string || null,
            content_type: "web_result",
            raw: result,
        };
    }

    async search(options: {
        query: string;
        enableHighlighting?: boolean;
        limit?: number;
        offset?: number;
    }): Promise<{ results: Record<string, unknown>[]; sources: SourceItem[] }> {
        const { query, enableHighlighting = false, limit = 10, offset = 0 } = options;

        const params: Record<string, string | number | boolean> = {
            affiliate: this.affiliate,
            access_key: this.accessKey,
            query,
            enable_highlighting: String(enableHighlighting).toLowerCase(),
            limit,
            offset,
        };

        const url = `${this.baseUrl}/results/i14y`;

        const data = await this.requestWithRetry<{
            web?: { results?: Record<string, unknown>[] };
        }>({
            url,
            params,
        });

        const webResults = data.web?.results || [];
        const sources = webResults.map((r) => this.normalizeResult(r));

        return { results: webResults, sources };
    }
}
