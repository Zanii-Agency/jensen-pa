import { NextRequest, NextResponse } from "next/server";
import * as ops from "@/lib/concierge/ops";
import { sendTextAndLog, sendTemplateAndLog } from "@/lib/sendTextAndLog";
import { eveningPlan, eveningTemplateName, EVENING_TEMPLATE_LANG } from "@/lib/concierge/evening-plan";
import { whoIs } from "@/lib/whatsapp";
import { dubaiToday } from "@/lib/time";
import { isInWindow } from "@/lib/whatsapp-window";
import { peekCount } from "@/lib/mail-pending";
import { admin, kvGet, kvSet } from "@/lib/db";

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

// Per-run observability, the morning brief's pattern (KT #341). The evening check
// used to leave NO record of itself: a skipped evening was indistinguishable from
// one that never ran. One durable audit row on every exit path, plus a date-keyed
// kv marker so a re-run cannot send a second billed template.
async function auditEvening(content: string): Promise<void> {
  try {
    await admin().from("chat_messages").insert({
      role: "system", party: "system", channel: "audit",
      content: `evening_check_run: ${content}`, ts: Date.now(),
    });
  } catch { /* fail-open: observability must never break delivery */ }
}

async function eveningAlreadySent(today: string): Promise<boolean> {
  try {
    const v: any = await kvGet(`evening_check:${today}`, null);
    return !!(v && v.sent);
  } catch { return false; }
}

async function markEveningSent(today: string, sent: Record<string, any>): Promise<void> {
  try {
    await kvSet(`evening_check:${today}`, { ran_at: Date.now(), sent });
  } catch { /* fail-open */ }
}

async function buildBrief(): Promise<{ text: string; counts: { q1: number; q2: number; upcoming: number; pendingMail: number }; readFailed: boolean }> {
  const today = dubaiToday();
  let readFailed = false;
  const onFail = () => { readFailed = true; return [] as any[]; };
  const [q1, q2, events] = await Promise.all([
    ops.listTasks({ quadrant: 1, done: false }).catch(onFail),
    ops.listTasks({ quadrant: 2, done: false }).catch(onFail),
    ops.queryCalendar({ from: today, to: today }).catch(onFail),
  ]);
  const totalQ1 = q1.length;
  const totalQ2 = q2.length;
  // The brief says "still ahead today", so the template must carry that same number
  // rather than every event on the date including ones already past (Law 6).
  const upcoming = (events as any[]).filter((e: any) => e.status !== "past").length;
  // A failed mail read must not become a confident "0 email proposals waiting".
  let pendingMailFailed = false;
  const pendingMail = await peekCount().catch(() => { pendingMailFailed = true; return 0; });

  const lines: string[] = [`Evening check, Jensen. Here is how your board sits.`];
  if (totalQ1) lines.push(`\nYou have ${totalQ1} Q1 item${totalQ1 > 1 ? "s" : ""} still open.`);
  else if (readFailed) lines.push(`\nI could not fully read your board just now, so I will not tell you it is clear. Check the portal or ask me again.`);
  else lines.push(`\nQ1 is clear.`);
  if (totalQ2) lines.push(`${totalQ2} Q2 item${totalQ2 > 1 ? "s" : ""} protected.`);
  if (upcoming) lines.push(`${upcoming} event${upcoming > 1 ? "s" : ""} still ahead today.`);
  if (pendingMail) lines.push(`${pendingMail} email${pendingMail > 1 ? "s" : ""} waiting for your reply.`);
  lines.push(`\nReply here anytime if you need me.`);
  return {
    text: lines.join("\n"),
    counts: { q1: totalQ1, q2: totalQ2, upcoming, pendingMail },
    readFailed: readFailed || pendingMailFailed,
  };
}

export async function GET(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const today = dubaiToday();
  try {
    const prefs = await ops.getPrefs().catch(() => ({} as any));
    if (prefs?.onboarding !== false) {
      await auditEvening("skip=onboarding");
      return NextResponse.json({ ok: true, skipped: "onboarding" });
    }

    // At most one evening check per day: a manual re-run or a post-send 500 retry
    // would otherwise send a second identical billed utility template.
    if (await eveningAlreadySent(today)) {
      await auditEvening("skip=already-sent-today");
      return NextResponse.json({ ok: true, skipped: "already-sent" });
    }

    const templateName = eveningTemplateName();
    if (!templateName) {
      await auditEvening("skip=no-template-configured (EVENING_CHECK_TEMPLATE empty)");
      return NextResponse.json({ ok: true, skipped: "no-template" });
    }

    const built = await buildBrief();
    const to = owners().filter((n) => whoIs(n).role === "owner");
    const sent: Record<string, any> = {};
    let anyDelivered = false;

    for (const n of to) {
      const win = await isInWindow("jensen");
      const plan = eveningPlan(built.text, built.counts, win, built.readFailed);
      if (plan.mode === "skip") {
        // Visible, not silent: auditEvening below records the reason.
        sent[n] = { mode: "skipped", reason: plan.reason };
      } else if (plan.mode === "text") {
        const ok = !!(await sendTextAndLog(n, plan.text, { party: "jensen" })).ok;
        sent[n] = { mode: "text", ok };
        anyDelivered = anyDelivered || ok;
      } else {
        const r = await sendTemplateAndLog(n, templateName, EVENING_TEMPLATE_LANG, plan.params, plan.text, { party: "jensen" });
        if (r.ok) {
          sent[n] = { mode: "template", ok: true };
          anyDelivered = true;
        } else if (r.dropped) {
          // The wall killed the template text before anything was sent or logged.
          // Route the free-text brief through the chokepoint so the catch is logged
          // and the developer paged. Off-window he will not receive it; the page is
          // the point.
          const fallbackOk = !!(await sendTextAndLog(n, plan.fallbackText, { party: "jensen" })).ok;
          sent[n] = { mode: "template-dropped", fallbackOk };
        } else {
          // Meta refused the template. sendTemplateAndLog wrote a delivery_failed
          // audit row and paged the developer. No free text: off-window Meta would
          // accept it and never deliver it (FM-21).
          sent[n] = { mode: "template-failed", ok: false };
        }
      }
    }

    const summary = Object.entries(sent).map(([n, v]) => `${n.slice(-2)}:${(v as any).mode}`).join(" ");
    await auditEvening(`${summary} q1=${built.counts.q1} upcoming=${built.counts.upcoming} readFailed=${built.readFailed}`);
    if (anyDelivered) await markEveningSent(today, sent);

    return NextResponse.json({ ok: true, sent });
  } catch (e: any) {
    await auditEvening(`error=${(e?.message || String(e)).slice(0, 160)}`);
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
