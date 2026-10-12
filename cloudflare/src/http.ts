export class HttpError extends Error {
  constructor(public status: number, message: string, public code = "request_failed") { super(message); }
}
export const json = (data: unknown, status = 200) => Response.json(data, {
  status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
});
export const integer = (value: unknown, fallback: number, max: number, min = 1) =>
  Math.max(min, Math.min(max, typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback));
export function text(value: unknown, max = 2000): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "Expected a JSON object.");
  return value as Record<string, unknown>;
}
export async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let output = "", total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) throw new HttpError(413, "Response is too large for this operation.");
      output += decoder.decode(next.value, { stream: true });
    }
    return output + decoder.decode();
  } finally { await reader.cancel(); }
}
export async function body(request: Request, maxBytes = 250_000) {
  try { return record(JSON.parse(await readBounded(new Response(request.body), maxBytes))); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, "Invalid JSON request."); }
}
export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, "0")).join("");
}
export async function owner(request: Request): Promise<string> {
  const token = request.headers.get("X-Session-Token") || "";
  if (!/^[a-f0-9]{64}$/.test(token)) throw new HttpError(401, "A browser session token is required.");
  return sha256(token);
}
export async function ownsSession(env: Env, ownerHash: string, sessionId: string) {
  if (!sessionId || !await env.DB.prepare("SELECT 1 FROM sessions WHERE session_id=? AND owner_hash=?")
    .bind(sessionId, ownerHash).first()) throw new HttpError(404, "Session not found.");
}
