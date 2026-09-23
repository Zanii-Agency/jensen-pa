// Raw PostgREST access. We deliberately do NOT use supabase-js .from() here:
// its realtime client needs native WebSocket (absent on Node 20) and was observed
// returning empty in some serverless bundles. Raw fetch is deterministic
// everywhere. Service-role key, server-only.

function base(): string {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error("SUPABASE_URL not set");
  return `${url}/rest/v1`;
}
function headers(extra: Record<string, string> = {}): Record<string, string> {
  const k = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || "";
  return { apikey: k, Authorization: `Bearer ${k}`, "content-type": "application/json", ...extra };
}
export const enc = encodeURIComponent;

export async function sbSelect<T = any>(table: string, qs = ""): Promise<T[]> {
  const r = await fetch(`${base()}/${table}?${qs}`, { headers: headers(), cache: "no-store" });
  if (!r.ok) throw new Error(`${table} select ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
export async function sbInsert<T = any>(table: string, rows: any | any[]): Promise<T[]> {
  const r = await fetch(`${base()}/${table}`, {
    method: "POST",
    headers: headers({ Prefer: "return=representation" }),
    body: JSON.stringify(Array.isArray(rows) ? rows : [rows]),
  });
  if (!r.ok) throw new Error(`${table} insert ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
export async function sbUpsert(table: string, rows: any | any[], onConflict = "id"): Promise<void> {
  const r = await fetch(`${base()}/${table}?on_conflict=${onConflict}`, {
    method: "POST",
    headers: headers({ Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify(Array.isArray(rows) ? rows : [rows]),
  });
  if (!r.ok) throw new Error(`${table} upsert ${r.status}: ${(await r.text()).slice(0, 200)}`);
}
export async function sbUpdate(table: string, qs: string, patch: any): Promise<void> {
  const r = await fetch(`${base()}/${table}?${qs}`, {
    method: "PATCH",
    headers: headers({ Prefer: "return=minimal" }),
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`${table} update ${r.status}: ${(await r.text()).slice(0, 200)}`);
}
// PATCH that reports which rows it actually changed. The confirm layer uses this
// as an atomic claim: a PATCH filtered on status=pending returns the row only to
// the one caller whose UPDATE matched, so two racing confirmations can never both
// execute. (Proven live on 2026-09-23: two concurrent claims, exactly one won.)
export async function sbUpdateReturning<T = any>(table: string, qs: string, patch: any): Promise<T[]> {
  const r = await fetch(`${base()}/${table}?${qs}`, {
    method: "PATCH",
    headers: headers({ Prefer: "return=representation" }),
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`${table} update ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
export async function sbDelete(table: string, qs: string): Promise<void> {
  const r = await fetch(`${base()}/${table}?${qs}`, { method: "DELETE", headers: headers() });
  if (!r.ok) throw new Error(`${table} delete ${r.status}: ${(await r.text()).slice(0, 200)}`);
}
// DELETE that returns the rows it actually removed. A count of ids ASKED for is
// not a count of rows deleted: ids can already be gone (review blocker E).
export async function sbDeleteReturning<T = any>(table: string, qs: string): Promise<T[]> {
  const r = await fetch(`${base()}/${table}?${qs}`, { method: "DELETE", headers: headers({ Prefer: "return=representation" }) });
  if (!r.ok) throw new Error(`${table} delete ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
export async function sbRpc<T = any>(fn: string, args: any): Promise<T[]> {
  const r = await fetch(`${base()}/rpc/${fn}`, { method: "POST", headers: headers(), body: JSON.stringify(args) });
  if (!r.ok) throw new Error(`rpc ${fn} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
