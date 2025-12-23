import { BaseAPIClient } from "./base.js";
import { getSettings } from "../config.js";
import type { SourceItem } from "../models/schemas.js";

export class FiscalDataClient extends BaseAPIClient {
    private static DATASETS: Record<string, string> = {
        debt_to_penny: "/v2/accounting/od/debt_to_penny",
        debt_outstanding: "/v1/debt/mspd/mspd_table_1",
        treasury_offset: "/v1/debt/top/top_state",
        interest_rates: "/v1/accounting/od/avg_interest_rates",
        monthly_receipts: "/v1/accounting/mts/mts_table_4",
        monthly_outlays: "/v1/accounting/mts/mts_table_5",
        federal_surplus_deficit: "/v2/accounting/od/statement_net_cost",
    };

    constructor() {
        const settings = getSettings();
        super(settings.fiscalDataBaseUrl);
    }

    private formatCurrency(amount: unknown): string {
        if (amount == null) return "N/A";
        let num: number;
        try {
            num = typeof amount === "number" ? amount : parseFloat(String(amount));
        } catch {
            return String(amount);
        }

        if (isNaN(num)) return String(amount);

        const absNum = Math.abs(num);
        if (absNum >= 1_000_000_000_000) {
            return `$${(num / 1_000_000_000_000).toFixed(2)}T`;
        }
        if (absNum >= 1_000_000_000) {
            return `$${(num / 1_000_000_000).toFixed(2)}B`;
        }
        if (absNum >= 1_000_000) {
            return `$${(num / 1_000_000).toFixed(2)}M`;
        }
        return `$${num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }

    private formatFiscalBrief(
        data: { data: Record<string, unknown>[]; meta?: Record<string, unknown> },
        datasetName: string,
        queryContext: string = ""
    ): string {
        const lines: string[] = [`# Treasury Fiscal Data: ${datasetName}\n`];

        if (queryContext) {
            lines.push(`**Query Context:** ${queryContext}\n`);
        }

        const records = data.data || [];
        const meta = data.meta || {};

        if (!records.length) {
            lines.push("No fiscal data found for the specified criteria.\n");
            return lines.join("\n");
        }

        lines.push(`**Total Records:** ${meta["total-count"] || records.length}\n`);
        lines.push("**Data Source:** U.S. Treasury Fiscal Data\n");

        lines.push("\n## Recent Data\n");

        for (let i = 0; i < Math.min(records.length, 10); i++) {
            const record = records[i];
            lines.push(`### Record ${i + 1}`);

            if (record.record_date) {
                lines.push(`- **Date:** ${record.record_date}`);
            }

            if (record.tot_pub_debt_out_amt != null) {
                lines.push(
                    `- **Total Public Debt Outstanding:** ${this.formatCurrency(record.tot_pub_debt_out_amt)}`
                );
            }

            if (record.avg_interest_rate_amt != null) {
                lines.push(`- **Average Interest Rate:** ${record.avg_interest_rate_amt}%`);
            }
            if (record.security_desc) {
                lines.push(`- **Security Type:** ${record.security_desc}`);
            }

            if (record.current_month_net_rcpt_amt != null) {
                lines.push(
                    `- **Monthly Receipts:** ${this.formatCurrency(record.current_month_net_rcpt_amt)}`
                );
            }
            if (record.current_month_net_outly_amt != null) {
                lines.push(
                    `- **Monthly Outlays:** ${this.formatCurrency(record.current_month_net_outly_amt)}`
                );
            }

            // Show additional fields
            const shownFields = new Set([
                "record_date",
                "tot_pub_debt_out_amt",
                "avg_interest_rate_amt",
                "security_desc",
                "current_month_net_rcpt_amt",
                "current_month_net_outly_amt",
            ]);

            let extraCount = 0;
            for (const [key, value] of Object.entries(record)) {
                if (extraCount >= 5) break;
                if (!shownFields.has(key) && value && !key.endsWith("_link")) {
                    const label = key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
                    lines.push(`- **${label}:** ${value}`);
                    extraCount++;
                }
            }

            lines.push("");
        }

        return lines.join("\n");
    }

    private normalizeFiscal(record: Record<string, unknown>, datasetName: string): SourceItem {
        const recordDate = (record.record_date as string) || "";

        let title: string;
        if (record.tot_pub_debt_out_amt != null) {
            title = `Public Debt: ${this.formatCurrency(record.tot_pub_debt_out_amt)}`;
        } else if (record.avg_interest_rate_amt != null) {
            title = `Interest Rate: ${record.avg_interest_rate_amt}% - ${record.security_desc || "Treasury"}`;
        } else {
            title = `Fiscal Data Record - ${recordDate}`;
        }

        return {
            source_type: "fiscal_data",
            id: `${datasetName}-${recordDate}`,
            title,
            agency: "U.S. Treasury",
            date: recordDate,
            url: `https://fiscaldata.treasury.gov/datasets/${datasetName.replace(/_/g, "-")}`,
            excerpt: `Record date: ${recordDate}`,
            content_type: "fiscal_data",
            raw: record,
        };
    }

    async queryDataset(options: {
        dataset?: string;
        filters?: Record<string, string>;
        fields?: string[];
        sort?: string;
        pageSize?: number;
    }): Promise<{
        records: Record<string, unknown>[];
        sources: SourceItem[];
        brief: string;
    }> {
        const {
            dataset = "debt_to_penny",
            filters,
            fields,
            sort = "-record_date",
            pageSize = 10,
        } = options;

        const endpoint = FiscalDataClient.DATASETS[dataset];
        if (!endpoint) {
            throw new Error(`Unknown dataset: ${dataset}`);
        }

        const url = `${this.baseUrl}${endpoint}`;

        const params: Record<string, string | number> = {
            "page[size]": pageSize,
            "page[number]": 1,
            sort,
        };

        if (filters) {
            for (const [field, condition] of Object.entries(filters)) {
                params[`filter[${field}]`] = condition;
            }
        }

        if (fields && fields.length > 0) {
            params.fields = fields.join(",");
        }

        console.log(`Querying Fiscal Data: ${dataset}`);

        const data = await this.requestWithRetry<{
            data: Record<string, unknown>[];
            meta?: Record<string, unknown>;
        }>({
            url,
            params,
        });

        const records = data.data || [];
        const sources = records.map((r) => this.normalizeFiscal(r, dataset));
        const brief = this.formatFiscalBrief(data, dataset);

        return { records, sources, brief };
    }
}
