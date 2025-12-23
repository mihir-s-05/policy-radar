import { BaseAPIClient } from "./base.js";
import { getSettings } from "../config.js";
import type { SourceItem } from "../models/schemas.js";

export class RegulationsClient extends BaseAPIClient {
    private apiKey: string;

    constructor() {
        const settings = getSettings();
        super(settings.regulationsBaseUrl);
        this.apiKey = settings.govApiKey;
    }

    private getHeaders(): Record<string, string> {
        return {
            "X-Api-Key": this.apiKey,
            "Accept": "application/json",
        };
    }

    private normalizeDocument(doc: Record<string, unknown>): SourceItem {
        const attrs = (doc.attributes || {}) as Record<string, unknown>;
        const docId = doc.id as string || "";

        const url = `https://www.regulations.gov/document/${docId}`;

        return {
            source_type: "regulations_document",
            id: docId,
            title: (attrs.title as string) || "Untitled Document",
            agency: attrs.agencyId as string || null,
            date: attrs.postedDate as string || null,
            url,
            excerpt: (attrs.summary as string) || (attrs.abstract as string) || null,
        };
    }

    private normalizeDocket(docket: Record<string, unknown>): SourceItem {
        const attrs = (docket.attributes || {}) as Record<string, unknown>;
        const docketId = docket.id as string || "";

        const url = `https://www.regulations.gov/docket/${docketId}`;

        return {
            source_type: "regulations_docket",
            id: docketId,
            title: (attrs.title as string) || "Untitled Docket",
            agency: attrs.agencyId as string || null,
            date: (attrs.lastModifiedDate as string) || (attrs.modifyDate as string) || null,
            url,
            excerpt: (attrs.abstract as string) || (attrs.summary as string) || null,
        };
    }

    async searchDocuments(options: {
        searchTerm: string;
        dateGe?: string;
        dateLe?: string;
        sort?: string;
        pageSize?: number;
        pageNumber?: number;
    }): Promise<{ documents: Record<string, unknown>[]; sources: SourceItem[] }> {
        const {
            searchTerm,
            dateGe,
            dateLe,
            sort = "-postedDate",
            pageSize = 10,
            pageNumber = 1,
        } = options;

        const params: Record<string, string | number> = {
            "filter[searchTerm]": searchTerm,
            "sort": sort,
            "page[size]": pageSize,
            "page[number]": pageNumber,
        };

        if (dateGe) {
            params["filter[postedDate][ge]"] = dateGe;
        }
        if (dateLe) {
            params["filter[postedDate][le]"] = dateLe;
        }

        const url = `${this.baseUrl}/documents`;
        console.log(`Searching Regulations.gov documents: ${searchTerm}`);

        const data = await this.requestWithRetry<{ data: Record<string, unknown>[] }>({
            url,
            headers: this.getHeaders(),
            params,
        });

        const documents = data.data || [];
        const sources = documents.map((doc) => this.normalizeDocument(doc));

        return { documents, sources };
    }

    async getDocument(options: {
        documentId: string;
        includeAttachments?: boolean;
    }): Promise<{ document: Record<string, unknown>; source: SourceItem }> {
        const { documentId, includeAttachments = false } = options;

        const params: Record<string, string> = {};
        if (includeAttachments) {
            params.include = "attachments";
        }

        const url = `${this.baseUrl}/documents/${documentId}`;
        console.log(`Fetching Regulations.gov document: ${documentId}`);

        const data = await this.requestWithRetry<{ data: Record<string, unknown> }>({
            url,
            headers: this.getHeaders(),
            params: Object.keys(params).length > 0 ? params : undefined,
        });

        const doc = data.data || {};
        const source = this.normalizeDocument(doc);

        return { document: doc, source };
    }

    async searchDockets(options: {
        searchTerm: string;
        sort?: string;
        pageSize?: number;
        pageNumber?: number;
    }): Promise<{ dockets: Record<string, unknown>[]; sources: SourceItem[] }> {
        const {
            searchTerm,
            sort = "-lastModifiedDate",
            pageSize = 10,
            pageNumber = 1,
        } = options;

        const params: Record<string, string | number> = {
            "filter[searchTerm]": searchTerm,
            "sort": sort,
            "page[size]": pageSize,
            "page[number]": pageNumber,
        };

        const url = `${this.baseUrl}/dockets`;
        console.log(`Searching Regulations.gov dockets: ${searchTerm}`);

        const data = await this.requestWithRetry<{ data: Record<string, unknown>[] }>({
            url,
            headers: this.getHeaders(),
            params,
        });

        const dockets = data.data || [];
        const sources = dockets.map((docket) => this.normalizeDocket(docket));

        return { dockets, sources };
    }

    async getDocket(docketId: string): Promise<{ docket: Record<string, unknown>; source: SourceItem }> {
        const url = `${this.baseUrl}/dockets/${docketId}`;
        console.log(`Fetching Regulations.gov docket: ${docketId}`);

        const data = await this.requestWithRetry<{ data: Record<string, unknown> }>({
            url,
            headers: this.getHeaders(),
        });

        const docket = data.data || {};
        const source = this.normalizeDocket(docket);

        return { docket, source };
    }
}

export function getDateRange(days: number): { startDate: string; endDate: string } {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    return {
        startDate: startDate.toISOString().split("T")[0],
        endDate: endDate.toISOString().split("T")[0],
    };
}
