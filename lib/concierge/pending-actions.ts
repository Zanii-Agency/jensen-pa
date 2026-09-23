// ADR-0002 Phase 1 — durable confirm layer (Class C1: model self-confirm).
//
// A destructive tool call is not executed; it is HELD here as a proposal with a
// code-written question. It becomes executable only in the ONE turn that
// immediately follows it, and only via a distinct later inbound.
//
// STORAGE: the existing `kv` table, not a dedicated `pending_actions` table.
// ADR-0002 specified its own table, but nobody who operates this bot has DDL
// access to Jensen's Supabase project (checked 2026-09-23: no DB URL, no token
// linked to the project, no SQL-exec RPC). `kv` already exists and the service
// key already writes it. One row per proposal, key `pending_action:<party>:<id>`.
//
// HOW A HELD ACTION GETS CONFIRMED (v4, 2026-09-23):
//  - WhatsApp: ONLY by a tap on its own reply button. The button id names this
//    exact action, so an "ok" to a reminder, a stale message, a swipe, or text
//    injected into the conversation can never fire it. (Three rounds of review
//    showed that inferring what a typed "yes" answers is not safely solvable.)
//  - Portal: a synchronous screen with no scheduled pushes landing in it. His bare
//    "yes" confirms only while the question is the last thing on that screen
//    (checked by the router), then claimOnPortal.
//  - Either way: one question in flight per party and channel; the proposing
//    message can never confirm it; the claim is an atomic, status-guarded PATCH
//    (two racing confirmations, exactly one executes; proven live 2026-09-23).
//
// FAIL-SAFE: every function catches and returns null / no-op. The gate treats a
// null proposal as "could not hold it" and REFUSES (fails closed).
import { sbSelect, sbInsert, sbUpdate, sbUpdateReturning, sbDelete, enc } from "./rest";

export type PendingStatus = "pending" | "confirmed" | "executed" | "expired" | "cancelled";
export type PendingAction = {
  id: string;
  party: string;
  tool: string;
  args: any;
  args_hash: string;
  channel: string;                     // "whatsapp" | "portal": only that channel can confirm it
  echo: string;                        // the exact question, written by code from the real rows
  proposed_text: string;               // the owner message that asked for it (for the name-mismatch wall)
  proposed_inbound_id: string | null;
  offered_to: string | null;           // unused since v4 (kept so older rows still parse)
  status: PendingStatus;
  confirm_inbound_id: string | null;
  result: any;
  error: string | null;
  created_at: string;
  expires_at: string;
  executed_at?: string;
};

const TTL_MS = 30 * 60_000;
const RETAIN_MS = 24 * 3_600_000;
const PREFIX = "pending_action:";

const keyFor = (party: string, id: string) => `${PREFIX}${party}:${id}`;
const partyLike = (party: string) => `key=like.${enc(`${PREFIX}${party}:*`)}`;
const byId = (id: string) => `key=like.${enc(`${PREFIX}*:${id}`)}`;
const STATUS_PENDING = `value->>status=eq.pending`;
const isLive = (a: PendingAction) => !a.expires_at || new Date(a.expires_at).getTime() >= Date.now();

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

async function openFor(party: string, channel: string): Promise<{ key: string; value: PendingAction }[]> {
  return sbSelect<{ key: string; value: PendingAction }>(
    "kv",
    `select=key,value&${partyLike(party)}&${STATUS_PENDING}&value->>channel=eq.${enc(channel)}&order=updated_at.desc&limit=10`,
  );
}

async function setValue(key: string, value: PendingAction): Promise<void> {
  await sbUpdate("kv", `key=eq.${enc(key)}`, { value, updated_at: Date.now() });
}

// Hold a destructive action. Returns it, or null on any storage fault (the gate
// then refuses). An identical still-open proposal is returned as-is; any OTHER
// open proposal for this party is cancelled, so only one question is ever live.
export async function proposePending(input: {
  party: string; tool: string; args: any; echo: string; proposedText: string; channel: string;
  proposedInboundId?: string | null;
}): Promise<PendingAction | null> {
  const hash = argsHash(input.tool, input.args);
  try {
    sweep(input.party).catch(() => {});
    const open = await openFor(input.party, input.channel);
    let same: { key: string; value: PendingAction } | null = null;
    for (const r of open) {
      if (r.value.args_hash === hash && isLive(r.value)) { same = r; continue; }
      await setValue(r.key, { ...r.value, status: "cancelled" });
    }
    if (same) {
      // The identical action was asked again (he asked "are those all of them?" and
      // the model re-held the same rows). Re-arm it for the NEXT reply. Left bound to
      // the previous inbound, his next "yes" would have cancelled it instead
      // (review 2, finding 2: the 16-Sep ask-again loop).
      const nowMs = Date.now();
      const rearmed: PendingAction = {
        ...same.value,
        echo: input.echo,
        proposed_text: input.proposedText || same.value.proposed_text,
        proposed_inbound_id: input.proposedInboundId ?? null,
        offered_to: null,
        expires_at: new Date(nowMs + TTL_MS).toISOString(),
      };
      await setValue(same.key, rearmed);
      return rearmed;
    }

    const nowMs = Date.now();
    const action: PendingAction = {
      id: crypto.randomUUID(),
      party: input.party,
      tool: input.tool,
      args: input.args ?? {},
      args_hash: hash,
      channel: input.channel,
      echo: input.echo,
      proposed_text: input.proposedText,
      proposed_inbound_id: input.proposedInboundId ?? null,
      offered_to: null,
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

export async function findOpenHold(party: string, channel: string): Promise<PendingAction | null> {
  try {
    return (await openFor(party, channel)).map((r) => r.value).find(isLive) ?? null;
  } catch {
    return null;
  }
}

// Claim on a BUTTON TAP. The tap's id names the action, so there is no question of
// which message it answers. Requires: still pending, not expired, same party, a
// WhatsApp hold. Atomic, so a double tap executes once.
export async function claimByTap(id: string, party: string, tapInboundId: string): Promise<PendingAction | null> {
  try {
    const rows = await sbSelect<{ key: string; value: PendingAction }>("kv", `select=key,value&${byId(id)}&limit=1`);
    const row = rows?.[0];
    const a = row?.value;
    if (!row || !a || a.status !== "pending" || !isLive(a) || a.party !== party || a.channel !== "whatsapp") return null;
    const claimed: PendingAction = { ...a, status: "confirmed", confirm_inbound_id: tapInboundId };
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

// What a tap on an old or already-used button should say, read from the record.
export async function holdStatus(id: string): Promise<PendingAction | null> {
  try {
    const rows = await sbSelect<{ value: PendingAction }>("kv", `select=value&${byId(id)}&limit=1`);
    return rows?.[0]?.value ?? null;
  } catch {
    return null;
  }
}

// Claim on the PORTAL: his own later bare "yes", accepted by the router only when
// the question is the last thing on his screen. Same guarantees as a tap: still
// pending, not expired, same party, a PORTAL hold, never the proposing message,
// atomic.
export async function claimOnPortal(id: string, party: string, inboundId: string | null | undefined): Promise<PendingAction | null> {
  if (!inboundId) return null;
  try {
    const rows = await sbSelect<{ key: string; value: PendingAction }>("kv", `select=key,value&${byId(id)}&limit=1`);
    const row = rows?.[0];
    const a = row?.value;
    if (!row || !a || a.status !== "pending" || !isLive(a) || a.party !== party || a.channel !== "portal") return null;
    if (a.proposed_inbound_id === inboundId) return null; // SELF-CONFIRM: the proposing message cannot confirm itself
    const claimed: PendingAction = { ...a, status: "confirmed", confirm_inbound_id: inboundId };
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

// The same action (same tool, same args) executed in the last few minutes. Used to
// refuse re-holding an outward send that already went out, so a double-tap can
// never send the same email twice.
export async function recentlyExecutedSame(party: string, tool: string, args: any, withinMs = 10 * 60_000): Promise<PendingAction | null> {
  const base = `select=value&${partyLike(party)}&value->>args_hash=eq.${enc(argsHash(tool, args))}&updated_at=gte.${Date.now() - withinMs}&limit=1`;
  try {
    // Sent successfully...
    const sent = await sbSelect<{ value: PendingAction }>("kv", `${base}&value->>status=eq.executed&value->>error=is.null`);
    if (sent?.[0]) return sent[0].value;
    // ...or still being sent right now: a second request must not send it twice
    // (review 4, finding 2).
    const running = await sbSelect<{ value: PendingAction }>("kv", `${base}&value->>status=eq.confirmed`);
    return running?.[0]?.value ?? null;
  } catch {
    return null;
  }
}

export async function markExecuted(id: string, outcome: { ok: boolean; result?: any; error?: string }): Promise<void> {
  await patchById(id, (a) => ({
    ...a,
    status: "executed",
    executed_at: new Date().toISOString(),
    result: outcome.ok ? (outcome.result ?? null) : null,
    error: outcome.ok ? null : (outcome.error ?? "failed"),
  }));
}

export async function cancelPending(id: string): Promise<void> {
  await patchById(id, (a) => (a.status === "pending" ? { ...a, status: "cancelled" } : a));
}

async function patchById(id: string, next: (a: PendingAction) => PendingAction): Promise<void> {
  try {
    const rows = await sbSelect<{ key: string; value: PendingAction }>("kv", `select=key,value&${byId(id)}&limit=1`);
    const row = rows?.[0];
    if (row?.value) await setValue(row.key, next(row.value));
  } catch { /* bookkeeping never blocks a reply */ }
}

// kv is shared with prefs/goals; a proposal row untouched for a day is finished
// business. The durable record of what was executed is the audit row the
// executor writes to chat_messages, so sweeping here loses no history.
async function sweep(party: string): Promise<void> {
  await sbDelete("kv", `${partyLike(party)}&updated_at=lt.${Date.now() - RETAIN_MS}`);
}
