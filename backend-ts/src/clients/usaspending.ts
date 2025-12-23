import { BaseAPIClient } from "./base.js";
import { getSettings } from "../config.js";
import type { SourceItem } from "../models/schemas.js";

export class USASpendingClient extends BaseAPIClient {
    private static DEFAULT_FIELDS = [
        "Award ID",
        "Recipient Name",
        "Award Amount",
        "Start Date",
        "End Date",
        "Awarding Agency",
        "Award Description",
    ];

    constructor() {
        const settings = getSettings();
        super(settings.usaSpendingBaseUrl);
    }

    private formatCurrency(amount: number | null | undefined): string {
        if (amount == null) return "N/A";
        const absAmount = Math.abs(amount);
        if (absAmount >= 1_000_000_000) {
            return `$${(amount / 1_000_000_000).toFixed(2)}B`;
        }
        if (absAmount >= 1_000_000) {
            return `$${(amount / 1_000_000).toFixed(2)}M`;
        }
        if (absAmount >= 1_000) {
            return `$${(amount / 1_000).toFixed(2)}K`;
        }
        return `$${amount.toFixed(2)}`;
    }

    private formatSpendingBrief(
        data: { results: Record<string, unknown>[] },
        queryContext: string = ""
    ): string {
        const lines: string[] = ["# USAspending Summary\n"];

        if (queryContext) {
            lines.push(`**Query Context:** ${queryContext}\n`);
        }

        const results = data.results || [];

        if (!results.length) {
            lines.push("No spending data found for the specified criteria.\n");
            return lines.join("\n");
        }

        lines.push(`**Total Results:** ${results.length}\n`);

        const totalObligations = results.reduce((sum, r) => {
            const amount =
                (r["Award Amount"] as number) ||
                (r.total_obligations as number) ||
                (r.obligated_amount as number) ||
                (r.amount as number) ||
                0;
            return sum + amount;
        }, 0);

        if (totalObligations) {
            lines.push(`**Total Obligations:** ${this.formatCurrency(totalObligations)}\n`);
        }

        lines.push("\n## Top Results\n");

        for (let i = 0; i < Math.min(results.length, 10); i++) {
            const result = results[i];
            const name =
                (result["Recipient Name"] as string) ||
                (result.recipient_name as string) ||
                (result["Awarding Agency"] as string) ||
                ((result.awarding_agency as Record<string, unknown>)?.toptier_agency as Record<string, unknown>)?.name as string ||
                (result.name as string) ||
                `Result ${i + 1}`;

            const amount =
                (result["Award Amount"] as number) ||
                (result.total_obligations as number) ||
                (result.obligated_amount as number) ||
                (result.amount as number);

            lines.push(`### ${i + 1}. ${name}`);
            if (amount) {
                lines.push(`- **Amount:** ${this.formatCurrency(amount)}`);
            }

            const description =
                (result["Award Description"] as string) || (result.description as string);
            if (description) {
                lines.push(`- **Description:** ${String(description).slice(0, 200)}...`);
            }

            const awardId =
                (result["Award ID"] as string) ||
                (result.award_id as string) ||
                (result.internal_id as string);
            if (awardId) {
                lines.push(`- **Award ID:** ${awardId}`);
            }

            lines.push("");
        }

        return lines.join("\n");
    }

    private normalizeSpending(result: Record<string, unknown>): SourceItem {
        const itemId =
            (result.generated_internal_id as string) ||
            (result.generated_unique_award_id as string) ||
            (result["Award ID"] as string) ||
            (result.award_id as string) ||
            (result.internal_id as string) ||
            String(Math.abs(JSON.stringify(result).split("").reduce((a, b) => a + b.charCodeAt(0), 0))).slice(0, 12);

        const title =
            (result["Recipient Name"] as string) ||
            (result.recipient_name as string) ||
            ((result["Award Description"] as string) || (result.description as string) || "").slice(0, 100) ||
            `Spending Record ${itemId}`;

        let agency: string | null = null;
        if (result["Awarding Agency"]) {
            agency = result["Awarding Agency"] as string;
        } else if (result.awarding_agency) {
            const aa = result.awarding_agency as Record<string, unknown>;
            const topTier = aa.toptier_agency as Record<string, unknown> | undefined;
            agency = topTier?.name as string || null;
        }

        const url = itemId
            ? `https://www.usaspending.gov/award/${itemId}`
            : "https://www.usaspending.gov";

        const amount =
            (result["Award Amount"] as number) ||
            (result.total_obligations as number) ||
            (result.obligated_amount as number);

        let excerpt = amount ? `Amount: ${this.formatCurrency(amount)}` : null;
        const description =
            (result["Award Description"] as string) || (result.description as string);
        if (description) {
            excerpt = (excerpt ? `${excerpt} - ` : "") + String(description).slice(0, 200);
        }

        return {
            source_type: "usaspending",
            id: String(itemId),
            title,
            agency,
            date:
                (result["Start Date"] as string) ||
                (result.action_date as string) ||
                (result.period_of_performance_start_date as string) ||
                null,
            url,
            excerpt,
            content_type: "spending",
            raw: result,
        };
    }

    async searchSpending(options: {
        keywords?: string[];
        agency?: string;
        recipient?: string;
        awardType?: string;
        days?: number;
        limit?: number;
    }): Promise<{
        results: Record<string, unknown>[];
        sources: SourceItem[];
        brief: string;
    }> {
        const {
            keywords,
            agency,
            recipient,
            awardType = "contracts",
            days = 365,
            limit = 10,
        } = options;

        const filters: Record<string, unknown> = {};

        if (keywords && keywords.length > 0) {
            const cleaned = keywords
                .filter((k) => typeof k === "string" && k.trim().length >= 3)
                .map((k) => k.trim());
            if (cleaned.length > 0) {
                filters.keywords = cleaned;
            }
        }

        if (agency?.trim()) {
            filters.agencies = [{ type: "awarding", tier: "toptier", name: agency.trim() }];
        }

        if (recipient?.trim()) {
            filters.recipient_search_text = [recipient.trim()];
        }

        const typeMap: Record<string, string[]> = {
            contracts: ["A", "B", "C", "D"],
            grants: ["02", "03", "04", "05"],
            loans: ["07", "08"],
            direct_payments: ["06", "10"],
        };

        const effectiveAwardType = (awardType || "contracts").trim().toLowerCase();
        if (!typeMap[effectiveAwardType]) {
            throw new Error(
                `Unsupported award_type '${awardType}'. Supported: ${Object.keys(typeMap).join(", ")}`
            );
        }
        filters.award_type_codes = typeMap[effectiveAwardType];

        const endDate = new Date();
        const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        filters.time_period = [
            {
                start_date: startDate.toISOString().split("T")[0],
                end_date: endDate.toISOString().split("T")[0],
            },
        ];

        const payload = {
            filters,
            fields: [...USASpendingClient.DEFAULT_FIELDS],
            limit,
            page: 1,
            sort: "Award Amount",
            order: "desc",
        };

        const url = `${this.baseUrl}/search/spending_by_award`;

        const data = await this.requestWithRetry<{ results: Record<string, unknown>[] }>({
            method: "POST",
            url,
            json: payload,
        });

        const results = data.results || [];
        const sources = results.map((r) => this.normalizeSpending(r));
        const brief = this.formatSpendingBrief(data, String(keywords));

        return { results, sources, brief };
    }
}
