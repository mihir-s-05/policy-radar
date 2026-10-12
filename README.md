# Policy Radar Chatbot

A research chatbot for tracking U.S. federal policy activity across multiple official government sources.

## Highlights

- Multi-source search across Regulations.gov, GovInfo, Congress.gov, Federal Register, USAspending, Treasury Fiscal Data, data.gov, DOJ press releases, and Search.gov.
- Multi-provider LLM support: OpenAI (Responses or Chat Completions), Anthropic, Gemini, and OpenAI-compatible custom endpoints.
- Streaming answers with a live work log of tool calls and citations for each response.
- Source cards with full-text viewer and PDF extraction support.
- Session history, editable user messages, and stored sources per conversation.
- Manuscript-style UI with configurable sources, time window, and model selection.

## Prerequisites

- Python 3.10+
- Node.js 18+
- API keys (see configuration)

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GOV_API_KEY` | Yes | - | API key used for Regulations.gov, GovInfo, Congress.gov, and data.gov |
| `OPENAI_API_KEY` | Yes* | - | OpenAI API key (required when using OpenAI provider) |
| `ANTHROPIC_API_KEY` | No | - | Anthropic API key |
| `GOOGLE_API_KEY` | No | - | Google Gemini API key |
| `OPENAI_MODEL` | No | `gpt-6.1-sol` | Default OpenAI model |
| `EMBEDDING_MODEL` | No | `text-embedding-3-small` | Embedding model for PDF RAG |
| `DEFAULT_API_MODE` | No | `responses` | OpenAI API mode: `responses` or `chat_completions` |
| `PORT` | No | `8000` | Backend port |
| `RAG_PERSIST_DIR` | No | `./chroma` | ChromaDB storage path |
| `RAG_COLLECTION` | No | `pdf_memory` | ChromaDB collection name |
| `RAG_CHUNK_SIZE` | No | `1200` | PDF chunk size (chars) |
| `RAG_CHUNK_OVERLAP` | No | `200` | PDF chunk overlap (chars) |
| `RAG_MAX_CHUNKS` | No | `500` | Max chunks per PDF |
| `RAG_TOP_K` | No | `5` | Retrieval count |
The UI settings panel lets you:

- Select a model provider (OpenAI, Anthropic, Gemini, or Custom Endpoint).
- Switch OpenAI API mode between Responses and Chat Completions.
- Add or remove provider model names, with validation against provider APIs.
- Add custom OpenAI-compatible endpoints (vLLM, Ollama, LM Studio, etc.).
- Enter provider keys for the current browser tab (session storage, with an in-memory fallback).

## Quick Start

```bash
cd backend
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

```bash
cd frontend
npm install
npm run dev
```

## Example Prompts

1. "Summarize recent EPA rulemakings on emissions in the last 30 days."
2. "Find Federal Register notices about AI safety from last week."
3. "Show recent Congress.gov bills related to immigration reform."
4. "Look up USAspending awards tied to cybersecurity in the last year."
5. "Find DOJ press releases about antitrust enforcement this month."

## API

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/session` | POST | Create a new chat session |
| `/api/sessions` | GET | List chat sessions |
| `/api/sessions/{id}` | DELETE | Delete a chat session |
| `/api/sessions/{id}/messages` | GET | Fetch messages for a session |
| `/api/sessions/{id}/messages/{id}` | PATCH | Update a message |
| `/api/chat` | POST | Non-streaming chat |
| `/api/chat/stream` | POST | Streaming chat (SSE) |
| `/api/config` | GET | Provider config, defaults, and available models |
| `/api/validate-model` | POST | Validate a model name for a provider |
| `/api/content/fetch` | POST | Fetch full text content for a URL |
| `/api/health` | GET | Health check |

### Chat Request (streaming or non-streaming)

```json
{
  "session_id": "uuid-string",
  "message": "Your question here",
  "mode": "both",
  "sources": {
    "regulations": true,
    "govinfo": true,
    "congress": false,
    "federal_register": false,
    "usaspending": false,
    "fiscal_data": false,
    "datagov": false,
    "doj": false,
    "searchgov": false
  },
  "days": 30,
  "model": "gpt-6.1-sol",
  "provider": "openai",
  "api_mode": "responses",
  "custom_model": {
    "base_url": "http://localhost:11434/v1",
    "model_name": "llama3.2",
    "api_key": "optional"
  },
  "api_key": "optional"
}
```

## Architecture

```
policy_chatbotv2/
|-- backend/
|   |-- app/
|   |   |-- api/          # FastAPI routes
|   |   |-- clients/      # Government API clients + PDF utilities
|   |   |-- models/       # Pydantic schemas & database
|   |   |-- services/     # LLM service, tool execution, PDF memory
|   |   |-- config.py     # Settings from env vars
|   |   |-- main.py       # FastAPI app
|   |   `-- __init__.py
|   `-- requirements.txt
|-- frontend/
|   |-- src/
|   |   |-- api/          # API client
|   |   |-- components/   # UI components + settings modal
|   |   |-- hooks/        # Custom React hooks
|   |   |-- types/        # TypeScript types
|   |   |-- App.tsx       # Main app
|   |   |-- index.css
|   |   `-- main.tsx
|   |-- public/
|   |-- package.json
|   `-- README.md
`-- README.md
```

## Security Notes

- API keys can be set via environment variables; the UI can override them per provider.
- Keys are never embedded in the frontend bundle.
- All government API calls are made from the backend.
- SQLite stores session data locally.
- ChromaDB stores PDF embeddings locally under `RAG_PERSIST_DIR`.

## Hosted app with visitor API keys

The public product keeps the existing manuscript frontend, chat, source reader,
and research work log. Set `PUBLIC_MODE=true` on the backend to require visitors'
OpenAI, Anthropic, or Gemini keys. Host model and embedding credentials are ignored
in this mode, even if they are present in the environment. Missing keys are rejected
before saving the request or starting model work. Shared OAuth and custom endpoints
are disabled in hosted mode; they remain available locally.

Provider and embedding keys live in the current tab's session storage, with an
in-memory fallback. Non-secret preferences remain in local storage. Older persistent
keys are erased during migration and must be entered again. In the hosted app,
keys pass through a fixed-provider Worker relay; visitors pay their chat provider's
API charges. The Worker has no owner chat key. Cloudflare embeddings use the free
allocation, while Local embeddings run on the visitor's device. API keys are not
stored in D1, document indexes, or logs. Python remains available for local development.

Hosted conversations, messages, citations, research steps, model names, document
text, and model-specific vector indexes are durable browser IndexedDB records.
The existing `policy-radar-documents` database upgrades in place. Conversation
creation, browsing, editing, saving, deletion, and stopping do not send session
requests to the Worker or write D1. The browser sends only recent history (at most
30 messages / 120 KB of text), followed by bounded native tool state; the relay
rejects JSON above 700 KB. Cancellation aborts the browser's provider stream.
Cloudflare and MiniLM vectors remain separate despite sharing 384 dimensions.
Deleting a conversation atomically removes its documents and research artifacts.

Configuration → Saved data exports/imports a versioned JSON backup (up to 50 MB),
with an individual-conversation export option for larger libraries,
and clears saved browser data only after confirmation. Imports validate content
and vectors, exclude credential fields, and preserve conflicting conversations
instead of overwriting them. Storage denial, full storage, and blocked upgrades
produce visible errors; there is no silent durable fallback. Browsers can evict
site data, so retain an export. Backups contain private research: keep them safe.
Data is specific to this browser profile and origin, without account sync.

Previous D1 sessions are frozen and protected by the original browser capability.
Configuration offers an explicit import, including a migration-code input for a
different origin. Import commits locally before deletion is offered; an export
and a separate confirmation are required by the UI before deleting server copies.
Legacy session/message reads are paginated; oversized imports fail visibly and
leave server copies intact. No migration drops the old tables or their content.
The cutover check found one empty session and zero messages. The private Python
SQLite/Chroma database was never uploaded. The local Python app keeps its existing
session API and storage behavior.

Browser storage belongs to an origin: `workers.dev` data does not automatically
appear at `policy.mihir-s.com`. Transfer a saved-data export between origins. If
the old URL is already disabled and you need its browser data, temporarily
re-enable the existing Worker's old route for an owner-approved export, then
disable it again; do not create another deployment. A legacy server migration
code is the original `policy-radar-browser-token` capability, not a chat API key.
Existing old-origin browser data and server copies are retained, not purged.

The source reader can reopen saved document text without an upstream fetch.
New research only reuses a document artifact as a ten-minute cache, then refreshes
the government source, so durable saved research does not become a permanent
cache of live government content.

### Current model catalog

Catalog verified October 9, 2026. Prices below are standard USD per million input /
output tokens, excluding cache discounts, reasoning volume, and provider tools.

| Provider | Models (input / output) | Intended choice |
|----------|-------------------------|-----------------|
| OpenAI | `gpt-6.1-sol` ($2 / $10), `gpt-6-luna` ($0.10 / $0.50), `gpt-6-astra` ($10 / $50) | Balanced default, budget, premium reasoning |
| Anthropic | `claude-opus-5-5` ($4 / $20), `claude-sonnet-5-5` ($2 / $10), `claude-haiku-5-5` ($0.10 / $0.50) | High capability, balanced, budget |
| Gemini | `gemini-3.8-flash` ($0.75 / $3.75), `gemini-3.5-flash-lite` ($0.30 / $2.50), `gemini-3.1-pro-preview` ($2 / $12) | Fast default, budget, Pro preview |

OpenAI long-context pricing is higher. Haiku's quoted tier is for prompts up to
100,000 tokens; larger prompts cost $0.50 / $2.50. Gemini Pro's quoted tier is up to
200,000 input tokens. Gemini 3.8 Flash prices double on January 1, 2027. Astra is a
premium option, not a promise of identical cost to the former reasoning choice.
Old preset models and old saved picker lists are removed; user-added models can
still be validated with the visitor's own key. Availability and prices are verified
from documentation, not by billable live completions.

Sources: [OpenAI models](https://developers.openai.com/api/docs/models),
[OpenAI pricing](https://developers.openai.com/api/docs/pricing),
[Claude models](https://platform.claude.com/docs/en/models/overview),
[Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing),
[Gemini models](https://ai.google.dev/gemini-api/docs/models),
[Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing).

### Shared government access

Keep the free `GOV_API_KEY` on the server, separate from visitor model credentials.
The documented quotas are suitable for occasional portfolio use with caching.

| Source | Published quota | Reference |
|--------|-----------------|-----------|
| Regulations.gov reads / api.data.gov default | 1,000 requests per rolling hour per key | [GSA API](https://open.gsa.gov/api/regulationsgov/), [api.data.gov](https://api.data.gov/docs/developer-manual/) |
| Congress.gov | 5,000 requests per hour | [Library of Congress](https://github.com/LibraryOfCongress/api.congress.gov/blob/main/README.md) |
| GovInfo | 36,000/hour, 1,200/minute, 40/second | [GPO API](https://github.com/usgpo/api/blob/main/README.md#keys) |
| Search.gov | 1,000/hour with a separate affiliate/access-key setup | [GSA Search.gov](https://open.gsa.gov/api/searchgov-results/) |

Published service-specific limits override the general default; actual key usage
must be checked from `X-RateLimit-Limit` and `X-RateLimit-Remaining`. A research run
can make many upstream calls, so these are request quotas, not user/session quotas.
Budgeting 20 uncached calls per run would allow roughly 50 runs/hour at the most
restrictive default; that is a planning estimate, not a measured run cost.

The hosted Worker shares a ten-minute D1 cache for public GET and search POST
responses. Cache hits do not reserve upstream calls or write D1. Uncached calls,
document fetches, and redirect hops reserve globally: 800 per rolling 61-minute
window and 4,000/day. Failed attempts keep reservations. Stored response payloads
are capped at 64 KB; larger responses reach the browser without entering D1.

### Cloudflare Free deployment

Live app: **https://policy.mihir-s.com/**. The dashboard showed
**Free / Current plan / $0** before the custom-domain deployment. Keep this account on Workers Free:
Cloudflare blocks excess Workers AI use on Free; Paid accounts charge for overage.
This deployment uses Workers Static Assets, Workers AI, and D1.

The existing frontend keeps its layout and styling. Small Worker endpoints relay
visitor chat requests and government API calls. The research loop, PDF.js extraction,
and vector search run in the browser to avoid a heavy server workload. D1 stores
only the bounded government cache and atomic budgets, plus frozen legacy sessions
awaiting explicit migration. No new user conversation content is stored there.
Production uses same-origin requests through `frontend/.env.production`.

The default embedding model is `@cf/baai/bge-small-en-v1.5`. Before every call, D1
atomically reserves `ceil((UTF-8 bytes + 512 × texts) × 1841 × 4 / 1,000,000) + texts`
units, using the entire input rather than relying on the model's 512-token
truncation. The rate is 1,841 neurons per million input tokens; the 4x margin and
per-text overhead are intentionally conservative. Policy Radar's daily reservation
limit is clamped to 4,000, leaving planning headroom for other projects sharing the
account's 10,000-neuron/day allowance. Each request allows 1–16 nonempty texts,
1,600 characters/text, and a 40 KB JSON body. The model is fixed server-side;
client model, budget, session, or token changes cannot increase the cap.
Failed calls retain their reservations. Any
upstream error blocks embeddings for the remaining UTC day. The browser stops
sending calls after a quota rejection, and no paid fallback runs. Cloudflare's
account-wide Free limit is the actual no-overage billing barrier. Reservations
are not actual neuron measurements and cannot enforce a precise realtime
account-wide allowance: other Workers consume it independently, metering can lag,
and pricing/tokenization can change. Calls already admitted concurrently may finish
after another call fails, but all retain their atomic reservations. D1 failures
before admission prevent inference. The failure latch also requires a successful
D1 write; Free remains the final protection if that write itself fails. Do not
upgrade Workers Paid or configure paid AI Gateway credits for this app.

The allowance resets at 00:00 UTC. Chat and direct document reading can still work
when embeddings stop. Visitors may manually select Local in Configuration's existing
Embedding tab. Local uses pinned q8 MiniLM in a Web Worker, lazy loading, model
caching, and a single WASM thread. The build downloads and verifies the public
model files from an immutable Hub revision; Cloudflare serves them as static assets.
Only the CPU/WASM runtime is bundled; local inference batches at most eight chunks
to bound activation memory. It needs an initial model/runtime download, then
uses device CPU. Switching models requires indexing documents with that model.
PDFs are bounded to 12 MB and 200 pages; indexing is bounded to 400 overlapping
chunks per document. Scanned pages retain a bounded image-reading path with the
visitor's chat model. Government requests share an 800-request rolling hourly
budget and reuse cached searches for ten minutes. Only the government key is
deployed as a secret. Search.gov needs separate affiliate/access-key configuration.
Hourly maintenance clears expired cache/control rows and old minute buckets.
There are no per-visitor D1 counters or new request-control records.

Burst limits use Workers' rate-limit bindings: 80 API calls/minute per ingress IP,
40 embedding calls/minute per IP (enough for one bounded PDF index), and 240 API
calls/minute shared per location.
Namespaces are specific to Policy Radar. IP keys use Cloudflare's ingress header,
so rotating browser capabilities cannot reset them, but shared networks may share
a burst limit. These bindings are permissive, eventually consistent, and **local
to a Cloudflare location**, not global accounting. The tiny D1 budget store remains
necessary for globally atomic limits; public cache writes occur only on bounded
uncached government requests. Ordinary browsing and local embeddings do not write
D1. Daily government admission bounds D1 work/cache growth under rotating clients.
These resources remain on Workers Free, with no paid gateway or infrastructure.
`policy-radar` is the same Worker; its custom domain is `policy.mihir-s.com` and
`workers_dev` / `preview_urls` are explicitly disabled.

For a new deployment, first verify Workers Free in the dashboard, create an empty
D1 database, and put its ID in `cloudflare/wrangler.jsonc`:

```bash
cd frontend
npm ci
npm run build
cd ../cloudflare
npm ci
npm run types
npm run check
npm run test
npx wrangler d1 migrations apply DB --remote
npm run deploy
npx wrangler secret put GOV_API_KEY
```

Never deploy an owner OpenAI/Anthropic/Gemini key. The relay uses fixed provider
endpoints and disables OpenAI response storage. A provider stream error does not
automatically repeat a potentially billable chat request.

The separate `/benchmark` page compares 48 identical synthetic policy passages and
six paraphrased queries. It reports initialization, throughput, warm queries,
ranking, retrieval matches, persistent-index reuse, and cached local reinitialization.
Download its JSON to preserve a run. It also tests the browser document reader.
These are functional comparisons, not comprehensive retrieval-quality benchmarks;
times depend on browser, device, network, and cache state.

References: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[Workers AI free quota](https://developers.cloudflare.com/workers-ai/platform/pricing/),
[D1 free limits](https://developers.cloudflare.com/d1/platform/pricing/),
[BGE small](https://developers.cloudflare.com/workers-ai/models/bge-small-en-v1.5/),
[Transformers.js](https://huggingface.co/docs/transformers.js/index).

### Local validation

```bash
cd backend
python -m pytest tests -q
cd ../frontend
node --test tests/settings-storage.test.cjs
npm run build
cd ../cloudflare
npm run check
npm run test
```

The hosted billing/ownership tests mock providers and forbid external network calls.
The storage tests use isolated synthetic storage objects, not a person's browser data.
The existing project-wide ESLint failures still need separate cleanup.

## License

MIT License

## Disclaimer

This is not legal advice. All information should be verified with official sources. This tool is for research and informational purposes only.
