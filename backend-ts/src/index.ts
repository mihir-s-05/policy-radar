import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { config } from "dotenv";

config();

import { getSettings } from "./config.js";
import { initDb } from "./models/database.js";
import { router } from "./api/index.js";
import { ensureChromaServerRunning } from "./services/chromaServer.js";

const settings = getSettings();

const loggerName = "app.main";
const log = (level: "INFO" | "ERROR", message: string) => {
    const timestamp = new Date().toISOString();
    const output = `${timestamp} - ${loggerName} - ${level} - ${message}`;
    if (level === "ERROR") {
        console.error(output);
    } else {
        console.log(output);
    }
};

log("INFO", "Starting Policy Radar Chatbot API...");

if (!settings.govApiKey) {
    log("ERROR", "GOV_API_KEY environment variable is not set!");
    throw new Error("GOV_API_KEY environment variable is required");
}

if (!settings.openaiApiKey) {
    log("ERROR", "OPENAI_API_KEY environment variable is not set!");
    throw new Error("OPENAI_API_KEY environment variable is required");
}

initDb();
log("INFO", "Database initialized");
log("INFO", `Using OpenAI model: ${settings.openaiModel}`);
log("INFO", "API ready!");
ensureChromaServerRunning().catch((error) => {
    console.error(`Chroma auto-start failed: ${error}`);
});

const app = new Hono();
app.use(
    "*",
    cors({
        origin: [
            "http://localhost:3000",
            "http://localhost:5173",
            "http://127.0.0.1:3000",
            "http://127.0.0.1:5173",
        ],
        allowMethods: ["*"],
        allowHeaders: ["*"],
        credentials: true,
    })
);

app.route("/", router);

app.get("/", (c) =>
    c.json({
        name: "Policy Radar Chatbot API",
        version: "1.0.0",
        docs: "/docs",
    })
);

const port = settings.port;

const server = serve(
    {
        fetch: app.fetch,
        port,
    },
    (info) => {
        console.log(`Policy Radar Chatbot API running at http://localhost:${info.port}`);
    }
);

const shutdown = () => {
    log("INFO", "Shutting down Policy Radar Chatbot API...");
    server.close?.();
    process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
