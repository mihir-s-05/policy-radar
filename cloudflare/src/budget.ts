import { HttpError } from "./http";

// Conditional UPSERT performs the check and reservation in one atomic D1 statement.
// Failed/time-out calls retain their reservations; they are never refunded blindly.
export async function reserve(env: Env, bucket: string, amount: number, maximum: number): Promise<number> {
  if(!Number.isSafeInteger(amount)||amount<=0||!Number.isSafeInteger(maximum)||maximum<=0||amount>maximum)throw new HttpError(429,"The free quota is exhausted. Requests are stopped until it resets.","free_quota_exhausted");
  const row = await env.DB.prepare(`INSERT INTO budgets(bucket,used) SELECT ?,? WHERE ?<=?
    ON CONFLICT(bucket) DO UPDATE SET used=used+excluded.used
    WHERE blocked=0 AND used+excluded.used<=? RETURNING used`)
    .bind(bucket, amount, amount, maximum, maximum).first<{used:number}>();
  if (!row) throw new HttpError(429, "The free quota is exhausted. Requests are stopped until it resets.", "free_quota_exhausted");
  return row.used;
}
export async function block(env: Env, bucket: string) {
  await env.DB.prepare("INSERT INTO budgets(bucket,used,blocked) VALUES(?,0,1) ON CONFLICT(bucket) DO UPDATE SET blocked=1")
    .bind(bucket).run();
}
export const embeddingBucket = () => `embeddings:${new Date().toISOString().slice(0,10)}`;
export const nextReset = () => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()+1)).toISOString();
