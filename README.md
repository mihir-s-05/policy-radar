# Policy Radar Chatbot

A chatbot for exploring recent U.S. federal regulatory activity using official government APIs.

## Features

- **Real-time federal policy search** using Regulations.gov and GovInfo APIs
- **AI-powered responses** with OpenAI's Responses API and function calling
- **Live work log** showing tool calls and reasoning as the assistant works
- **Source cards** with direct links to official documents
- **Streaming responses** for real-time feedback
- **Configurable search** by source and time window
- **PDF extraction + images** from Regulations.gov and GovInfo documents
- **Session RAG memory** for PDFs with persistent ChromaDB storage

## Prerequisites

- Python 3.10+
- Node.js 18+
- API Keys:
  - **GOV_API_KEY**: Get from [api.data.gov](https://api.data.gov/signup/)
  - **OPENAI_API_KEY**: Get from [OpenAI Platform](https://platform.openai.com/)

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GOV_API_KEY` | Yes | - | API key from api.data.gov |
| `OPENAI_API_KEY` | Yes | - | OpenAI API key |
| `OPENAI_MODEL` | No | `gpt-5.2` | Chat model |
| `EMBEDDING_MODEL` | No | `text-embedding-3-small` | Embedding model for PDF RAG |
| `PORT` | No | `8000` | Backend port |
| `RAG_PERSIST_DIR` | No | `./chroma` | ChromaDB storage path |
| `RAG_COLLECTION` | No | `pdf_memory` | ChromaDB collection name |
| `RAG_CHUNK_SIZE` | No | `1200` | PDF chunk size (chars) |
| `RAG_CHUNK_OVERLAP` | No | `200` | PDF chunk overlap (chars) |
| `RAG_MAX_CHUNKS` | No | `500` | Max chunks per PDF |
| `RAG_TOP_K` | No | `5` | Retrieval count |
| `VITE_API_BASE` | No | `http://localhost:8000` | Frontend API base URL |

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

1. **Rulemakings by topic:**
   - "What major federal rulemakings happened in the last 60 days about asylum?"
   - "Find recent EPA regulations on water quality."

2. **Federal Register items:**
   - "Show recent Federal Register items about immigration this month."
   - "What are the latest proposed rules on healthcare?"

3. **Agency-specific:**
   - "What has the FDA published recently about food safety?"
   - "Show me recent DOL rulemakings about worker protections."

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/session` | POST | Create a new chat session |
| `/api/chat` | POST | Non-streaming chat (fallback) |
| `/api/chat/stream` | POST | Streaming chat with SSE |
| `/api/health` | GET | Health check |

### Request Format

```json
{
  "session_id": "uuid-string",
  "message": "Your question here",
  "mode": "both",  // "regulations", "govinfo", or "both"
  "days": 30       // 7, 30, 60, or 90
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
|   |   |-- services/     # OpenAI service, tool execution, PDF memory
|   |   |-- config.py     # Settings from env vars
|   |   |-- main.py       # FastAPI app
|   |   `-- __init__.py
|   `-- requirements.txt
|-- frontend/
|   |-- src/
|   |   |-- api/          # API client
|   |   |-- assets/
|   |   |-- components/
|   |   |   `-- ui/
|   |   |-- hooks/        # Custom React hooks
|   |   |-- lib/
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

- API keys are stored ONLY as environment variables
- Keys are NEVER exposed to the frontend bundle
- All API calls to government services are made from the backend
- SQLite database stores session data locally
- ChromaDB stores PDF embeddings locally under `RAG_PERSIST_DIR`

## License

MIT License

## Disclaimer

This is not legal advice. All information should be verified with official sources. This tool is for research and informational purposes only.
