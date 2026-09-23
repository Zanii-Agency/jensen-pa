// ADR-0002 Phase 1 — durable confirm layer (Class C1: model self-confirm).
//
// Data access for the `pending_actions` table. The real Law 8 mechanism: the
// gate writes a PROPOSED row; a DETERMINISTIC confirm-router (not the model)
// executes it only when a DISTINCT user inbound confirms.
//
// FAIL-SAFE BY CONSTRUCTION: every function catches (including table-absent
// PGRST205 before the migration runs) and returns null / no-op. So until the
// migration is applied AND the gate/router are wired, importing or even calling
// this changes nothing. UNWIRED on this commit — no production code imports it.
import { sbSelect, sbInsert, sbUpdate, enc } from "./rest";

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

// Stable idempotency key over (tool, sorted args) so logically-identical
// proposals collide (the unique partial index dedups open ones).
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

// Propose: write a pending row keyed to the proposing inbound. Returns the row,
// or null if the table is absent / write fails. On a duplicate open proposal
// (unique partial index) we read back the existing open row so the caller still
// gets a handle to confirm against.
export async function proposePending(input: {
  party: string; tool: string; args: any; proposedInboundId?: string | null;
}): Promise<PendingAction | null> {
  const hash = argsHash(input.tool, input.args);
  try {
    const rows = await sbInsert<PendingAction>("pending_actions", {
      party: input.party,
      tool: input.tool,
      args: input.args ?? {},
      args_hash: hash,
      proposed_inbound_id: input.proposedInboundId ?? null,
      status: "pending",
    });
    return rows?.[0] ?? null;
  } catch {
    try {
      const open = await sbSelect<PendingAction>(
        "pending_actions",
        `party=eq.${enc(input.party)}&tool=eq.${enc(input.tool)}&args_hash=eq.${enc(hash)}&status=eq.pending&limit=1`,
      );
      return open?.[0] ?? null;
    } catch { return null; }
  }
}

// The most recent still-open, non-expired proposal for a party (null if none /
// table absent). The confirm-router calls this when a user affirmation arrives.
export async function findOpenPending(party: string): Promise<PendingAction | null> {
  try {
    const rows = await sbSelect<PendingAction>(
      "pending_actions",
      `party=eq.${enc(party)}&status=eq.pending&order=created_at.desc&limit=1`,
    );
    const row = rows?.[0];
    if (!row) return null;
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;
    return row;
  } catch { return null; }
}

// Confirm + claim. Called by the deterministic confirm-router when a DISTINCT
// user inbound confirms. The load-bearing invariant (kills same-turn self-confirm):
// a confirm whose inbound id EQUALS the proposing inbound id is refused. Wins the
// row via a status=pending-guarded PATCH, then re-reads to prove the claim (no
// double-execute under concurrency). Returns the claimed row, or null.
export async function confirmAndClaim(id: string, confirmInboundId: string | null): Promise<PendingAction | null> {
  try {
    const rows = await sbSelect<PendingAction>("pending_actions", `id=eq.${enc(id)}&limit=1`);
    const row = rows?.[0];
    if (!row || row.status !== "pending") return null;
    if (
      confirmInboundId != null &&
      row.proposed_inbound_id != null &&
      confirmInboundId === row.proposed_inbound_id
    ) {
      return null; // SELF-CONFIRM: same inbound proposed and confirmed — not a real user confirmation.
    }
    await sbUpdate("pending_actions", `id=eq.${enc(id)}&status=eq.pending`, {
      status: "confirmed",
      confirm_inbound_id: confirmInboundId ?? null,
    });
    // Re-read to prove WE won the guarded transition (a concurrent confirm loses).
    const after = await sbSelect<PendingAction>("pending_actions", `id=eq.${enc(id)}&limit=1`);
    const claimed = after?.[0];
    if (claimed && claimed.status === "confirmed" && (claimed.confirm_inbound_id ?? null) === (confirmInboundId ?? null)) {
      return claimed;
    }
    return null;
  } catch { return null; }
}

// Record the execution outcome after the router runs the tool.
export async function markExecuted(id: string, outcome: { ok: boolean; result?: any; error?: string }): Promise<void> {
  try {
    await sbUpdate("pending_actions", `id=eq.${enc(id)}`, {
      status: "executed",
      result: outcome.ok ? (outcome.result ?? null) : null,
      error: outcome.ok ? null : (outcome.error ?? "failed"),
    });
  } catch { /* fail-safe: never block on bookkeeping */ }
}

// Cancel an open proposal (e.g. the user said "no").
export async function cancelPending(id: string): Promise<void> {
  try {
    await sbUpdate("pending_actions", `id=eq.${enc(id)}&status=eq.pending`, { status: "cancelled" });
  } catch { /* fail-safe */ }
}
