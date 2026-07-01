// Inbound peer task-sync (ADR-0015). Fail-closed HMAC. Receives status-backs from
// Taona-bot for tasks Jensen sent over (matched by correlation_id = the local task
// id), updates Jensen's board, and tells Jensen on WhatsApp. Default-OFF: when the
// bridge is off this endpoint 404-equivalents (200 {ok:false, skipped}) so it is
// inert. Separate from the WhatsApp/isOwner path entirely (that path is fail-open).
import { NextRequest, NextResponse } from "next/server";
import { peerSyncEnabled, verifyPeer, sanitizeInbound } from "@/lib/peer-sync";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!peerSyncEnabled()) return NextResponse.json({ ok: false, skipped: true });
  const raw = await req.text();
  if (!verifyPeer(raw, req.headers.get("x-peer-signature"))) {
    return NextResponse.json({ ok: false, error: "bad signature" }, { status: 401 });
  }
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 }); }
  const p = sanitizeInbound(parsed);
  if (!p) return NextResponse.json({ ok: false, error: "no correlation_id" }, { status: 400 });

  try {
    const ops = await import("@/lib/concierge/ops");
    // correlation_id is the Jensen-side task id. Only status-backs are honored on
    // this side (Taona completing a task Jensen delegated). We never create new
    // Jensen tasks from the peer — the peer cannot inject arbitrary board items.
    const rows = await ops.listTasks({}).catch(() => [] as any[]);
    const mine = (rows as any[]).find((r) => r.id === p.correlation_id);
    if (!mine) return NextResponse.json({ ok: true, note: "no matching task" });
    if (p.status === "done" && !mine.done) {
      await ops.updateTask({ id: mine.id, done: true });
      try {
        const { sendTextAndLog } = await import("@/lib/sendTextAndLog");
        const { ownerNumber } = await import("@/lib/whatsapp");
        const to = ownerNumber();
        if (to) await sendTextAndLog(to, `Taona marked this done: ${mine.title}`, { party: "jensen" });
      } catch { /* notification best-effort, never fail the sync */ }
    }
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e).slice(0, 160) }, { status: 500 });
  }
}
