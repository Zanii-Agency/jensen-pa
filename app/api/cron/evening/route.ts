import { NextRequest, NextResponse } from "next/server";
import * as ops from "@/lib/concierge/ops";
import { sendTextAndLog, sendTemplateAndLog } from "@/lib/sendTextAndLog";
import { eveningPlan, EVENING_TEMPLATE, EVENING_TEMPLATE_LANG } from "@/lib/concierge/evening-plan";
import { whoIs } from "@/lib/whatsapp";
import { dubaiToday } from "@/lib/time";
import { isInWindow } from "@/lib/whatsapp-window";
import { peekCount } from "@/lib/mail-pending";

export const runtime = "nodejs";
export const maxDuration = 60;

function owners(): string[] {
  return (process.env.OWNER_WHATSAPP || "").split(",").map((n) => n.trim()).filter(Boolean);
}

function authed(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const hdr = req.headers.get("authorization") || "";
  const key = new URL(req.url).searchParams.get("key") || "";
  return hdr === `Bearer ${secret}` || key === secret;
}

async function buildBrief(): Promise<{ text: string; counts: { q1: number; q2: number; events: number; pendingMail: number }; readFailed: boolean }> {
  const today = dubaiToday();
  let readFailed = false;
  const onFail = () => { readFailed = true; return [] as any[]; };
  const [q1, q2, events, fin] = await Promise.all([
    ops.listTasks({ quadrant: 1, done: false }).catch(onFail),
    ops.listTasks({ quadrant: 2, done: false }).catch(onFail),
    ops.queryCalendar({ from: today, to: today }).catch(onFail),
    ops.listFinance({}).catch(() => []),
  ]);
  const totalQ1 = q1.length;
  const totalQ2 = q2.length;
  const todaysEvents = events.length;
  const pendingMail = await peekCount().catch(() => 0);
  const finNet = (fin as any[]).filter((r) => r.kind === "income").reduce((s, r) => s + Number(r.amount), 0)
    - (fin as any[]).filter((r) => r.kind === "expense").reduce((s, r) => s + Number(r.amount), 0);

  const lines: string[] = [`Evening check, Jensen. Here is how your board sits.`];
  if (totalQ1) lines.push(`\nYou have ${totalQ1} Q1 item${totalQ1 > 1 ? "s" : ""} still open.`);
  else if (readFailed) lines.push(`\nI could not fully read your board just now, so I will not tell you it is clear. Check the portal or ask me again.`);
  else lines.push(`\nQ1 is clear.`);
  if (totalQ2) lines.push(`${totalQ2} Q2 item${totalQ2 > 1 ? "s" : ""} protected.`);
  if (todaysEvents) {
    const upcoming = (events as any[]).filter((e: any) => e.status !== "past");
    if (upcoming.length) lines.push(`${upcoming.length} event${upcoming.length > 1 ? "s" : ""} still ahead today.`);
  }
  if (pendingMail) lines.push(`${pendingMail} email${pendingMail > 1 ? "s" : ""} waiting for your reply.`);
  lines.push(`\nReply here anytime if you need me.`);
  return { text: lines.join("\n"), counts: { q1: totalQ1, q2: totalQ2, events: todaysEvents, pendingMail }, readFailed };
}

export async function GET(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const prefs = await ops.getPrefs().catch(() => ({} as any));
    if (prefs?.onboarding !== false) return NextResponse.json({ ok: true, skipped: "onboarding" });

    const built = await buildBrief();
    const to = owners().filter((n) => whoIs(n).role === "owner");
    const sent: Record<string, any> = {};

    for (const n of to) {
      const win = await isInWindow("jensen");
      const plan = eveningPlan(built.text, built.counts, win, built.readFailed);
      if (plan.mode === "skip") {
        // Recorded, not silent: an evening that never reached him must be visible.
        sent[n] = { mode: "skipped", reason: plan.reason };
      } else if (plan.mode === "text") {
        sent[n] = { mode: "text", ok: !!(await sendTextAndLog(n, plan.text, { party: "jensen" })) };
      } else {
        const r = await sendTemplateAndLog(n, EVENING_TEMPLATE, EVENING_TEMPLATE_LANG, plan.params, plan.text, { party: "jensen" });
        // A refused template off-window sends NO free text: Meta would accept it and
        // never deliver it (FM-21). sendTemplateAndLog logged it and paged the dev.
        sent[n] = { mode: "template", ok: r.ok, dropped: !!r.dropped };
      }
    }

    return NextResponse.json({ ok: true, sent });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
