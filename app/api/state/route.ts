import { NextRequest, NextResponse } from "next/server";
import { assembleState, replaceState, isConfigured } from "@/lib/db";
import type { DB } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 30;

// GET  -> full small-state snapshot (entities/tasks/finance/events/notes/contacts/prefs/goals/chat/...)
// POST -> replace that snapshot (portal save). Docs are a separate resource (/api/docs).
//         (POST not PUT: Vercel's edge 405s PUT on this project; POST is universal.)
export async function GET() {
  if (!isConfigured()) return NextResponse.json({ error: "server state not configured" }, { status: 503 });
  try {
    return NextResponse.json(await assembleState());
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!isConfigured()) return NextResponse.json({ error: "server state not configured" }, { status: 503 });
  try {
    const db = (await req.json()) as DB;
    if (!db || !Array.isArray(db.tasks)) return NextResponse.json({ error: "invalid state" }, { status: 400 });
    await replaceState(db);
    import("@/lib/zanii").then(({ recordAction }) => recordAction("state.replace", { tasks: Array.isArray(db.tasks) ? db.tasks.length : 0, via: "portal" })).catch(() => {});
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
