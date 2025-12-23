import type { SourceItem } from "../models/schemas.js";
import {
    RegulationsClient,
    GovInfoClient,
    buildGovInfoQuery,
    WebFetcher,
    CongressClient,
    FederalRegisterClient,
    USASpendingClient,
    FiscalDataClient,
    DataGovClient,
    DOJClient,
    SearchGovClient,
} from "../clients/index.js";
import { getPdfMemoryStore } from "./pdfMemory.js";

export class ToolExecutor {
    private regulationsClient: RegulationsClient;
    private govInfoClient: GovInfoClient;
    private webFetcher: WebFetcher;
    private congressClient: CongressClient;
    private federalRegisterClient: FederalRegisterClient;
    private usaSpendingClient: USASpendingClient;
    private fiscalDataClient: FiscalDataClient;
    private dataGovClient: DataGovClient;
    private dojClient: DOJClient;
    private searchGovClient: SearchGovClient;
    private sessionId: string;
    private allSources: SourceItem[] = [];

    constructor(sessionId: string) {
        this.sessionId = sessionId;
        this.regulationsClient = new RegulationsClient();
        this.govInfoClient = new GovInfoClient();
        this.webFetcher = new WebFetcher();
        this.congressClient = new CongressClient();
        this.federalRegisterClient = new FederalRegisterClient();
        this.usaSpendingClient = new USASpendingClient();
        this.fiscalDataClient = new FiscalDataClient();
        this.dataGovClient = new DataGovClient();
        this.dojClient = new DOJClient();
        this.searchGovClient = new SearchGovClient();
    }

    getSources(): SourceItem[] {
        // Deduplicate by id
        const seen = new Set<string>();
        return this.allSources.filter((s) => {
            if (seen.has(s.id)) return false;
            seen.add(s.id);
            return true;
        });
    }

    async execute(
        toolName: string,
        args: Record<string, unknown>
    ): Promise<{ result: Record<string, unknown>; preview: Record<string, unknown> }> {
        const handlers: Record<
            string,
            (args: Record<string, unknown>) => Promise<{ result: Record<string, unknown>; preview: Record<string, unknown> }>
        > = {
            regs_search_documents: (a) => this.execRegsSearchDocuments(a),
            regs_search_dockets: (a) => this.execRegsSearchDockets(a),
            regs_get_document: (a) => this.execRegsGetDocument(a),
            regs_read_document_content: (a) => this.execRegsReadDocumentContent(a),
            govinfo_search: (a) => this.execGovInfoSearch(a),
            govinfo_package_summary: (a) => this.execGovInfoPackageSummary(a),
            govinfo_read_package_content: (a) => this.execGovInfoReadPackageContent(a),
            fetch_url_content: (a) => this.execFetchUrlContent(a),
            search_pdf_memory: (a) => this.execSearchPdfMemory(a),
            congress_search_bills: (a) => this.execCongressSearchBills(a),
            congress_search_votes: (a) => this.execCongressSearchVotes(a),
            federal_register_search: (a) => this.execFederalRegisterSearch(a),
            usaspending_search: (a) => this.execUsaSpendingSearch(a),
            fiscal_data_query: (a) => this.execFiscalDataQuery(a),
            datagov_search: (a) => this.execDataGovSearch(a),
            doj_search: (a) => this.execDojSearch(a),
            searchgov_search: (a) => this.execSearchGovSearch(a),
        };

        const handler = handlers[toolName];
        if (!handler) {
            return {
                result: { error: `Unknown tool: ${toolName}` },
                preview: { error: "Unknown tool" },
            };
        }

        try {
            return await handler(args);
        } catch (error) {
            console.error(`Tool ${toolName} error:`, error);
            return {
                result: { error: String(error) },
                preview: { error: String(error) },
            };
        }
    }

    private async execRegsSearchDocuments(
        args: Record<string, unknown>
    ): Promise<{ result: Record<string, unknown>; preview: Record<string, unknown> }> {
        const { documents, sources } = await this.regulationsClient.searchDocuments({
            searchTerm: args.search_term as string,
            dateGe: args.date_ge as string | undefined,
            dateLe: args.date_le as string | undefined,
            pageSize: (args.page_size as number) || 10,
        });

        this.allSources.push(...sources);

        const result = {
            count: documents.length,
            documents: sources.map((s) => ({
                id: s.id,
                title: s.title,
                agency: s.agency,
                date: s.date,
                url: s.url,
                excerpt: s.excerpt ? s.excerpt.slice(0, 200) + "..." : null,
            })),
        };

        const preview = {
            count: documents.length,
            top_titles: sources.slice(0, 3).map((s) => s.title.slice(0, 80)),
        };

        return { result, preview };
    }

    private async execRegsSearchDockets(
        args: Record<string, unknown>
    ): Promise<{ result: Record<string, unknown>; preview: Record<string, unknown> }> {
        const { dockets, sources } = await this.regulationsClient.searchDockets({
            searchTerm: args.search_term as string,
            pageSize: (args.page_size as number) || 10,
        });

        this.allSources.push(...sources);

        const result = {
            count: dockets.length,
            dockets: sources.map((s) => ({
                id: s.id,
                title: s.title,
                agency: s.agency,
                date: s.date,
                url: s.url,
            })),
        };

        const preview = {
            count: dockets.length,
            top_titles: sources.slice(0, 3).map((s) => s.title.slice(0, 80)),
        };

        return { result, preview };
    }

    private async execRegsGetDocument(
        args: Record<string, unknown>
    ): Promise<{ result: Record<string, unknown>; preview: Record<string, unknown> }> {
        const { document, source } = await this.regulationsClient.getDocument({
            documentId: args.document_id as string,
            includeAttachments: args.include_attachments as boolean | undefined,
        });

        if (source) {
            this.allSources.push(source);
        }

        const attrs = (document.attributes || {}) as Record<string, unknown>;
        const result = {
            id: source?.id,
            title: source?.title,
            agency: source?.agency,
            date: source?.date,
            url: source?.url,
            document_type: attrs.documentType,
            summary: attrs.summary,
            abstract: attrs.abstract,
        };

        const preview = { title: source?.title?.slice(0, 80), id: source?.id };

        return { result, preview };
    }

    private async execRegsReadDocumentContent(
        args: Record<string, unknown>
    ): Promise<{ result: Record<string, unknown>; preview: Record<string, unknown> }> {
        const documentId = args.document_id as string;
        const content = await this.webFetcher.fetchRegulationsDocumentContent(documentId);

        // Index PDF content for RAG
        if (content.text && content.content_format === "pdf") {
            const pdfMemory = getPdfMemoryStore();
            await pdfMemory.addDocument(this.sessionId, `regs:${documentId}`, content.text, {
                source_type: "regulations_document",
                source_url: content.url,
            });
        }

        const result = {
            document_id: documentId,
            title: content.title,
            content: content.text,
            content_format: content.content_format,
            url: content.url,
            error: content.error,
        };

        const preview = {
            title: content.title?.slice(0, 80),
            content_length: content.text?.length || 0,
            format: content.content_format,
        };

        return { result, preview };
    }

    private async execGovInfoSearch(
        args: Record<string, unknown>
    ): Promise<{ result: Record<string, unknown>; preview: Record<string, unknown> }> {
        const query = buildGovInfoQuery({
            keywords: (args.query as string) || (args.keywords as string) || "",
            collection: args.collection as string | undefined,
            days: args.days as number | undefined,
        });

        const { data, sources } = await this.govInfoClient.search({
            query,
            pageSize: (args.page_size as number) || 10,
        });

        this.allSources.push(...sources);

        const result = {
            count: sources.length,
            next_offset: data.nextOffsetMark as string | undefined,
            results: sources.map((s) => ({
                id: s.id,
                title: s.title,
                agency: s.agency,
                date: s.date,
                url: s.url,
                excerpt: s.excerpt ? s.excerpt.slice(0, 200) + "..." : null,
            })),
        };

        const preview = {
            count: sources.length,
            top_titles: sources.slice(0, 3).map((s) => s.title.slice(0, 80)),
        };

        return { result, preview };
    }

    private async execGovInfoPackageSummary(
        args: Record<string, unknown>
    ): Promise<{ result: Record<string, unknown>; preview: Record<string, unknown> }> {
        const { data, source } = await this.govInfoClient.getPackageSummary(args.package_id as string);

        if (source) {
            this.allSources.push(source);
        }

        const result = {
            id: source?.id,
            title: source?.title,
            agency: source?.agency,
            date: source?.date,
            url: source?.url,
            abstract: data.abstract || data.description,
        };

        const preview = { title: source?.title?.slice(0, 80), id: source?.id };

        return { result, preview };
    }

    private async execGovInfoReadPackageContent(
        args: Record<string, unknown>
    ): Promise<{ result: Record<string, unknown>; preview: Record<string, unknown> }> {
        const packageId = args.package_id as string;
        const { text, source, contentFormat, pdfUrl } = await this.govInfoClient.getPackageContent({
            packageId,
            maxLength: 15000,
        });

        if (source) {
            this.allSources.push(source);
        }

        // Index for RAG if PDF
        if (text && contentFormat === "pdf") {
            const pdfMemory = getPdfMemoryStore();
            await pdfMemory.addDocument(this.sessionId, `govinfo:${packageId}`, text, {
                source_type: "govinfo_package",
                source_url: source?.url || "",
            });
        }

        const result = {
            package_id: packageId,
            title: source?.title,
            content: text,
            content_format: contentFormat,
            url: source?.url,
            pdf_url: pdfUrl,
        };

        const preview = {
            title: source?.title?.slice(0, 80),
            content_length: text?.length || 0,
            format: contentFormat,
        };

        return { result, preview };
    }

    private async execFetchUrlContent(
        args: Record<string, unknown>
    ): Promise<{ result: Record<string, unknown>; preview: Record<string, unknown> }> {
        const url = args.url as string;
        const content = await this.webFetcher.fetchUrl(url, 15000);

        // Index for RAG if PDF
        if (content.text && content.content_format === "pdf") {
            const pdfMemory = getPdfMemoryStore();
            await pdfMemory.addDocument(this.sessionId, `url:${url}`, content.text, {
                source_type: "web_content",
                source_url: url,
            });
        }

        const result = {
            url: content.url,
            title: content.title,
            content: content.text,
            content_format: content.content_format,
            error: content.error,
        };

        const preview = {
            title: content.title?.slice(0, 80),
            content_length: content.text?.length || 0,
            format: content.content_format,
            error: content.error,
        };

        return { result, preview };
    }

    private async execSearchPdfMemory(
        args: Record<string, unknown>
    ): Promise<{ result: Record<string, unknown>; preview: Record<string, unknown> }> {
        const query = args.query as string;
        const topK = (args.top_k as number) || 5;

        const pdfMemory = getPdfMemoryStore();
        const matches = await pdfMemory.query(this.sessionId, query, topK);

        const result = {
            count: matches.length,
            matches: matches.map((m) => ({
                text: m.text,
                score: m.score,
                doc_key: m.metadata.doc_key,
            })),
        };

        const preview = {
            count: matches.length,
            top_scores: matches.slice(0, 3).map((m) => m.score?.toFixed(3)),
        };

        return { result, preview };
    }

    private async execCongressSearchBills(
        args: Record<string, unknown>
    ): Promise<{ result: Record<string, unknown>; preview: Record<string, unknown> }> {
        const { bills, sources } = await this.congressClient.searchBills({
            query: args.query as string,
            congress: args.congress as number | undefined,
            limit: (args.limit as number) || 10,
        });

        this.allSources.push(...sources);

        const result = {
            count: bills.length,
            bills: sources.map((s) => ({
                id: s.id,
                title: s.title,
                date: s.date,
                url: s.url,
                excerpt: s.excerpt,
            })),
        };

        const preview = {
            count: bills.length,
            top_titles: sources.slice(0, 3).map((s) => s.title.slice(0, 80)),
        };

        return { result, preview };
    }

    private async execCongressSearchVotes(
        args: Record<string, unknown>
    ): Promise<{ result: Record<string, unknown>; preview: Record<string, unknown> }> {
        const { votes, sources } = await this.congressClient.searchVotes({
            chamber: (args.chamber as string) || "house",
            congress: args.congress as number | undefined,
            limit: (args.limit as number) || 10,
        });

        this.allSources.push(...sources);

        const result = {
            count: votes.length,
            votes: sources.map((s) => ({
                id: s.id,
                title: s.title,
                agency: s.agency,
                date: s.date,
                url: s.url,
            })),
        };

        const preview = {
            count: votes.length,
            chamber: args.chamber || "house",
        };

        return { result, preview };
    }

    private async execFederalRegisterSearch(
        args: Record<string, unknown>
    ): Promise<{ result: Record<string, unknown>; preview: Record<string, unknown> }> {
        const { documents, sources } = await this.federalRegisterClient.searchDocuments({
            query: args.query as string,
            documentType: args.document_type as string | undefined,
            agency: args.agency as string | undefined,
            days: args.days as number | undefined,
            perPage: (args.per_page as number) || 10,
        });

        this.allSources.push(...sources);

        const result = {
            count: documents.length,
            documents: sources.map((s) => ({
                id: s.id,
                title: s.title,
                agency: s.agency,
                date: s.date,
                url: s.url,
                excerpt: s.excerpt ? s.excerpt.slice(0, 200) + "..." : null,
                pdf_url: s.pdf_url,
            })),
        };

        const preview = {
            count: documents.length,
            top_titles: sources.slice(0, 3).map((s) => s.title.slice(0, 80)),
        };

        return { result, preview };
    }

    private async execUsaSpendingSearch(
        args: Record<string, unknown>
    ): Promise<{ result: Record<string, unknown>; preview: Record<string, unknown> }> {
        let keywords = args.keywords;
        if (typeof keywords === "string") {
            keywords = [keywords];
        }

        const { results, sources, brief } = await this.usaSpendingClient.searchSpending({
            keywords: keywords as string[] | undefined,
            agency: args.agency as string | undefined,
            recipient: args.recipient as string | undefined,
            awardType: (args.award_type as string) || "contracts",
            days: (args.days as number) || 365,
            limit: (args.limit as number) || 10,
        });

        this.allSources.push(...sources);

        const result = {
            count: results.length,
            brief,
            results: sources.map((s) => ({
                id: s.id,
                title: s.title,
                agency: s.agency,
                date: s.date,
                url: s.url,
                excerpt: s.excerpt,
            })),
        };

        const preview = {
            count: results.length,
            top_titles: sources.slice(0, 3).map((s) => s.title.slice(0, 80)),
        };

        return { result, preview };
    }

    private async execFiscalDataQuery(
        args: Record<string, unknown>
    ): Promise<{ result: Record<string, unknown>; preview: Record<string, unknown> }> {
        const { records, sources, brief } = await this.fiscalDataClient.queryDataset({
            dataset: (args.dataset as string) || "debt_to_penny",
            pageSize: (args.page_size as number) || 10,
        });

        this.allSources.push(...sources);

        const result = {
            count: records.length,
            brief,
            records: sources.map((s) => ({
                id: s.id,
                title: s.title,
                date: s.date,
                url: s.url,
            })),
        };

        const preview = {
            count: records.length,
            dataset: args.dataset || "debt_to_penny",
        };

        return { result, preview };
    }

    private async execDataGovSearch(
        args: Record<string, unknown>
    ): Promise<{ result: Record<string, unknown>; preview: Record<string, unknown> }> {
        const { datasets, sources } = await this.dataGovClient.searchDatasets({
            query: args.query as string,
            organization: args.organization as string | undefined,
            rows: (args.rows as number) || 10,
        });

        this.allSources.push(...sources);

        const result = {
            count: datasets.length,
            datasets: sources.map((s) => ({
                id: s.id,
                title: s.title,
                agency: s.agency,
                date: s.date,
                url: s.url,
                excerpt: s.excerpt ? s.excerpt.slice(0, 200) + "..." : null,
            })),
        };

        const preview = {
            count: datasets.length,
            top_titles: sources.slice(0, 3).map((s) => s.title.slice(0, 80)),
        };

        return { result, preview };
    }

    private async execDojSearch(
        args: Record<string, unknown>
    ): Promise<{ result: Record<string, unknown>; preview: Record<string, unknown> }> {
        const { releases, sources } = await this.dojClient.searchPressReleases({
            query: args.query as string | undefined,
            component: args.component as string | undefined,
            days: (args.days as number) || 30,
            limit: (args.limit as number) || 10,
        });

        this.allSources.push(...sources);

        const result = {
            count: releases.length,
            press_releases: sources.map((s) => ({
                id: s.id,
                title: s.title,
                date: s.date,
                url: s.url,
                excerpt: s.excerpt ? s.excerpt.slice(0, 200) + "..." : null,
            })),
        };

        const preview = {
            count: releases.length,
            top_titles: sources.slice(0, 3).map((s) => s.title.slice(0, 80)),
        };

        return { result, preview };
    }

    private async execSearchGovSearch(
        args: Record<string, unknown>
    ): Promise<{ result: Record<string, unknown>; preview: Record<string, unknown> }> {
        if (!this.searchGovClient.isConfigured) {
            return {
                result: {
                    error:
                        "Search.gov is not configured. Set SEARCHGOV_AFFILIATE and SEARCHGOV_ACCESS_KEY environment variables.",
                },
                preview: { error: "Not configured" },
            };
        }

        const { results, sources } = await this.searchGovClient.search({
            query: (args.query as string) || "",
            limit: (args.limit as number) || 10,
        });

        this.allSources.push(...sources);

        const result = {
            count: results.length,
            results: sources.map((s) => ({
                title: s.title,
                url: s.url,
                excerpt: s.excerpt,
            })),
        };

        const preview = {
            count: results.length,
            top_titles: sources.slice(0, 3).map((s) => s.title.slice(0, 80)),
        };

        return { result, preview };
    }
}

export function getToolLabel(toolName: string, args: Record<string, unknown>): string {
    const labels: Record<string, string> = {
        regs_search_documents: `Search Regulations.gov documents: ${args.search_term || ""}`,
        regs_search_dockets: `Search Regulations.gov dockets: ${args.search_term || ""}`,
        regs_get_document: `Get document: ${args.document_id || ""}`,
        regs_read_document_content: `Read document content: ${args.document_id || ""}`,
        govinfo_search: `Search GovInfo: ${args.query || args.keywords || ""}`,
        govinfo_package_summary: `Get package: ${args.package_id || ""}`,
        govinfo_read_package_content: `Read package content: ${args.package_id || ""}`,
        fetch_url_content: `Fetch URL: ${((args.url as string) || "").slice(0, 50)}`,
        search_pdf_memory: `Search PDF memory: ${((args.query as string) || "").slice(0, 50)}`,
        congress_search_bills: `Search Congress bills: ${args.query || ""}`,
        congress_search_votes: `Search Congress votes: ${args.chamber || "house"}`,
        federal_register_search: `Search Federal Register: ${args.query || ""}`,
        usaspending_search: `Search USAspending: ${args.keywords || ""}`,
        fiscal_data_query: `Query Fiscal Data: ${args.dataset || "debt_to_penny"}`,
        datagov_search: `Search data.gov: ${args.query || ""}`,
        doj_search: `Search DOJ: ${args.query || ""}`,
        searchgov_search: `Search Search.gov: ${args.query || ""}`,
    };

    return labels[toolName] || `Execute: ${toolName}`;
}
