// ChatGPT custom-GPT connector (Phase 4) — Sasa's "one tool layer, extra door"
// pattern, for ChatGPT instead of claude.ai. v1 is READ-ONLY by design: it exposes
// Jensen's board / calendar / recall to a desk surface, and CANNOT mutate, delete,
// or send anything. So the new door can never make the bot worse — the worst case
// is a read. Writes/sends come later, behind the same owner-confirm gate as WhatsApp.
//
// Auth: a single static bearer (CONNECTOR_TOKEN), single-tenant. The owner pastes
// it into the custom GPT. Timing-safe compare; fail-closed if the token is unset.
// The OpenAPI schema (op = "openapi") is public so ChatGPT can import it.

import { NextRequest, NextResponse } from "next/server";
import * as ops from "@/lib/concierge/ops";
import { bearerOk } from "@/lib/connector-auth";
// v1 is READS over board + calendar only. The `recall` op was cut before ship:
// facts carry no sensitivity tag, so a recall surface would leak finance/PII to a
// third party (Law 3). It returns in v2 once recall takes a sensitivity-filtered
// `safe` path. zanii-codef: cut-not-deferred-silently — the gap is intentional.

export const runtime = "nodejs";

function dubaiToday(): string {
  return new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10);
}

function authed(req: NextRequest): boolean {
  return bearerOk(req.headers.get("authorization"), process.env.CONNECTOR_TOKEN);
}

const QUADRANT = (q: number) =>
  ({ 1: "urgent+important", 2: "important", 3: "urgent", 4: "neither" } as Record<number, string>)[q] || "unsorted";

export async function GET(req: NextRequest, { params }: { params: { op: string } }) {
  const op = params.op;

  if (op === "openapi") return NextResponse.json(openapi(req));

  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    if (op === "board") {
      const today = dubaiToday();
      const [tasks, events] = await Promise.all([
        ops.listTasks({ done: false }).catch(() => [] as any[]),
        ops.queryCalendar({ from: today }).catch(() => [] as any[]),
      ]);
      return NextResponse.json({
        today,
        tasks: (tasks as any[]).map((t) => ({ id: t.id, title: t.title, quadrant: QUADRANT(t.quadrant) })),
        // hasMeetingLink not the raw url (MED #3): join links are bearer-capability
        // URLs; the owner has them already, ChatGPT logs should never hold them.
        upcoming: (events as any[]).map((e) => ({ id: e.id, title: e.title, date: e.date, time: e.time, hasMeetingLink: !!e.meeting_url })),
      });
    }
    if (op === "calendar") {
      const from = req.nextUrl.searchParams.get("from") || dubaiToday();
      const to = req.nextUrl.searchParams.get("to") || undefined;
      const events = await ops.queryCalendar({ from, to }).catch(() => [] as any[]);
      return NextResponse.json({ from, to: to || null, events: (events as any[]).map((e) => ({ id: e.id, title: e.title, date: e.date, time: e.time, status: e.status, hasMeetingLink: !!e.meeting_url })) });
    }
    return NextResponse.json({ error: `unknown op '${op}'` }, { status: 404 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}

// OpenAPI 3.1 the owner imports into a ChatGPT custom GPT. Read-only operations.
function openapi(req: NextRequest) {
  const base = `${req.nextUrl.protocol}//${req.nextUrl.host}`;
  return {
    openapi: "3.1.0",
    info: { title: "Jensen Concierge (read-only)", version: "1.0.0", description: "Read Jensen / La Rencontre's priority board, calendar, and knowledge. Read-only." },
    servers: [{ url: base }],
    paths: {
      "/api/actions/board": { get: { operationId: "getBoard", summary: "Get the current task board (Covey quadrants) and upcoming calendar.", responses: { "200": { description: "Board" } } } },
      "/api/actions/calendar": { get: { operationId: "getCalendar", summary: "List calendar events.", parameters: [{ name: "from", in: "query", schema: { type: "string" }, description: "YYYY-MM-DD start (default today)" }, { name: "to", in: "query", schema: { type: "string" }, description: "YYYY-MM-DD end" }], responses: { "200": { description: "Events" } } } },
    },
    components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
    security: [{ bearer: [] }],
  };
}
