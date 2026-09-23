import { NextRequest, NextResponse } from "next/server";
import { sbSelect } from "@/lib/concierge/rest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// How many client-facing replies did the send wall kill recently? (FM-43)
//
// An external monitor needs this number every few minutes. It replaces the
// `wall_drops` database view from PR #7, which needed DDL on Jensen's Supabase
// that nobody operating this bot can run. Same guarantee, no schema change:
// the COUNT and the guard names leave this app, the message bodies never do.
//
// Auth is a dedicated read-only token, deliberately NOT CRON_SECRET: the cron
// secret can trigger jobs that message Jensen, and a monitor must never hold a
// credential that can send. Fails closed: no token configured -> 503.
export async function GET(req: NextRequest) {
  const token = process.env.HEALTH_READ_TOKEN;
  if (!token) return NextResponse.json({ error: "HEALTH_READ_TOKEN not configured" }, { status: 503 });
  if (req.headers.get("authorization") !== `Bearer ${token}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const minutes = Math.min(Math.max(Number(req.nextUrl.searchParams.get("minutes")) || 60, 1), 1440);
  const since = Date.now() - minutes * 60_000;
  try {
    const rows = await sbSelect<{ content: string }>(
      "chat_messages",
      `select=content&channel=eq.audit&content=like.pre_send_caught*&ts=gte.${since}&limit=500`,
    );
    const guards: Record<string, number> = {};
    for (const r of rows) {
      // "pre_send_caught[...]: forbidden_brand:zanii | <body>" -> "forbidden_brand:zanii".
      // Only this label is kept; the body after the pipe is discarded right here.
      const g = /pre_send_caught[^:]*:\s*([a-z_]+:[A-Za-z_]+)/.exec(r.content)?.[1] ?? "unknown";
      guards[g] = (guards[g] ?? 0) + 1;
    }
    return NextResponse.json({ ok: true, minutes, count: rows.length, guards });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e).slice(0, 200) }, { status: 500 });
  }
}
