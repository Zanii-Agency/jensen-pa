import { NextRequest, NextResponse } from "next/server";
import * as ops from "@/lib/concierge/ops";
import { sendWhatsApp, sendWhatsAppTemplate, whoIs } from "@/lib/whatsapp";
import { sendTextAndLog } from "@/lib/sendTextAndLog";
import { callOwner, twilioConfigured } from "@/lib/voice-call";
import { dubaiToday, dayPart } from "@/lib/time";
import { isInWindow } from "@/lib/whatsapp-window";
import { peekCount } from "@/lib/mail-pending";
import { admin, kvGet, kvSet } from "@/lib/db";
import { cleanForClient } from "@/lib/concierge/updated-list.mjs";

export const runtime = "nodejs";
export const maxDuration = 60;

// Per-run observability (KT #341). The daily brief kept NO record of itself:
// the off-window TEMPLATE branch never logged (only the in-window text path
// did, via sendTextAndLog), so a MISSED 8am was indistinguishable from a
// fired-but-template run. This writes one durable system/audit row on EVERY
// exit path (skip / sent / error) plus a date-keyed kv marker, so tomorrow's
// 8am is observable, not inferred — and the future self-heal can read the
// marker to answer "did today's brief go out?". STRICTLY fail-open: a bad
// audit write must NEVER block or break the real send.
async function auditDaily(content: string): Promise<void> {
  try {
    await admin().from("chat_messages").insert({
      role: "system", party: "system", channel: "audit",
      content: `daily_brief_run: ${content}`, ts: Date.now(),
    });
  } catch { /* fail-open: observability must never break delivery */ }
}
async function markBriefSent(today: string, sent: Record<string, any>): Promise<void> {
  try {
    await admin().from("kv").upsert(
      { key: `daily_brief:${today}`, value: { ran_at: Date.now(), sent } },
      { onConflict: "key" }
    );
  } catch { /* fail-open */ }
}

function owners(): string[] {
  return (process.env.OWNER_WHATSAPP || "").split(",").map((n) => n.trim()).filter(Boolean);
}
function authed(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // FAIL CLOSED: never run unauthenticated (this route sends real messages)
  const hdr = req.headers.get("authorization") || "";
  const key = new URL(req.url).searchParams.get("key") || "";
  return hdr === `Bearer ${secret}` || key === secret;
}

async function buildBrief(): Promise<{ text: string; q1: number; call: string; note: string }> {
  const today = dubaiToday();
  // Track read failure so a query error is never rendered to Jensen as a
  // confident "clean board" (that would be the is.not.null lie all over again).
  let readFailed = false;
  const onFail = () => { readFailed = true; return [] as any[]; };
  const [q1, q2, events] = await Promise.all([
    ops.listTasks({ quadrant: 1, done: false }).catch(onFail),
    ops.listTasks({ quadrant: 2, done: false }).catch(onFail),
    ops.queryCalendar({ from: today, to: today }).catch(onFail),
  ]);
  // Open warm, peer-counsel tone (matches Jensen's persona tree), then drop
  // into the board. Greeting first so the brief never reads sterile.
  const greeting = dayPart() === "morning"
    ? `Morning, Jensen. How's the head?`
    : `Good ${dayPart()}, Jensen.`;
  // One-time morning note (operator-set via the `morning_note` kv). Inserted right
  // after the greeting, then cleared by the caller after a successful send so it
  // fires EXACTLY once. Absent/empty kv => behaves exactly as before.
  const noteRaw = await kvGet<string>("morning_note", "").catch(() => "");
  const note = (typeof noteRaw === "string" ? noteRaw : "").trim();
  const lines: string[] = [greeting];
  if (note) lines.push("", note);
  lines.push("", `Here is your board for today.`);
  if (q1.length) {
    lines.push(`\n*Do first (${q1.length}):*`);
    // Surface staleness so a high-priority item can never rot silently the way
    // the two contracts sat untouched for 4 days in the Jun 15-19 window
    // (KT #329). A Q1 item open 2+ days gets an age tag so it nags by being
    // visible, not by a separate message.
    const nowMs = Date.now();
    q1.slice(0, 5).forEach((t: any) => {
      const created = Number(t.created_at) || 0;
      const days = created ? Math.floor((nowMs - created) / 86_400_000) : 0;
      lines.push(`• ${cleanForClient(t.title)}${days >= 2 ? ` (open ${days}d)` : ""}`);
    });
  } else if (readFailed) {
    lines.push(`\n*Do first:* I could not fully read your board just now. Open the portal or ask me again in a moment, I do not want to tell you it is clear if it is not.`);
  } else {
    lines.push(`\n*Do first:* nothing urgent. Clean board.`);
  }
  if (events.length) {
    lines.push(`\n*Today's schedule:*`);
    events.slice(0, 6).forEach((e: any) => lines.push(`• ${e.time ? e.time + " " : ""}${cleanForClient(e.title)}`));
  }
  if (q2.length) lines.push(`\n${q2.length} important item${q2.length > 1 ? "s" : ""} I'm protecting for you.`);
  lines.push(`\nReply here anytime and I'll handle it.`);
  const call =
    q1.length > 0
      ? `Hello, this is your A.I. concierge from La Rencontre. A quick reminder: you have ${q1.length} urgent item${q1.length > 1 ? "s" : ""} today, starting with ${q1[0].title}. The full brief is on WhatsApp. Have a great day.`
      : readFailed
      ? `Hello, this is your A.I. concierge from La Rencontre. I had trouble reading your board just now, please check WhatsApp. Have a great day.`
      : `Hello, this is your A.I. concierge from La Rencontre. Your board is clear today, nothing urgent. The full brief is on WhatsApp. Have a great day.`;
  return { text: lines.join("\n"), q1: q1.length, call, note };
}

export async function GET(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    // Stay silent until Jensen is switched on (past onboarding). No proactive
    // messages while he is still being set up.
    const prefs = await ops.getPrefs().catch(() => ({} as any));
    if (prefs?.onboarding !== false) {
      await auditDaily(`skip=onboarding (onboarding=${JSON.stringify(prefs?.onboarding)})`);
      return NextResponse.json({ ok: true, skipped: "onboarding" });
    }

    const brief = await buildBrief();
    // Dry run (auth-gated): return the exact rendered brief text WITHOUT sending
    // or clearing the one-time note. Lets the operator preview tomorrow's 8am
    // before it reaches Jensen. Read-only.
    if (new URL(req.url).searchParams.get("dryRun")) {
      return NextResponse.json({ ok: true, dryRun: true, preview: brief.text, note: brief.note });
    }
    // Brief goes to JENSEN only (the owner), never the admin/developer.
    const to = owners().filter((n) => whoIs(n).role === "owner");

    // 24-hour customer-service window split. Free-text inside the window lands
    // (the rich brief). Outside the window, free-text is silently dropped by
    // Meta — we MUST switch to a pre-approved utility template that nudges
    // Jensen to engage, so the rich brief flows on his reply turn. The full
    // text is still logged via the chokepoint regardless (the bot's memory
    // never lies about what it tried to say).
    // .trim() defends against Vercel's "env vars get a trailing newline" trap
    // that also bit JENSEN_MODE earlier this week. Without trim, the template
    // name "morning_brief_v1\n" never matches Meta's "morning_brief_v1".
    const tmplName = (process.env.MORNING_BRIEF_TEMPLATE || "").trim();
    const tmplLang = (process.env.MORNING_BRIEF_TEMPLATE_LANG || "en_US").trim();

    const sent: Record<string, any> = {};
    const pendingMail = await peekCount().catch(() => 0);
    for (const n of to) {
      const win = await isInWindow("jensen");
      if (win.open) {
        // sendTextAndLog (not raw sendWhatsApp) so the brief is LOGGED to
        // chat_messages like reminders + the evening check. Raw sendWhatsApp only
        // logs when the wall catches something, so the 8am brief was invisible to
        // the bot's own memory of the day (KT #334).
        const ok = await sendTextAndLog(n, brief.text, { party: "jensen" });
        sent[n] = { mode: "text", ok, hoursSince: Number(win.hoursSince.toFixed(1)) };
        // Clear the one-time note ONLY after it actually went out as text (the
        // template branch never carries it, so leave it set for the next in-window
        // brief). null unsets the kv key entirely (KT: one-time semantics).
        if (ok && brief.note) { await kvSet("morning_note", null).catch(() => {}); }
      } else if (tmplName && tmplName.length > 0) {
        // Template parameters: [q1 count, q2 count, today events count]. Must
        // match the body slots in the template Meta approved. Adjust template
        // body wording in WhatsApp Manager, not here.
        const today = dubaiToday();
        const [q1, q2, events] = await Promise.all([
          ops.listTasks({ quadrant: 1, done: false }).catch(() => []),
          ops.listTasks({ quadrant: 2, done: false }).catch(() => []),
          ops.queryCalendar({ from: today, to: today }).catch(() => []),
        ]);
        const wamid = await sendWhatsAppTemplate(n, tmplName, tmplLang, [
          String((q1 || []).length),
          String((q2 || []).length),
          String((events || []).length),
          String(pendingMail),
        ]);
        sent[n] = { mode: "template", template: tmplName, ok: !!wamid, hoursSinceLast: Number(win.hoursSince.toFixed(1)) };
      } else {
        // No template configured + window closed: skip rather than silently
        // fail. Operator sees this in the response payload and knows to submit
        // a Meta template (instructions in MEMORY.md project note).
        console.log(`[daily-brief] off-window (${win.hoursSince.toFixed(1)}h since last inbound) and MORNING_BRIEF_TEMPLATE not set — suppressing send to ${n.replace(/[^0-9]/g, "").slice(-4)}`);
        sent[n] = { mode: "skipped", reason: "off-window, no template configured", hoursSince: Number(win.hoursSince.toFixed(1)) };
      }
    }

    // Optional voice call to the primary owner (Jensen) when enabled + configured.
    let call: any = { attempted: false };
    if (process.env.CALL_REMINDERS === "on" && twilioConfigured() && to[0]) {
      const r = await callOwner(to[0], brief.call);
      call = { attempted: true, ...r };
    }

    // Observability + self-heal marker (fail-open, after the real send is done).
    const summary = Object.entries(sent).map(([n, s]: any) => `${n.replace(/[^0-9]/g, "").slice(-4)}=${s.mode}${s.ok === false ? "(send-failed)" : ""}`).join(",") || "no-recipients";
    await auditDaily(`${summary} q1=${brief.q1}`);
    await markBriefSent(dubaiToday(), sent);

    return NextResponse.json({ ok: true, q1: brief.q1, sent, call });
  } catch (e: any) {
    await auditDaily(`error=${(e?.message || String(e)).slice(0, 160)}`);
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
