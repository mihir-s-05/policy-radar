import { spawn, type ChildProcess } from "child_process";
import { getSettings } from "../config.js";

let chromaProcess: ChildProcess | null = null;
let ensurePromise: Promise<boolean> | null = null;

function parseChromaUrl(url: string): { url: string; host: string; port: string } {
    const parsed = new URL(url);
    return {
        url: parsed.toString().replace(/\/$/, ""),
        host: parsed.hostname || "127.0.0.1",
        port: parsed.port || "8002",
    };
}

async function pingChroma(baseUrl: string): Promise<boolean> {
    const endpoints = [
        "/api/v1/heartbeat",
        "/api/v2/heartbeat",
        "/api/v1/version",
        "/api/v2/version",
        "/heartbeat",
        "/api/v1/collections",
        "/",
    ];
    for (const endpoint of endpoints) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 2000);
            const response = await fetch(`${baseUrl}${endpoint}`, {
                method: "GET",
                signal: controller.signal,
            });
            clearTimeout(timeout);
            if (response.ok || response.status < 500) {
                return true;
            }
        } catch {
        }
    }
    return false;
}

function startChromaServer(host: string, port: string, persistDir: string): void {
    if (chromaProcess) {
        return;
    }

    const args = ["run", "--host", host, "--port", port, "--path", persistDir];
    console.log(`Starting Chroma server: chroma ${args.join(" ")}`);

    try {
        chromaProcess = spawn("chroma", args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
        console.error(`Failed to spawn Chroma server: ${error}`);
        chromaProcess = null;
        return;
    }

    chromaProcess.stdout?.on("data", (chunk) => {
        const text = chunk.toString().trim();
        if (text) {
            console.log(`[chroma] ${text}`);
        }
    });

    chromaProcess.stderr?.on("data", (chunk) => {
        const text = chunk.toString().trim();
        if (text) {
            console.warn(`[chroma] ${text}`);
        }
    });

    chromaProcess.on("exit", (code, signal) => {
        console.warn(`Chroma server exited (code=${code}, signal=${signal})`);
        chromaProcess = null;
    });

    chromaProcess.on("error", (error) => {
        console.error(`Chroma server error: ${error}`);
        chromaProcess = null;
    });
}

export async function ensureChromaServerRunning(): Promise<boolean> {
    if (ensurePromise) {
        return ensurePromise;
    }

    ensurePromise = (async () => {
        const settings = getSettings();
        const chromaUrl = settings.chromaServerUrl;
        const { url, host, port } = parseChromaUrl(chromaUrl);

        const isUp = await pingChroma(url);
        if (isUp) {
            return true;
        }

        if (!settings.chromaAutoStart) {
            console.warn(
                `Chroma server not reachable at ${url} and auto-start is disabled. RAG will be unavailable.`
            );
            return false;
        }

        startChromaServer(host, port, settings.ragPersistDir);

        const maxAttempts = 60;
        let delayMs = 500;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            if (await pingChroma(url)) {
                console.log(`Chroma server is ready at ${url}`);
                return true;
            }
            if ((attempt + 1) % 10 === 0) {
                console.log(`Waiting for Chroma to start (${attempt + 1}/${maxAttempts})...`);
            }
            delayMs = Math.min(2000, delayMs + 100);
        }

        console.warn(
            `Chroma server did not respond after ${maxAttempts} attempts at ${url}. RAG may be unavailable.`
        );
        return false;
    })();

    try {
        return await ensurePromise;
    } finally {
        ensurePromise = null;
    }
}
