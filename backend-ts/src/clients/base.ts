import { LRUCache } from "lru-cache";
import { getSettings } from "../config.js";

const settings = getSettings();

// Shared cache for GET requests
const cache = new LRUCache<string, object>({
    max: 1000,
    ttl: settings.cacheTtl * 1000, // Convert to milliseconds
});

export class RateLimitError extends Error {
    retryAfter: number | null;

    constructor(message: string, retryAfter: number | null = null) {
        super(message);
        this.name = "RateLimitError";
        this.retryAfter = retryAfter;
    }
}

export class APIError extends Error {
    statusCode: number;

    constructor(message: string, statusCode: number = 500) {
        super(message);
        this.name = "APIError";
        this.statusCode = statusCode;
    }
}

export interface RequestOptions {
    method?: string;
    headers?: Record<string, string>;
    params?: Record<string, string | number | boolean | undefined>;
    json?: unknown;
    useCache?: boolean;
}

export class BaseAPIClient {
    protected baseUrl: string;
    protected timeout: number;
    protected settings = getSettings();
    protected rateLimitRemaining: number | null = null;
    protected rateLimitLimit: number | null = null;

    constructor(baseUrl: string, timeout: number = 30000) {
        this.baseUrl = baseUrl;
        this.timeout = timeout;
    }

    private getCacheKey(method: string, url: string, params?: Record<string, unknown>): string {
        const paramStr = params
            ? Object.entries(params)
                .filter(([, v]) => v !== undefined)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => `${k}=${v}`)
                .join("&")
            : "";
        return `${method}:${url}?${paramStr}`;
    }

    private parseRateLimitHeaders(headers: Headers): void {
        const remaining = headers.get("X-RateLimit-Remaining");
        const limit = headers.get("X-RateLimit-Limit");

        if (remaining !== null) {
            this.rateLimitRemaining = parseInt(remaining, 10);
        }
        if (limit !== null) {
            this.rateLimitLimit = parseInt(limit, 10);
        }
    }

    protected buildUrl(path: string, params?: Record<string, string | number | boolean | undefined>): string {
        const url = new URL(path, this.baseUrl);
        if (params) {
            for (const [key, value] of Object.entries(params)) {
                if (value !== undefined) {
                    url.searchParams.set(key, String(value));
                }
            }
        }
        return url.toString();
    }

    protected async requestWithRetry<T = unknown>(options: RequestOptions & { url: string }): Promise<T> {
        const { method = "GET", url, headers, params, json, useCache = true } = options;

        // Build full URL with params
        const finalUrl = params ? this.buildUrl(url, params) : url;
        const cacheKey = this.getCacheKey(method, finalUrl, params as Record<string, unknown>);

        // Check cache for GET requests
        if (useCache && method.toUpperCase() === "GET" && cache.has(cacheKey)) {
            return cache.get(cacheKey) as T;
        }

        let backoff = this.settings.initialBackoff * 1000;
        let lastError: Error | null = null;

        for (let attempt = 0; attempt <= this.settings.maxRetries; attempt++) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), this.timeout);

                const requestInit: RequestInit = {
                    method,
                    headers: {
                        "Accept": "application/json",
                        ...headers,
                        ...(json ? { "Content-Type": "application/json" } : {}),
                    },
                    signal: controller.signal,
                    ...(json ? { body: JSON.stringify(json) } : {}),
                };

                const response = await fetch(finalUrl, requestInit);
                clearTimeout(timeoutId);

                this.parseRateLimitHeaders(response.headers);

                // Handle rate limiting
                if (response.status === 429) {
                    const retryAfter = response.headers.get("Retry-After");
                    const waitTime = retryAfter ? parseFloat(retryAfter) * 1000 : backoff;

                    console.warn(
                        `Rate limited (429). Attempt ${attempt + 1}/${this.settings.maxRetries + 1}. Waiting ${waitTime}ms`
                    );

                    if (attempt < this.settings.maxRetries) {
                        await this.sleep(waitTime);
                        backoff *= 2;
                        continue;
                    } else {
                        throw new RateLimitError(
                            "Rate limit exceeded. Please try again later.",
                            waitTime / 1000
                        );
                    }
                }

                // Handle other errors
                if (!response.ok) {
                    const contentType = response.headers.get("content-type") || "";
                    let errorText = "";
                    try {
                        errorText = await response.text();
                    } catch {
                        errorText = "";
                    }
                    const preview = errorText.slice(0, 800);
                    const displayPreview = contentType.toLowerCase().includes("text/html")
                        ? "HTML error page returned (truncated)."
                        : preview;

                    console.error(
                        `API error ${response.status} (${contentType}): ${displayPreview}`
                    );

                    throw new APIError(
                        `API request failed (${response.status} ${contentType}): ${displayPreview}`,
                        response.status
                    );
                }

                const data = await response.json() as T;

                // Cache GET responses
                if (useCache && method.toUpperCase() === "GET") {
                    cache.set(cacheKey, data as object);
                }

                return data;
            } catch (error) {
                if (error instanceof RateLimitError || error instanceof APIError) {
                    throw error;
                }

                lastError = error as Error;
                const isTimeout = (error as Error).name === "AbortError";

                console.warn(
                    `Request ${isTimeout ? "timeout" : "error"}. Attempt ${attempt + 1}/${this.settings.maxRetries + 1}`
                );

                if (attempt < this.settings.maxRetries) {
                    await this.sleep(backoff);
                    backoff = Math.min(backoff * 2, 30000);
                    continue;
                }
            }
        }

        throw new APIError(`Request failed after retries: ${lastError?.message || "Unknown error"}`);
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    get rateLimitInfo(): { remaining: number | null; limit: number | null } {
        return {
            remaining: this.rateLimitRemaining,
            limit: this.rateLimitLimit,
        };
    }
}
