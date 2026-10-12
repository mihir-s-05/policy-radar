import { body, HttpError, json, ownsSession, readBounded, record, text } from "./http";

const endpoints = {
  openai: "https://api.openai.com/v1/",
  anthropic: "https://api.anthropic.com/v1/",
  gemini: "https://generativelanguage.googleapis.com/v1beta/",
};
export async function provider(request: Request, env: Env, ownerHash: string, validate = false) {
  const input = await body(request, 700_000);
  const name = text(input.provider) as keyof typeof endpoints;
  if (!(name in endpoints)) throw new HttpError(400, "Select OpenAI, Anthropic, or Gemini.");
  const key = text(input.api_key, 500).trim();
  if (!key) throw new HttpError(400, "Enter your own provider API key in Configuration before sending an inquiry.");
  const model = text(input.model_name || input.model, 100);
  if (!/^[a-zA-Z0-9._-]+$/.test(model)) throw new HttpError(400, "Invalid model name.");
  const headers = new Headers({ "Content-Type": "application/json" });
  if (name === "openai") headers.set("Authorization", `Bearer ${key}`);
  if (name === "anthropic") { headers.set("x-api-key", key); headers.set("anthropic-version", "2023-06-01"); }
  if (name === "gemini") headers.set("x-goog-api-key", key);
  if (validate) {
    const result = await fetch(`${endpoints[name]}models/${encodeURIComponent(model)}`, { headers, redirect:"manual", signal: AbortSignal.timeout(20_000) });
    await result.body?.cancel();
    return json({ valid: result.ok, message: result.ok ? "Model is available with your key." : `Provider rejected model validation (${result.status}).` });
  }
  const sessionId = text(input.session_id,100), requestId = text(input.request_id,100);
  await ownsSession(env, ownerHash, sessionId);
  const active = await env.DB.prepare("SELECT cancelled FROM requests WHERE owner_hash=? AND request_id=? AND session_id=?")
    .bind(ownerHash,requestId,sessionId).first<{cancelled:number}>();
  if (!active || active.cancelled) throw new HttpError(409, "Inquiry has stopped.");
  const payload = record(input.payload);
  let path: string;
  if (name === "openai") {
    path = input.api_mode === "chat_completions" ? "chat/completions" : "responses";
    payload.model = model; payload.store = false; payload.stream = true;
  } else if (name === "anthropic") {
    path = "messages"; payload.model = model; payload.stream = true;
  } else {
    path = `models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  }
  const result = await fetch(endpoints[name]+path, {
    method: "POST", headers, body: JSON.stringify(payload), redirect:"manual", signal: request.signal,
  });
  if (!result.ok) {
    await result.body?.cancel();
    throw new HttpError(result.status === 429 ? 429 : 400, `Your ${name} provider rejected the request (${result.status}). Check your key, model access, and provider quota.`, "provider_rejected");
  }
  return new Response(result.body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" } });
}
