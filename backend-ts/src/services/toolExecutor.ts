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
    getDateRange,
} from "../clients/index.js";
import { getSettings } from "../config.js";
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
    private sessionId: string | null;
    private embeddingConfig: { provider?: "local" | "openai" | "gemini" | "huggingface" | "custom" | null; model?: string | null; apiKey?: string | null; baseUrl?: string | null } | null = null;
    private allSources: SourceItem[] = [];
    private maxToolTextLength = 20000;

    constructor(sessionId?: string | null) {
        this.sessionId = sessionId || null;
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

    setSession(sessionId?: string | null): void {
        this.sessionId = sessionId || null;
    }

    setEmbeddingConfig(config?: { provider?: "local" | "openai" | "gemini" | "huggingface" | "custom" | null; model?: string | null; apiKey?: string | null; baseUrl?: string | null } | null): void {
        this.embeddingConfig = config || null;
    }

    getCollectedSources(): SourceItem[] {
        return this.allSources;
    }

    clearSources(): void {
        this.allSources = [];
    }

    private extractRegulationsDocumentId(url: string): string | null {
        if (!url) return null;
        const match = url.match(/regulations\.gov\/document\/([^/?#]+)/i);
        return match ? match[1] : null;
    }

    private shouldIndexPdf(data: Record<string, unknown>): boolean {
        if (!data) return false;
        if (data.content_format === "pdf") return true;
        if (typeof data.content_type === "string" && data.content_type.toLowerCase().startsWith("application/pdf")) {
            return true;
        }
        if (data.pdf_url) return true;
        if (data.images) return true;
        return false;
    }

    private async indexPdfText(options: {
        docKey: string;
        text: string;
        sourceUrl?: string | null;
        sourceType: string;
        pdfUrl?: string | null;
        contentFormat?: string | null;
    }): Promise<{
        status: "indexed" | "skipped" | "failed";
        doc_key: string;
        source_type: string;
        pdf_url?: string | null;
        source_url?: string | null;
        error?: string;
        reason?: string;
    }> {
        if (!this.sessionId || !options.text) {
            return {
                status: "skipped",
                doc_key: options.docKey,
                source_type: options.sourceType,
                pdf_url: options.pdfUrl || null,
                source_url: options.sourceUrl || null,
                reason: "missing_session_or_text",
            };
        }

        let textToIndex = options.text;
        if (options.pdfUrl) {
            console.log(`Fetching PDF text for RAG indexing: ${options.pdfUrl}`);
            const pdfData = await this.webFetcher.fetchUrl(options.pdfUrl, null);
            if (pdfData.text) {
                textToIndex = pdfData.text;
            }
        }

        const metadata: Record<string, string> = {
            source_url: options.sourceUrl || "",
            source_type: options.sourceType,
        };
        if (options.pdfUrl) {
            metadata.pdf_url = options.pdfUrl;
        }

        try {
            console.log(`[PDF Index] Starting PDF indexing for docKey: ${options.docKey}, sourceType: ${options.sourceType}, textLength: ${textToIndex.length}`);
            const pdfMemory = getPdfMemoryStore();
            const result = await pdfMemory.addDocument(
                this.sessionId,
                options.docKey,
                textToIndex,
                metadata,
                this.embeddingConfig
            );
            
            console.log(`[PDF Index] Indexing result for ${options.docKey}: status=${result.status}, error=${result.error || 'none'}, reason=${result.reason || 'none'}`);
            
            if (result.status !== "indexed") {
                if (result.error) {
                    console.error(
                        `[PDF Index] Failed to index PDF text for ${options.docKey} (${options.sourceType}): ${result.error}`
                    );
                }
            } else {
                console.log(`[PDF Index] Successfully indexed PDF text for ${options.docKey}`);
            }
            
            return {
                status: result.status,
                doc_key: options.docKey,
                source_type: options.sourceType,
                pdf_url: options.pdfUrl || null,
                source_url: options.sourceUrl || null,
                error: result.error,
                reason: result.reason,
            };
        } catch (error) {
            const errorDetails = {
                message: String(error),
                errorType: error instanceof Error ? error.constructor.name : typeof error,
                stack: error instanceof Error ? error.stack : undefined,
                docKey: options.docKey,
                sourceType: options.sourceType,
                textLength: textToIndex.length,
            };
            console.error(
                `[PDF Index] Exception while indexing PDF text for ${options.docKey} (${options.sourceType}):`,
                JSON.stringify(errorDetails, null, 2)
            );
            return {
                status: "failed",
                doc_key: options.docKey,
                source_type: options.sourceType,
                pdf_url: options.pdfUrl || null,
                source_url: options.sourceUrl || null,
                error: String(error),
            };
        }
    }

    async executeTool(
        toolName: string,
        args: Record<string, unknown>
    ): Promise<{ result: Record<string, unknown>; preview: Record<string, unknown> }> {
        console.log(`Executing tool: ${toolName} with args: ${JSON.stringify(args)}`);

        try {
            switch (toolName) {
                case "regs_search_documents":
                    return await this.execRegsSearchDocuments(args);
                case "regs_search_dockets":
                    return await this.execRegsSearchDockets(args);
                case "regs_get_document":
                    return await this.execRegsGetDocument(args);
                case "regs_read_document_content":
                    return await this.execRegsReadDocumentContent(args);
                case "govinfo_search":
                    return await this.execGovInfoSearch(args);
                case "govinfo_package_summary":
                    return await this.execGovInfoPackageSummary(args);
                case "govinfo_read_package_content":
                    return await this.execGovInfoReadPackageContent(args);
                case "fetch_url_content":
                    return await this.execFetchUrlContent(args);
                case "search_pdf_memory":
                    return await this.execSearchPdfMemory(args);
                case "congress_search_bills":
                    return await this.execCongressSearchBills(args);
                case "congress_search_votes":
                    return await this.execCongressSearchVotes(args);
                case "federal_register_search":
                    return await this.execFederalRegisterSearch(args);
                case "usaspending_search":
                    return await this.execUsaSpendingSearch(args);
                case "fiscal_data_query":
                    return await this.execFiscalDataQuery(args);
                case "datagov_search":
                    return await this.execDataGovSearch(args);
                case "doj_search":
                    return await this.execDojSearch(args);
                case "searchgov_search":
                    return await this.execSearchGovSearch(args);
                default:
                    return {
                        result: { error: `Unknown tool: ${toolName}` },
                        preview: { error: `Unknown tool: ${toolName}` },
                    };
            }
        } catch (error) {
            console.error(`Error executing tool ${toolName}:`, error);
            return {
                result: { error: String(error) },
                preview: { error: String(error) },
            };
        }
    }

    private async execRegsSearchDocuments(
        args: Record<string, unknown>
    ): Promise<{ result: Record<string, unknown>; preview: Record<string, unknown> }> {
        const searchTerm = (args.search_term as string) || "";
        const days = typeof args.days === "number" ? args.days : 30;
        const pageSize = typeof args.page_size === "number" ? args.page_size : 10;

        const { startDate, endDate } = getDateRange(days);

        const { documents, sources } = await this.regulationsClient.searchDocuments({
            searchTerm,
            dateGe: startDate,
            dateLe: endDate,
            pageSize,
        });

        this.allSources.push(...sources);

        const result = {
            count: documents.length,
            date_range: { from: startDate, to: endDate },
            documents: documents.map((doc) => {
                const attrs = (doc.attributes || {}) as Record<string, unknown>;
                const docId = String(doc.id || "");
                return {
                    id: docId,
                    title: attrs.title,
                    agency: attrs.agencyId,
                    posted_date: attrs.postedDate,
                    document_type: attrs.documentType,
                    url: `https://www.regulations.gov/document/${docId}`,
                };
            }),
        };

        const preview = {
            count: documents.length,
            top_titles: documents.slice(0, 3).map((doc) => {
                const attrs = (doc.attributes || {}) as Record<string, unknown>;
                return String(attrs.title || "").slice(0, 80);
            }),
        };

        return { result, preview };
    }

    private async execRegsSearchDockets(
        args: Record<string, unknown>
    ): Promise<{ result: Record<string, unknown>; preview: Record<string, unknown> }> {
        const searchTerm = (args.search_term as string) || "";
        const pageSize = typeof args.page_size === "number" ? args.page_size : 10;

        const { dockets, sources } = await this.regulationsClient.searchDockets({
            searchTerm,
            pageSize,
        });

        this.allSources.push(...sources);

        const result = {
            count: dockets.length,
            dockets: dockets.map((docket) => {
                const attrs = (docket.attributes || {}) as Record<string, unknown>;
                const docketId = String(docket.id || "");
                return {
                    id: docketId,
                    title: attrs.title,
                    agency: attrs.agencyId,
                    last_modified: attrs.lastModifiedDate,
                    docket_type: attrs.docketType,
                    url: `https://www.regulations.gov/docket/${docketId}`,
                };
            }),
        };

        const preview = {
            count: dockets.length,
            top_titles: dockets.slice(0, 3).map((docket) => {
                const attrs = (docket.attributes || {}) as Record<string, unknown>;
                return String(attrs.title || "").slice(0, 80);
            }),
        };

        return { result, preview };
    }

    private async execRegsGetDocument(
        args: Record<string, unknown>
    ): Promise<{ result: Record<string, unknown>; preview: Record<string, unknown> }> {
        const documentId = (args.document_id as string) || "";
        const includeAttachments = Boolean(args.include_attachments);

        const { document } = await this.regulationsClient.getDocument({
            documentId,
            includeAttachments,
        });

        const attrs = (document.attributes || {}) as Record<string, unknown>;

        const result: Record<string, unknown> = {
            id: String(document.id || ""),
            title: attrs.title,
            agency: attrs.agencyId,
            posted_date: attrs.postedDate,
            document_type: attrs.documentType,
            summary: attrs.summary,
            abstract: attrs.abstract,
            url: `https://www.regulations.gov/document/${documentId}`,
        };

        if (includeAttachments && Array.isArray(document.included)) {
            result.attachments = document.included.map((att: Record<string, unknown>) => {
                const attAttrs = (att.attributes || {}) as Record<string, unknown>;
                return {
                    title: attAttrs.title,
                    format: attAttrs.format,
                };
            });
        }

        const preview = {
            title: String(attrs.title || "").slice(0, 80),
            agency: attrs.agencyId,
        };

        return { result, preview };
    }

    private async execGovInfoSearch(
        args: Record<string, unknown>
    ): Promise<{ result: Record<string, unknown>; preview: Record<string, unknown> }> {
        const query = String(args.query || "").trim();
        const keywords = String(args.keywords || "").trim();
        const collection = args.collection as string | undefined;
        const days = typeof args.days === "number" ? args.days : undefined;
        const pageSize = typeof args.page_size === "number" ? args.page_size : 10;

        const baseQuery = query || keywords;
        if (!baseQuery) {
            return { result: { error: "Missing search query." }, preview: { error: "Missing search query." } };
        }

        const queryBuilt = buildGovInfoQuery({
            keywords: baseQuery,
            collection,
            days,
        });

        const { data, sources } = await this.govInfoClient.search({
            query: queryBuilt,
            pageSize,
        });

        this.allSources.push(...sources);

        const results = (data.results as Record<string, unknown>[] | undefined) || [];

        const result = {
            count: results.length,
            total_count: (data.count as number) || results.length,
            results: results.map((r) => ({
                package_id: String(r.packageId || ""),
                title: r.title,
                collection: r.collectionCode,
                date: r.lastModified || r.dateIssued,
                url: `https://www.govinfo.gov/app/details/${String(r.packageId || "")}`,
            })),
        };

        const preview = {
            count: results.length,
            top_titles: results.slice(0, 3).map((r) => String(r.title || "").slice(0, 80)),
        };

        return { result, preview };
    }

    private async execGovInfoPackageSummary(
        args: Record<string, unknown>
    ): Promise<{ result: Record<string, unknown>; preview: Record<string, unknown> }> {
        const packageId = (args.package_id as string) || "";

        const { data } = await this.govInfoClient.getPackageSummary(packageId);

        const result = {
            package_id: data.packageId,
            title: data.title,
            collection: data.collectionCode,
            publisher: data.publisher,
            date_issued: data.dateIssued,
            last_modified: data.lastModified,
            abstract: data.abstract,
            description: data.description,
            url: `https://www.govinfo.gov/app/details/${packageId}`,
        };

        const preview = {
            title: String(data.title || "").slice(0, 80),
            collection: data.collectionCode,
        };

        return { result, preview };
    }

    private async execRegsReadDocumentContent(
        args: Record<string, unknown>
    ): Promise<{ result: Record<string, unknown>; preview: Record<string, unknown> }> {
        const documentId = (args.document_id as string) || "";

        const data = await this.webFetcher.fetchRegulationsDocumentContent(documentId, 15000);

        let pdfIndex: {
            status: "indexed" | "skipped" | "failed";
            doc_key: string;
            source_type: string;
            pdf_url?: string | null;
            source_url?: string | null;
            error?: string;
            reason?: string;
        } | null = null;

        if (data.text && this.shouldIndexPdf(data)) {
            pdfIndex = await this.indexPdfText({
                docKey: documentId,
                text: data.text,
                sourceUrl: (data.pdf_url as string) || (data.url as string),
                sourceType: "regulations_document",
                pdfUrl: (data.pdf_url as string) || null,
                contentFormat: (data.content_format as string) || null,
            });
        }

        const source: SourceItem = {
            source_type: "regulations_document",
            id: documentId,
            title: (data.title as string) || `Document ${documentId}`,
            agency: null,
            date: null,
            url: `https://www.regulations.gov/document/${documentId}`,
            excerpt: data.text ? data.text.slice(0, 200) : null,
        };
        this.allSources.push(source);

        const result = {
            document_id: documentId,
            title: data.title,
            url: data.url,
            full_text: data.text,
            images: data.images,
            images_skipped: data.images_skipped,
            content_format: data.content_format,
            pdf_url: data.pdf_url,
            error: data.error,
        };

        let textPreview = "No content";
        if (data.text) {
            textPreview = `${data.text.slice(0, 150)}...`;
        } else if (Array.isArray(data.images)) {
            textPreview = `${data.images.length} images extracted`;
        }

        const preview = {
            document_id: documentId,
            text_length: data.text ? data.text.length : 0,
            image_count: Array.isArray(data.images) ? data.images.length : 0,
            preview: textPreview,
            ...(pdfIndex ? { pdf_index: pdfIndex } : {}),
        };

        return { result, preview };
    }

    private async execGovInfoReadPackageContent(
        args: Record<string, unknown>
    ): Promise<{ result: Record<string, unknown>; preview: Record<string, unknown> }> {
        const packageId = (args.package_id as string) || "";

        const { text, source, images, imagesSkipped, contentFormat, pdfUrl } =
            await this.govInfoClient.getPackageContent({ packageId, maxLength: 15000 });

        let pdfIndex: {
            status: "indexed" | "skipped" | "failed";
            doc_key: string;
            source_type: string;
            pdf_url?: string | null;
            source_url?: string | null;
            error?: string;
            reason?: string;
        } | null = null;

        if (text && (contentFormat === "pdf" || pdfUrl || (images && images.length))) {
            pdfIndex = await this.indexPdfText({
                docKey: packageId,
                text,
                sourceUrl: pdfUrl || source.url,
                sourceType: "govinfo_package",
                pdfUrl: pdfUrl || null,
                contentFormat,
            });
        }

        this.allSources.push(source);

        const result = {
            package_id: packageId,
            title: source.title,
            url: source.url,
            full_text: text,
            images,
            images_skipped: imagesSkipped,
            content_format: contentFormat,
            pdf_url: pdfUrl,
        };

        let textPreview = "No content";
        if (text) {
            textPreview = text.length > 150 ? `${text.slice(0, 150)}...` : text;
        } else if (images && images.length) {
            textPreview = `${images.length} images extracted`;
        }

        const preview = {
            package_id: packageId,
            text_length: text.length,
            image_count: images.length,
            preview: textPreview,
            ...(pdfIndex ? { pdf_index: pdfIndex } : {}),
        };

        return { result, preview };
    }

    private async execFetchUrlContent(
        args: Record<string, unknown>
    ): Promise<{ result: Record<string, unknown>; preview: Record<string, unknown> }> {
        const url = (args.url as string) || "";
        const fullText = Boolean(args.full_text);
        let maxLength = args.max_length as number | undefined;
        let maxLengthApplied: number | null = null;
        let pdfIndex: {
            status: "indexed" | "skipped" | "failed";
            doc_key: string;
            source_type: string;
            pdf_url?: string | null;
            source_url?: string | null;
            error?: string;
            reason?: string;
        } | null = null;

        if (!fullText) {
            if (!Number.isFinite(maxLength)) {
                maxLength = 15000;
            }
            if ((maxLength as number) <= 0) {
                maxLength = 15000;
            }
        } else {
            if (!Number.isFinite(maxLength)) {
                maxLength = this.maxToolTextLength;
            }
            if ((maxLength as number) <= 0) {
                maxLength = this.maxToolTextLength;
            }
            maxLength = Math.min(maxLength as number, this.maxToolTextLength);
            maxLengthApplied = maxLength as number;
        }

        const documentId = this.extractRegulationsDocumentId(url);
        let data: Record<string, any>;
        if (documentId) {
            console.log(`Using Regulations.gov API fetch for document ${documentId}`);
            data = await this.webFetcher.fetchRegulationsDocumentContent(documentId, maxLength as number);
        } else {
            data = await this.webFetcher.fetchUrl(url, maxLength as number);
        }

        if (data.text && this.shouldIndexPdf(data)) {
            pdfIndex = await this.indexPdfText({
                docKey: url,
                text: data.text,
                sourceUrl: (data.pdf_url as string) || url,
                sourceType: "url",
                pdfUrl: (data.pdf_url as string) || null,
                contentFormat: (data.content_format as string) || null,
            });
        }

        if (data.text || data.images) {
            const source: SourceItem = {
                source_type: "govinfo_result",
                id: url,
                title: (data.title as string) || url,
                agency: null,
                date: null,
                url,
                excerpt: data.text ? data.text.slice(0, 200) : null,
            };
            this.allSources.push(source);
        }

        const result = {
            url,
            title: data.title,
            full_text: data.text,
            images: data.images,
            images_skipped: data.images_skipped,
            content_format: data.content_format,
            pdf_url: data.pdf_url,
            full_text_requested: fullText,
            max_length_applied: maxLengthApplied,
            error: data.error,
        };

        let textPreview = "No content";
        if (data.text) {
            textPreview = `${data.text.slice(0, 150)}...`;
        } else if (Array.isArray(data.images)) {
            textPreview = `${data.images.length} images extracted`;
        }

        const preview = {
            url: url.slice(0, 50),
            text_length: data.text ? data.text.length : 0,
            image_count: Array.isArray(data.images) ? data.images.length : 0,
            preview: data.error ? data.error : textPreview,
            ...(pdfIndex ? { pdf_index: pdfIndex } : {}),
        };

        return { result, preview };
    }

    private async execSearchPdfMemory(
        args: Record<string, unknown>
    ): Promise<{ result: Record<string, unknown>; preview: Record<string, unknown> }> {
        const query = String(args.query || "").trim();
        let topK = args.top_k as number | undefined;
        if (topK !== undefined) {
            const parsed = Number(topK);
            if (!Number.isFinite(parsed)) {
                topK = undefined;
            } else {
                topK = parsed;
            }
        }

        if (!this.sessionId) {
            return { result: { error: "PDF memory not available without a session." }, preview: { error: "Missing session" } };
        }
        if (!query) {
            return { result: { error: "Missing query." }, preview: { error: "Missing query" } };
        }

        const pdfMemory = getPdfMemoryStore();
        const matches = await pdfMemory.query(this.sessionId, query, topK, this.embeddingConfig);
        console.log(
            `PDF memory search for session ${this.sessionId}: '${query.slice(0, 80)}' (${matches.length} matches)`
        );

        const docSummaries: Array<{ doc_key?: string; pdf_url?: string; source_type?: string }> = [];
        const seen = new Set<string>();
        for (const match of matches) {
            const meta = (match.metadata as Record<string, unknown>) || {};
            const docKey = meta.doc_key as string | undefined;
            const pdfUrl = (meta.pdf_url as string) || (meta.source_url as string) || undefined;
            const sourceType = meta.source_type as string | undefined;
            if (!docKey && !pdfUrl) {
                continue;
            }
            const dedupeKey = `${docKey || ""}|${pdfUrl || ""}|${sourceType || ""}`;
            if (seen.has(dedupeKey)) {
                continue;
            }
            seen.add(dedupeKey);
            docSummaries.push({ doc_key: docKey, pdf_url: pdfUrl, source_type: sourceType });
            if (docSummaries.length >= 5) {
                break;
            }
        }

        const result = {
            query,
            count: matches.length,
            documents: docSummaries,
            matches,
        };

        const preview = {
            query,
            count: matches.length,
            top_score: matches.length ? matches[0].score : null,
            documents: docSummaries,
        };

        return { result, preview };
    }

    private async execCongressSearchBills(
        args: Record<string, unknown>
    ): Promise<{ result: Record<string, unknown>; preview: Record<string, unknown> }> {
        const query = (args.query as string) || "";
        const congress = args.congress as number | undefined;
        const limit = typeof args.limit === "number" ? args.limit : 10;

        const { bills, sources } = await this.congressClient.searchBills({
            query,
            congress,
            limit,
        });

        this.allSources.push(...sources);

        const result = {
            count: bills.length,
            bills: sources.map((s) => ({
                id: s.id,
                title: s.title,
                date: s.date,
                url: s.url,
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
        const chamber = (args.chamber as string) || "house";
        const congress = args.congress as number | undefined;
        const limit = typeof args.limit === "number" ? args.limit : 10;

        const { votes, sources } = await this.congressClient.searchVotes({
            chamber,
            congress,
            limit,
        });

        this.allSources.push(...sources);

        const result = {
            count: votes.length,
            votes: sources.map((s) => ({
                id: s.id,
                title: s.title,
                date: s.date,
                url: s.url,
            })),
        };

        const preview = {
            count: votes.length,
            top_titles: sources.slice(0, 3).map((s) => s.title.slice(0, 80)),
        };

        return { result, preview };
    }

    private async execFederalRegisterSearch(
        args: Record<string, unknown>
    ): Promise<{ result: Record<string, unknown>; preview: Record<string, unknown> }> {
        const query = (args.query as string) || "";
        const documentType = args.document_type as string | undefined;
        const days = typeof args.days === "number" ? args.days : 30;
        const limit = typeof args.limit === "number" ? args.limit : 10;

        const { documents, sources } = await this.federalRegisterClient.searchDocuments({
            query,
            documentType,
            days,
            perPage: limit,
        });

        this.allSources.push(...sources);

        const result = {
            count: documents.length,
            documents: sources.map((s) => ({
                id: s.id,
                title: s.title,
                date: s.date,
                url: s.url,
                pdf_url: s.pdf_url,
                type: s.content_type,
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
        const keywords = args.keywords as string[] | undefined;
        const agency = args.agency as string | undefined;
        const awardType = args.award_type as string | undefined;
        const days = typeof args.days === "number" ? args.days : 365;
        const limit = typeof args.limit === "number" ? args.limit : 10;

        const { results, sources, brief } = await this.usaSpendingClient.searchSpending({
            keywords: keywords && keywords.length ? keywords : undefined,
            agency,
            awardType,
            days,
            limit,
        });

        this.allSources.push(...sources);

        const result = {
            count: results.length,
            summary: brief,
            awards: sources.map((s) => ({
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
            top_recipients: sources.slice(0, 3).map((s) => s.title.slice(0, 60)),
        };

        return { result, preview };
    }

    private async execFiscalDataQuery(
        args: Record<string, unknown>
    ): Promise<{ result: Record<string, unknown>; preview: Record<string, unknown> }> {
        const dataset = (args.dataset as string) || "debt_to_penny";
        const limit = typeof args.limit === "number" ? args.limit : 10;

        const { records, sources, brief } = await this.fiscalDataClient.queryDataset({
            dataset,
            pageSize: limit,
        });

        this.allSources.push(...sources);

        const result = {
            count: records.length,
            dataset,
            summary: brief,
            records: sources.map((s) => ({
                id: s.id,
                title: s.title,
                date: s.date,
                url: s.url,
            })),
        };

        const preview = {
            count: records.length,
            dataset,
        };

        return { result, preview };
    }

    private async execDataGovSearch(
        args: Record<string, unknown>
    ): Promise<{ result: Record<string, unknown>; preview: Record<string, unknown> }> {
        const query = (args.query as string) || "";
        const organization = args.organization as string | undefined;
        const resFormat = args.format as string | undefined;
        const limit = typeof args.limit === "number" ? args.limit : 10;

        const { datasets, sources } = await this.dataGovClient.searchDatasets({
            query,
            organization,
            resFormat,
            rows: limit,
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
                excerpt: s.excerpt && s.excerpt.length > 200 ? `${s.excerpt.slice(0, 200)}...` : s.excerpt,
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
        const query = args.query as string | undefined;
        const component = args.component as string | undefined;
        const days = typeof args.days === "number" ? args.days : 30;
        const limit = typeof args.limit === "number" ? args.limit : 10;

        const { releases, sources } = await this.dojClient.searchPressReleases({
            query,
            component,
            days,
            limit,
        });

        this.allSources.push(...sources);

        const result = {
            count: releases.length,
            press_releases: sources.map((s) => ({
                id: s.id,
                title: s.title,
                date: s.date,
                url: s.url,
                excerpt: s.excerpt && s.excerpt.length > 200 ? `${s.excerpt.slice(0, 200)}...` : s.excerpt,
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

        const query = (args.query as string) || "";
        const limit = typeof args.limit === "number" ? args.limit : 10;

        const { results, sources } = await this.searchGovClient.search({
            query,
            limit,
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
        fetch_url_content: `Fetch URL: ${String(args.url || "").slice(0, 50)}`,
        search_pdf_memory: `Search PDF memory: ${String(args.query || "").slice(0, 50)}`,
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
