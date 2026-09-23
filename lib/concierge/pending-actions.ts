// ADR-0002 Phase 1 — durable confirm layer (Class C1: model self-confirm).
//
// The gate writes a PROPOSED action here; a DETERMINISTIC confirm-router (not
// the model) executes it only when a DISTINCT user inbound confirms.
//
// STORAGE: the existing `kv` table, not a dedicated `pending_actions` table.
// ADR-0002 specified its own table, but nobody who operates this bot has DDL
// access to Jensen's Supabase project (checked 2026-09-23: no DB URL, no token
// linked to the project, no SQL-exec RPC). `kv` already exists and the service
// key already writes it (prefs, goals and the legal blueprint live there), so the
// confirm layer needs zero schema changes to go live.
//
// One row per proposal: key `pending_action:<party>:<id>`, value = the action.
// The two properties the ADR needs still hold, both proven live on 2026-09-23:
//   - dedupe of identical open proposals: looked up by value->>args_hash
//   - atomic claim: a PATCH filtered on value->>status=pending returns the row
//     only to the caller whose UPDATE matched; two concurrent claims -> one wins
//
// FAIL-SAFE BY CONSTRUCTION: every function catches and returns null / no-op,
// so a storage fault degrades to the gate's previous behaviour, never worse.
import { sbSelect, sbInsert, sbUpdate, sbUpdateReturning, sbDelete, enc } from "./rest";

export type PendingStatus = "pending" | "confirmed" | "executed" | "expired" | "cancelled";
export type PendingAction = {
  id: string;
  party: string;
  tool: string;
  args: any;
  args_hash: string;
  proposed_inbound_id: string | null;
  status: PendingStatus;
  confirm_inbound_id: string | null;
  result: any;
  error: string | null;
  created_at: string;
  expires_at: string;
};

const TTL_MS = 30 * 60_000;        // an unconfirmed proposal dies after 30 minutes
const RETAIN_MS = 24 * 3_600_000;  // finished/expired rows are swept after a day
const PREFIX = "pending_action:";

const keyFor = (party: string, id: string) => `${PREFIX}${party}:${id}`;
const partyLike = (party: string) => `key=like.${enc(`${PREFIX}${party}:*`)}`;
const STATUS_PENDING = `value->>status=eq.pending`;
const isLive = (a: PendingAction) => !a.expires_at || new Date(a.expires_at).getTime() >= Date.now();

// Stable idempotency key over (tool, sorted args) so logically-identical
// proposals collide instead of stacking up.
export function argsHash(tool: string, args: any): string {
  return `${tool}:${djb2(stableStringify(args ?? {}))}`;
}
function stableStringify(o: any): string {
  if (o === null || typeof o !== "object") return JSON.stringify(o);
  if (Array.isArray(o)) return "[" + o.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(o[k])).join(",") + "}";
}
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Propose: write a pending action keyed to the proposing inbound. Returns it, or
// null on any storage fault. An identical proposal that is still open is returned
// as-is, so asking twice never creates two things to confirm.
export async function proposePending(input: {
  party: string; tool: string; args: any; proposedInboundId?: string | null;
}): Promise<PendingAction | null> {
  const hash = argsHash(input.tool, input.args);
  try {
    sweep(input.party).catch(() => {});
    const dup = await sbSelect<{ value: PendingAction }>(
      "kv",
      `select=value&${partyLike(input.party)}&${STATUS_PENDING}&value->>args_hash=eq.${enc(hash)}&limit=1`,
    );
    const existing = dup?.[0]?.value;
    if (existing && isLive(existing)) return existing;

    const nowMs = Date.now();
    const action: PendingAction = {
      id: crypto.randomUUID(),
      party: input.party,
      tool: input.tool,
      args: input.args ?? {},
      args_hash: hash,
      proposed_inbound_id: input.proposedInboundId ?? null,
      status: "pending",
      confirm_inbound_id: null,
      result: null,
      error: null,
      created_at: new Date(nowMs).toISOString(),
      expires_at: new Date(nowMs + TTL_MS).toISOString(),
    };
    await sbInsert("kv", { key: keyFor(input.party, action.id), value: action, updated_at: nowMs });
    return action;
  } catch {
    return null;
  }
}

// The most recent still-open, non-expired proposal for a party, or null.
export async function findOpenPending(party: string): Promise<PendingAction | null> {
  try {
    const rows = await sbSelect<{ value: PendingAction }>(
      "kv",
      `select=value&${partyLike(party)}&${STATUS_PENDING}&order=updated_at.desc&limit=5`,
    );
    return rows.map((r) => r.value).find(isLive) ?? null;
  } catch {
    return null;
  }
}

// Confirm + claim, called by the deterministic confirm-router. The load-bearing
// invariant (kills same-turn self-confirm): a confirm whose inbound id EQUALS the
// proposing inbound id is refused. The claim itself is a status=pending-guarded
// PATCH; only the caller whose UPDATE matched gets the row back, so a concurrent
// or replayed confirmation can never execute the action twice.
export async function confirmAndClaim(id: string, confirmInboundId: string | null): Promise<PendingAction | null> {
  try {
    const rows = await sbSelect<{ key: string; value: PendingAction }>(
      "kv",
      `select=key,value&key=like.${enc(`${PREFIX}*:${id}`)}&limit=1`,
    );
    const row = rows?.[0];
    const a = row?.value;
    if (!row || !a || a.status !== "pending" || !isLive(a)) return null;
    if (confirmInboundId != null && a.proposed_inbound_id != null && confirmInboundId === a.proposed_inbound_id) {
      return null; // SELF-CONFIRM: the same inbound proposed and confirmed — not a real user confirmation.
    }
    const claimed: PendingAction = { ...a, status: "confirmed", confirm_inbound_id: confirmInboundId ?? null };
    const won = await sbUpdateReturning<{ value: PendingAction }>(
      "kv",
      `key=eq.${enc(row.key)}&${STATUS_PENDING}`,
      { value: claimed, updated_at: Date.now() },
    );
    return won.length === 1 ? won[0].value : null;
  } catch {
    return null;
  }
}

// Record the execution outcome after the router runs the tool.
export async function markExecuted(id: string, outcome: { ok: boolean; result?: any; error?: string }): Promise<void> {
  await patchAction(id, (a) => ({
    ...a,
    status: "executed",
    result: outcome.ok ? (outcome.result ?? null) : null,
    error: outcome.ok ? null : (outcome.error ?? "failed"),
  }));
}

// Retire an open proposal (the user said no), so a later unrelated "yes" can
// never resurrect it.
export async function cancelPending(id: string): Promise<void> {
  await patchAction(id, (a) => (a.status === "pending" ? { ...a, status: "cancelled" } : a));
}

async function patchAction(id: string, next: (a: PendingAction) => PendingAction): Promise<void> {
  try {
    const rows = await sbSelect<{ key: string; value: PendingAction }>(
      "kv",
      `select=key,value&key=like.${enc(`${PREFIX}*:${id}`)}&limit=1`,
    );
    const row = rows?.[0];
    if (!row?.value) return;
    await sbUpdate("kv", `key=eq.${enc(row.key)}`, { value: next(row.value), updated_at: Date.now() });
  } catch { /* fail-safe: bookkeeping never blocks a reply */ }
}

// kv is shared with prefs/goals, so keep this layer from growing unbounded: any
// proposal row untouched for a day is finished business. Best-effort.
async function sweep(party: string): Promise<void> {
  await sbDelete("kv", `${partyLike(party)}&updated_at=lt.${Date.now() - RETAIN_MS}`);
}
