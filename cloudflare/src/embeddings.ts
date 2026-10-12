import { body, HttpError, integer, json } from "./http";
import { block, embeddingBucket, nextReset, reserve } from "./budget";

export const EMBEDDING_MODEL = "@cf/baai/bge-small-en-v1.5";
export const MAX_DAILY_RESERVATION = 4000;
export function reservationFor(texts:string[]) {
  // 1841 neurons/M input tokens. Reserve the ENTIRE UTF-8 input, rather than
  // relying on the model's 512-token truncation, plus 512 token-units per text,
  // a 4x tokenizer/metering margin, and one extra unit per text. This is a
  // conservative reservation, NOT Cloudflare's real account-wide usage meter.
  const bytes=texts.reduce((sum,s)=>sum+new TextEncoder().encode(s).length,0);
  return Math.ceil((bytes+512*texts.length)*1841*4/1_000_000)+texts.length;
}
export async function embeddings(request: Request, env: Env) {
  if (String(env.EMBEDDINGS_ENABLED) !== "true") throw new HttpError(503, "Free embeddings are disabled until the account's free plan is verified.", "embeddings_disabled");
  const input = await body(request, 40_000);
  if(input.model!==undefined&&input.model!==EMBEDDING_MODEL)throw new HttpError(400,"Only the configured free embedding model is available.");
  if (!Array.isArray(input.texts) || input.texts.length < 1 || input.texts.length > 16 ||
    input.texts.some(s => typeof s !== "string" || !s.trim() || s.length > 1600))
    throw new HttpError(400, "Embed 1–16 non-empty text chunks, each at most 1,600 characters.");
  const texts = input.texts as string[];
  const reserved = reservationFor(texts);
  const bucket = embeddingBucket();
  const maximum = integer(Number(env.EMBEDDING_DAILY_BUDGET), MAX_DAILY_RESERVATION, MAX_DAILY_RESERVATION);
  const used = await reserve(env, bucket, reserved, maximum);
  try {
    const output = await env.AI.run(EMBEDDING_MODEL, { text: texts });
    if (!("data" in output) || !Array.isArray(output.data)||output.data.length!==texts.length||output.data.some(vector=>!Array.isArray(vector)||vector.length!==384||vector.some(n=>typeof n!=="number"||!Number.isFinite(n)))) throw new Error("Unexpected embedding output.");
    return json({ data: output.data, model: EMBEDDING_MODEL, budget: { reserved,used, maximum, units:"conservative_reservations",account_usage_known:false,resets_at: nextReset() } });
  } catch (error) {
    // Fail closed on an upstream error, including account-wide quota used elsewhere.
    // We cannot tell whether a failed call was metered, so stop for the rest of today.
    await block(env, bucket);
    console.error(JSON.stringify({ event: "embedding_upstream_stopped", day: bucket }));
    throw new HttpError(429, "Hosted embeddings have stopped for today after an upstream error or quota limit. No paid fallback will run.", "free_quota_exhausted");
  }
}
