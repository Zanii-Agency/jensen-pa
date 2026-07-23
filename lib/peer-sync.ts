// CROSS-BOT TASK SYNC — the wall (ADR-0015). Dorje <-> Taona-bot.
//
// A task crosses to the peer bot ONLY on Jensen's explicit "send to Taona"
// intent (the send_task_to_peer tool), and ONLY the allowlisted fields below
// ever serialize. This module is the single door: sign, verify, and map. It is
// fail-closed (no secret => no trust) and default-OFF (PEER_SYNC !== "on" => no-op).
//
// It NEVER spreads a task row: the payload is built field by field so entity_id,
// notes, finance, guest/PII physically cannot leak even if a caller passes a full
// row. Same isolation doctrine as the MCP bridge (KT #397) and CTH vendor scope.
import crypto from "crypto";

export type PeerTaskPayload = {
  title: string;
  due: string | null;
  status: "open" | "done";
  correlation_id: string;
  source_bot: "dorje" | "taona-bot";
};

// The only fields allowed across the wall. Referenced by the wall-test so a future
// edit that widens it fails loudly.
export const PEER_ALLOWED_FIELDS = ["title", "due", "status", "correlation_id", "source_bot"] as const;

export function peerSyncEnabled(): boolean {
  return process.env.PEER_SYNC === "on";
}

function peerSecret(): string {
  return process.env.PEER_SYNC_SECRET || "";
}

export function peerUrl(): string {
  return (process.env.PEER_TAONA_URL || "").replace(/\/$/, "");
}

// Build the outbound payload from raw fields ONLY. Deliberately does not accept a
// task row / object spread: the wall is that PII fields have no path into here.
export function toPeerPayload(i: {
  title: string;
  due?: string | null;
  status?: "open" | "done";
  correlationId: string;
}): PeerTaskPayload {
  return {
    title: String(i.title || "").slice(0, 300),
    due: i.due ? String(i.due).slice(0, 40) : null,
    status: i.status === "done" ? "done" : "open",
    correlation_id: String(i.correlationId).slice(0, 80),
    source_bot: "dorje",
  };
}

// Accept only the allowlisted keys off an inbound (peer) payload. Anything else
// the peer sent is dropped here, before it can reach a DB write.
export function sanitizeInbound(raw: any): PeerTaskPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const cid = String(raw.correlation_id || "").slice(0, 80);
  const title = String(raw.title || "").slice(0, 300);
  if (!cid) return null;
  return {
    title,
    due: raw.due ? String(raw.due).slice(0, 40) : null,
    status: raw.status === "done" ? "done" : "open",
    correlation_id: cid,
    source_bot: raw.source_bot === "taona-bot" ? "taona-bot" : "dorje",
  };
}

export function signPeer(raw: string): string {
  return "sha256=" + crypto.createHmac("sha256", peerSecret()).update(raw).digest("hex");
}

// Fail-closed: no secret, no header, or mismatch => false. Timing-safe compare.
export function verifyPeer(raw: string, header: string | null): boolean {
  const secret = peerSecret();
  if (!secret || !header) return false;
  const expected = signPeer(raw);
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// POST a task update to the peer bot. Returns {ok, skipped?} — skipped=true when
// the bridge is off or unconfigured (an inert no-op, never an error). Never throws.
export async function sendTaskToPeer(payload: PeerTaskPayload): Promise<{ ok: boolean; skipped?: boolean; status?: number }> {
  if (!peerSyncEnabled()) return { ok: false, skipped: true };
  const url = peerUrl();
  if (!url || !peerSecret()) return { ok: false, skipped: true };
  const raw = JSON.stringify(payload);
  try {
    const res = await fetch(`${url}/api/peer/task-sync`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-peer-signature": signPeer(raw) },
      body: raw,
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false };
  }
}
