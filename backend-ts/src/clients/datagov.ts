import { BaseAPIClient } from "./base.js";
import { getSettings } from "../config.js";
import type { SourceItem } from "../models/schemas.js";

export class DataGovClient extends BaseAPIClient {
    private apiKey: string;

    constructor() {
        const settings = getSettings();
        super(settings.dataGovBaseUrl);
        this.apiKey = settings.govApiKey;
    }

    private getHeaders(): Record<string, string> {
        const headers: Record<string, string> = { Accept: "application/json" };
        if (this.apiKey) {
            headers["X-Api-Key"] = this.apiKey;
        }
        return headers;
    }

    private normalizeDataset(dataset: Record<string, unknown>): SourceItem {
        const resources = (dataset.resources || []) as { format?: string; url?: string }[];
        let pdfUrl: string | null = null;

        for (const resource of resources) {
            if ((resource.format || "").toUpperCase() === "PDF" && resource.url) {
                pdfUrl = resource.url;
                break;
            }
        }

        const organization = dataset.organization as Record<string, unknown> | undefined;
        const agency = organization?.title as string || null;

        const datasetId = (dataset.id as string) || (dataset.name as string) || "";
        const url = `https://catalog.data.gov/dataset/${datasetId}`;

        const notes = dataset.notes as string | undefined;

        return {
            source_type: "datagov",
            id: datasetId,
            title: (dataset.title as string) || "Untitled Dataset",
            agency,
            date:
                (dataset.metadata_modified as string) ||
                (dataset.metadata_created as string) ||
                null,
            url,
            excerpt: notes ? notes.slice(0, 500) : null,
            pdf_url: pdfUrl,
            content_type: "dataset",
            raw: dataset,
        };
    }

    async searchDatasets(options: {
        query: string;
        organization?: string;
        groups?: string[];
        resFormat?: string;
        rows?: number;
        start?: number;
    }): Promise<{ datasets: Record<string, unknown>[]; sources: SourceItem[] }> {
        const { query, organization, groups, resFormat, rows = 10, start = 0 } = options;

        const fqParts: string[] = [];
        if (organization) {
            fqParts.push(`organization:"${organization}"`);
        }
        if (groups && groups.length > 0) {
            for (const group of groups) {
                fqParts.push(`groups:"${group}"`);
            }
        }
        if (resFormat) {
            fqParts.push(`res_format:"${resFormat}"`);
        }

        const params: Record<string, string | number> = {
            q: query,
            rows,
            start,
        };

        if (fqParts.length > 0) {
            params.fq = fqParts.join(" AND ");
        }

        const url = `${this.baseUrl}/package_search`;
        console.log(`Searching data.gov: ${query}`);

        const data = await this.requestWithRetry<{
            result: { results: Record<string, unknown>[] };
        }>({
            url,
            headers: this.getHeaders(),
            params,
        });

        const datasets = data.result?.results || [];
        const sources = datasets.map((ds) => this.normalizeDataset(ds));

        return { datasets, sources };
    }
}
