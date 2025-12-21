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

## Quick Start

### 1. Set Environment Variables

```bash
# Required
export GOV_API_KEY=your_government_api_key
export OPENAI_API_KEY=your_openai_api_key

# Optional
export OPENAI_MODEL=gpt-5.2  # Default: gpt-5.2
export EMBEDDING_MODEL=text-embedding-3-small  # Default: text-embedding-3-small
export PORT=8000            # Default: 8000
export RAG_PERSIST_DIR=./chroma  # Default: ./chroma
```

On Windows (PowerShell):
```powershell
$env:GOV_API_KEY = "your_government_api_key"
$env:OPENAI_API_KEY = "your_openai_api_key"
```

### 2. Run the Backend

```bash
cd backend

# Create virtual environment (recommended)
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Run the server
uvicorn app.main:app --reload --port 8000
```

The API will be available at `http://localhost:8000`

### 3. Run the Frontend

```bash
cd frontend

# Install dependencies
npm install

# Run development server
npm run dev
```

The UI will be available at `http://localhost:5173`

## Configuration

### Frontend Environment

Create a `.env` file in the `frontend` directory:

```env
VITE_API_BASE=http://localhost:8000
```

### Backend Environment

Create a `.env` file in the `backend` directory:

```env
GOV_API_KEY=your_key_here
OPENAI_API_KEY=your_key_here
OPENAI_MODEL=gpt-5.2
EMBEDDING_MODEL=text-embedding-3-small
PORT=8000

# RAG / PDF Memory
RAG_PERSIST_DIR=./chroma
RAG_COLLECTION=pdf_memory
RAG_CHUNK_SIZE=1200
RAG_CHUNK_OVERLAP=200
RAG_MAX_CHUNKS=500
RAG_TOP_K=5
```

### PDF Memory (RAG)

- PDF text is chunked and embedded per session, then stored in ChromaDB for retrieval
- The assistant can search indexed PDF content with the `search_pdf_memory` tool
- Persistent storage lives under `RAG_PERSIST_DIR` and survives restarts

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

## Troubleshooting

### Rate Limit Errors (HTTP 429)

The government APIs have rate limits:
- Default: ~1000 requests/hour for registered API keys
- DEMO_KEY: Much lower limits

**Solutions:**
1. Wait and retry (the app handles this automatically with exponential backoff)
2. Register for a production API key at [api.data.gov](https://api.data.gov/signup/)

### Invalid API Key Errors

- Verify your `GOV_API_KEY` is set correctly
- Ensure there are no extra spaces or quotes
- Check that the key is active at [api.data.gov](https://api.data.gov/)

### OpenAI Errors

- Verify your `OPENAI_API_KEY` is valid
- Check your OpenAI account has sufficient credits
- Ensure the model specified in `OPENAI_MODEL` is available to your account

### PDF Extraction Issues

- PDF text extraction uses `pdfplumber` first, then falls back to `pypdf`
- PDF image extraction uses `PyMuPDF`
- There is no OCR; scanned PDFs without embedded text may yield limited results

### Regulations.gov 403s

- Some pages occasionally return `403` on first request; the backend retries with browser-like headers and falls back to the API-provided file formats

### Connection Errors

1. Make sure both backend and frontend are running
2. Check the backend is accessible at `http://localhost:8000`
3. Verify CORS is properly configured (frontend origin must be allowed)

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
