import { BaseAPIClient } from "./base.js";
import { getSettings } from "../config.js";
import type { SourceItem } from "../models/schemas.js";

export class DOJClient extends BaseAPIClient {
    constructor() {
        const settings = getSettings();
        super(settings.dojBaseUrl);
    }

    private normalizePressRelease(release: Record<string, unknown>): SourceItem {
        const releaseId = (release.uuid as string) || (release.nid as string) || "";

        let url = release.url as string || "";
        if (!url && release.path) {
            url = `https://www.justice.gov${release.path}`;
        }

        let date: string | null = null;
        if (release.created) {
            try {
                const timestamp = parseInt(String(release.created), 10);
                date = new Date(timestamp * 1000).toISOString().split("T")[0];
            } catch {
                date = String(release.created);
            }
        } else if (release.changed) {
            try {
                const timestamp = parseInt(String(release.changed), 10);
                date = new Date(timestamp * 1000).toISOString().split("T")[0];
            } catch {
            }
        }

        const components = Array.isArray(release.component) ? release.component : undefined;
        let agency: string | null = null;
        if (components && components.length > 0) {
            const first = components[0];
            if (typeof first === "object" && first !== null && "name" in first) {
                agency = (first as Record<string, unknown>).name as string;
            } else if (typeof first === "string") {
                agency = first;
            }
        }

        let excerpt: string | null = null;
        const body = release.body;
        if (typeof body === "object" && body !== null && "summary" in (body as Record<string, unknown>)) {
            excerpt = (body as Record<string, unknown>).summary as string;
        } else if (release.teaser) {
            excerpt = release.teaser as string;
        }

        return {
            source_type: "doj_press_release",
            id: String(releaseId),
            title: (release.title as string) || "Untitled Press Release",
            agency: agency || "Department of Justice",
            date,
            url,
            excerpt,
            content_type: "press_release",
            raw: release,
        };
    }

    async searchPressReleases(options: {
        query?: string;
        component?: string;
        topic?: string;
        days?: number;
        limit?: number;
        page?: number;
    }): Promise<{ releases: Record<string, unknown>[]; sources: SourceItem[] }> {
        const { query, component, topic, days, limit = 10, page = 0 } = options;

        const params: Record<string, string | number> = {
            pagesize: limit,
            page,
            sort: "date",
            direction: "DESC",
        };

        if (query) {
            params.keyword = query;
        }

        if (component) {
            params.component = component;
        }

        if (topic) {
            params.topic = topic;
        }

        const url = `${this.baseUrl}/press_releases.json`;

        const data = await this.requestWithRetry<
            Record<string, unknown>[] | { results?: Record<string, unknown>[]; data?: Record<string, unknown>[] }
        >({
            url,
            headers: { Accept: "application/json" },
            params,
        });

        let releases: Record<string, unknown>[];
        if (Array.isArray(data)) {
            releases = data;
        } else {
            releases = data.results || data.data || [];
        }

        if (days && releases.length > 0) {
            const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
            releases = releases.filter((release) => {
                const created = release.created;
                if (created) {
                    try {
                        const timestamp = parseInt(String(created), 10);
                        const releaseDate = new Date(timestamp * 1000);
                        return releaseDate >= cutoff;
                    } catch {
                        return true;
                    }
                }
                return true;
            });
        }

        releases = releases.slice(0, limit);
        const sources = releases.map((r) => this.normalizePressRelease(r));

        return { releases, sources };
    }
}
