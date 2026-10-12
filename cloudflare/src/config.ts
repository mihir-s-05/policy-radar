import { DEFAULT_MODELS } from "../../frontend/src/lib/modelCatalog";
import { EMBEDDING_MODEL } from "./embeddings";

export function config() {
  return {
    public_mode:true, execution_mode:"browser", model:DEFAULT_MODELS.openai[0], available_models:DEFAULT_MODELS.openai,
    default_api_mode:"responses", embedding_provider:"cloudflare", embedding_model:EMBEDDING_MODEL,
    providers: {
      openai:{name:"openai",display_name:"OpenAI",base_url:"https://api.openai.com/v1",models:DEFAULT_MODELS.openai,api_key_detected:false,api_mode:"responses"},
      anthropic:{name:"anthropic",display_name:"Anthropic",base_url:"https://api.anthropic.com/v1",models:DEFAULT_MODELS.anthropic,api_key_detected:false,api_mode:"chat_completions"},
      gemini:{name:"gemini",display_name:"Google Gemini",base_url:"https://generativelanguage.googleapis.com/v1beta",models:DEFAULT_MODELS.gemini,api_key_detected:false,api_mode:"native"},
    },
    embedding_providers: {
      cloudflare:{name:"cloudflare",display_name:"Cloudflare (free quota)",models:[EMBEDDING_MODEL],api_key_detected:false},
      local:{name:"local",display_name:"Local (this device)",models:["sentence-transformers/all-MiniLM-L6-v2"],api_key_detected:false},
    },
  };
}
