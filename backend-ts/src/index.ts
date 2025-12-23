import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { config } from "dotenv";

// Load environment before anything else
config();

import { getSettings } from "./config.js";
import { initDb } from "./models/database.js";
import { router } from "./api/index.js";

// Validate essential environment variables
const settings = getSettings();

if (!settings.govApiKey) {
    console.warn("WARNING: GOV_API_KEY is not set. Government API access may be limited.");
}

if (!settings.openaiApiKey) {
    console.warn("WARNING: OPENAI_API_KEY is not set. AI features will not work.");
}

// Initialize database
console.log("Initializing database...");
initDb();
console.log("Database initialized.");

// Create Hono app
const app = new Hono();

// Middleware
app.use("*", logger());
app.use(
    "*",
    cors({
        origin: ["http://localhost:3000", "http://localhost:5173", "http://127.0.0.1:3000", "http://127.0.0.1:5173"],
        allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allowHeaders: ["Content-Type", "Authorization"],
        exposeHeaders: ["Content-Length"],
        maxAge: 600,
        credentials: true,
    })
);

// Mount API routes
app.route("/", router);

// Root endpoint
app.get("/", (c) => {
    return c.json({
        name: "Policy Radar API",
        version: "1.0.0",
        status: "running",
        docs: "/api/health",
    });
});

// Start server
const port = settings.port;
console.log(`Starting server on port ${port}...`);

serve(
    {
        fetch: app.fetch,
        port,
    },
    (info) => {
        console.log(`🚀 Policy Radar API running at http://localhost:${info.port}`);
        console.log(`   Health check: http://localhost:${info.port}/api/health`);
        console.log(`   Provider: ${settings.llmProvider}`);
        console.log(`   Model: ${settings.openaiModel}`);
        console.log(`   API Mode: ${settings.defaultApiMode}`);
    }
);
