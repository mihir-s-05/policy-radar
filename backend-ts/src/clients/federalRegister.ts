import { BaseAPIClient } from "./base.js";
import { getSettings } from "../config.js";
import type { SourceItem } from "../models/schemas.js";

export class FederalRegisterClient extends BaseAPIClient {
    constructor() {
        const settings = getSettings();
        super(settings.federalRegisterBaseUrl);
    }

    private normalizeDocument(doc: Record<string, unknown>): SourceItem {
        const agencies = (doc.agencies || []) as { name?: string }[];
        const agencyNames = agencies
            .map((a) => a.name)
            .filter(Boolean)
            .join(", ");

        return {
            source_type: "federal_register",
            id: (doc.document_number as string) || "",
            title: (doc.title as string) || "Untitled Document",
            agency: agencyNames || null,
            date: doc.publication_date as string || null,
            url: doc.html_url as string || "",
            excerpt: doc.abstract as string || null,
            pdf_url: doc.pdf_url as string || null,
            content_type: doc.type as string || null,
            raw: doc,
        };
    }

    async searchDocuments(options: {
        query: string;
        documentType?: string;
        agency?: string;
        days?: number;
        perPage?: number;
        page?: number;
    }): Promise<{ documents: Record<string, unknown>[]; sources: SourceItem[] }> {
        const {
            query,
            documentType,
            agency,
            days,
            perPage = 10,
            page = 1,
        } = options;

        const params: Record<string, string | number> = {
            "conditions[term]": query,
            per_page: Math.min(perPage, 1000),
            page,
            order: "newest",
        };

        if (documentType) {
            params["conditions[type][]"] = documentType;
        }

        if (agency) {
            params["conditions[agencies][]"] = agency;
        }

        if (days) {
            const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
                .toISOString()
                .split("T")[0];
            params["conditions[publication_date][gte]"] = startDate;
        }

        const url = `${this.baseUrl}/documents.json`;

        const data = await this.requestWithRetry<{ results: Record<string, unknown>[] }>({
            url,
            params,
        });

        const documents = data.results || [];
        const sources = documents.map((doc) => this.normalizeDocument(doc));

        return { documents, sources };
    }

    async getDocument(
        documentNumber: string
    ): Promise<{ document: Record<string, unknown> | null; source: SourceItem | null }> {
        const url = `${this.baseUrl}/documents/${documentNumber}.json`;

        const data = await this.requestWithRetry<Record<string, unknown>>({
            url,
        });

        if (data) {
            return { document: data, source: this.normalizeDocument(data) };
        }
        return { document: null, source: null };
    }
}
