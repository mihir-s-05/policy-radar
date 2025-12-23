import { BaseAPIClient } from "./base.js";
import { getSettings } from "../config.js";
import type { SourceItem } from "../models/schemas.js";

export class CongressClient extends BaseAPIClient {
    private apiKey: string;

    constructor() {
        const settings = getSettings();
        super(settings.congressBaseUrl);
        this.apiKey = settings.govApiKey;
    }

    private getHeaders(): Record<string, string> {
        return {
            "X-Api-Key": this.apiKey,
            Accept: "application/json",
        };
    }

    private normalizeBill(bill: Record<string, unknown>): SourceItem {
        const billType = ((bill.type as string) || "").toLowerCase();
        const billNumber = bill.number as string || "";
        const congress = bill.congress as number | string || "";

        const url = `https://www.congress.gov/bill/${congress}th-congress/${billType}/${billNumber}`;

        const latestAction = bill.latestAction as Record<string, unknown> | undefined;
        const updateDate =
            (bill.updateDate as string) || latestAction?.actionDate as string || null;

        const summary = latestAction?.text as string || null;

        return {
            source_type: "congress_bill",
            id: `${congress}-${billType}-${billNumber}`,
            title: (bill.title as string) || "Untitled Bill",
            agency: null,
            date: updateDate,
            url,
            excerpt: summary,
            content_type: "bill",
            raw: bill,
        };
    }

    private normalizeVote(vote: Record<string, unknown>, chamber: string = "house"): SourceItem {
        const voteNumber =
            (vote.rollNumber as string) || (vote.rollCallNumber as string) || "";
        const congress = vote.congress as string || "";
        const session = vote.session as string || "";

        const url = `https://www.congress.gov/roll-call-vote/${congress}th-congress-${session}/${chamber}/${voteNumber}`;

        const question = (vote.question as string) || "Roll Call Vote";
        const voteResult = vote.result as string || "";
        const title = voteResult ? `${question} - ${voteResult}` : question;

        const voteDate = (vote.date as string) || (vote.updateDate as string) || null;

        return {
            source_type: "congress_vote",
            id: `${congress}-${session}-${chamber}-${voteNumber}`,
            title,
            agency: chamber.charAt(0).toUpperCase() + chamber.slice(1),
            date: voteDate,
            url,
            excerpt: vote.description as string || null,
            content_type: "vote",
            raw: vote,
        };
    }

    async searchBills(options: {
        query: string;
        congress?: number;
        billType?: string;
        limit?: number;
        offset?: number;
    }): Promise<{ bills: Record<string, unknown>[]; sources: SourceItem[] }> {
        const { query, congress, limit = 10, offset = 0 } = options;

        let endpoint = "/bill";
        if (congress) {
            endpoint = `/bill/${congress}`;
        }

        const params: Record<string, string | number> = {
            format: "json",
            limit: Math.min(limit, 250),
            offset,
        };

        const url = `${this.baseUrl}${endpoint}`;
        console.log(`Fetching Congress bills: ${url}`);

        const data = await this.requestWithRetry<{ bills: Record<string, unknown>[] }>({
            url,
            headers: this.getHeaders(),
            params,
        });

        let bills = data.bills || [];

        // Client-side filter by query
        if (query) {
            const queryLower = query.toLowerCase();
            bills = bills.filter(
                (b) =>
                    ((b.title as string) || "").toLowerCase().includes(queryLower) ||
                    ((b.number as string) || "").toLowerCase().includes(queryLower)
            );
        }

        bills = bills.slice(0, limit);
        const sources = bills.map((bill) => this.normalizeBill(bill));

        return { bills, sources };
    }

    async getBill(options: {
        congress: number;
        billType: string;
        billNumber: number;
    }): Promise<{ bill: Record<string, unknown> | null; source: SourceItem | null }> {
        const { congress, billType, billNumber } = options;

        const url = `${this.baseUrl}/bill/${congress}/${billType.toLowerCase()}/${billNumber}`;
        const params = { format: "json" };

        console.log(`Fetching Congress bill: ${url}`);

        const data = await this.requestWithRetry<{ bill: Record<string, unknown> }>({
            url,
            headers: this.getHeaders(),
            params,
        });

        const bill = data.bill;
        if (bill) {
            return { bill, source: this.normalizeBill(bill) };
        }
        return { bill: null, source: null };
    }

    async searchVotes(options: {
        chamber?: string;
        congress?: number;
        limit?: number;
    }): Promise<{ votes: Record<string, unknown>[]; sources: SourceItem[] }> {
        const { chamber = "house", congress = 118, limit = 10 } = options;

        const endpoint = `/${chamber}/rollCall/${congress}`;
        const url = `${this.baseUrl}${endpoint}`;

        const params: Record<string, string | number> = {
            format: "json",
            limit: Math.min(limit, 250),
        };

        console.log(`Fetching Congress votes: ${url}`);

        const data = await this.requestWithRetry<Record<string, unknown>>({
            url,
            headers: this.getHeaders(),
            params,
        });

        let votes =
            (data.roll_calls as Record<string, unknown>[]) ||
            (data.rollCalls as Record<string, unknown>[]) ||
            [];

        if (!votes.length && data.vote) {
            votes = [data.vote as Record<string, unknown>];
        }

        votes = votes.slice(0, limit);
        const sources = votes.map((vote) => this.normalizeVote(vote, chamber));

        return { votes, sources };
    }
}
