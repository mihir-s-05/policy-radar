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
| `OPENAI_MODEL` | No | `gpt-5.2` | Default OpenAI model |
| `EMBEDDING_MODEL` | No | `text-embedding-3-small` | Embedding model for PDF RAG |
| `DEFAULT_API_MODE` | No | `responses` | OpenAI API mode: `responses` or `chat_completions` |
| `PORT` | No | `8001` | Backend port |
| `RAG_PERSIST_DIR` | No | `./chroma` | ChromaDB storage path |
| `RAG_COLLECTION` | No | `pdf_memory` | ChromaDB collection name |
| `RAG_CHUNK_SIZE` | No | `1200` | PDF chunk size (chars) |
| `RAG_CHUNK_OVERLAP` | No | `200` | PDF chunk overlap (chars) |
| `RAG_MAX_CHUNKS` | No | `500` | Max chunks per PDF |
| `RAG_TOP_K` | No | `5` | Retrieval count |
| `SEARCHGOV_AFFILIATE` | No | - | Search.gov affiliate id |
| `SEARCHGOV_ACCESS_KEY` | No | - | Search.gov access key |
| `VITE_API_BASE` | No | `http://localhost:8001` | Frontend API base URL |

\* Required only when using OpenAI as the provider.

### Providers and Settings

The UI settings panel lets you:

- Select a model provider (OpenAI, Anthropic, Gemini, or Custom Endpoint).
- Switch OpenAI API mode between Responses and Chat Completions.
- Add or remove provider model names, with validation against provider APIs.
- Add custom OpenAI-compatible endpoints (vLLM, Ollama, LM Studio, etc.).
- Override API keys locally (stored in browser local storage).

## Quick Start

```bash
cd backend-ts
npm install
npm run dev
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
  "model": "gpt-5.2",
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
|-- backend-ts/
|   |-- src/
|   |   |-- api/          # Hono routes
|   |   |-- clients/      # Government API clients + PDF utilities
|   |   |-- models/       # Zod schemas & SQLite database
|   |   |-- services/     # LLM service, tool execution, PDF memory
|   |   |-- config.ts     # Settings from env vars
|   |   `-- index.ts      # Server entrypoint
|   |-- package.json
|   `-- tsconfig.json
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

## License

MIT License

## Disclaimer

This is not legal advice. All information should be verified with official sources. This tool is for research and informational purposes only.
