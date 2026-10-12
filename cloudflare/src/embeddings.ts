import { body, HttpError, integer, json, ownsSession, text } from "./http";
import { block, embeddingBucket, nextReset, reserve } from "./budget";

export const EMBEDDING_MODEL = "@cf/baai/bge-small-en-v1.5";
export async function embeddings(request: Request, env: Env, ownerHash: string) {
  if (String(env.EMBEDDINGS_ENABLED) !== "true") throw new HttpError(503, "Free embeddings are disabled until the account's free plan is verified.", "embeddings_disabled");
  const input = await body(request, 40_000);
  await ownsSession(env, ownerHash, text(input.session_id, 100));
  if (!Array.isArray(input.texts) || input.texts.length < 1 || input.texts.length > 16 ||
    input.texts.some(s => typeof s !== "string" || !s.trim() || s.length > 1600))
    throw new HttpError(400, "Embed 1–16 non-empty text chunks, each at most 1,600 characters.");
  const texts = input.texts as string[];
  // UTF-8 bytes conservatively bound token count. A 2x margin and fixed overhead
  // protect the account even if tokenization/metering differs from our estimate.
  const bytes = texts.reduce((sum,s) => sum+new TextEncoder().encode(s).length,0);
  const reserved = Math.ceil(bytes * 1841 / 1_000_000 * 2) + texts.length;
  const bucket = embeddingBucket();
  const maximum = integer(Number(env.EMBEDDING_DAILY_BUDGET), 8000, 8000);
  const used = await reserve(env, bucket, reserved, maximum);
  try {
    const output = await env.AI.run(EMBEDDING_MODEL, { text: texts });
    if (!("data" in output) || !Array.isArray(output.data)) throw new Error("Unexpected embedding output.");
    return json({ data: output.data, model: EMBEDDING_MODEL, budget: { used, maximum, resets_at: nextReset() } });
  } catch (error) {
    // Fail closed on an upstream error, including account-wide quota used elsewhere.
    // We cannot tell whether a failed call was metered, so stop for the rest of today.
    await block(env, bucket);
    console.error(JSON.stringify({ event: "embedding_upstream_stopped", day: bucket }));
    throw new HttpError(429, "Hosted embeddings have stopped for today after an upstream error or quota limit. No paid fallback will run.", "free_quota_exhausted");
  }
}
