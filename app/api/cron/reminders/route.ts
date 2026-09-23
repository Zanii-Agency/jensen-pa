// Calendar-reminder cron. Scans events for ones whose Dubai time falls 4-6
// minutes ahead of now and pings Jensen via the chokepoint. Single-fire per
// event (reminded_at is the latch). Doctrine: Law 1 first-person Rencontre
// voice, Law 2 sendTextAndLog chokepoint, Law 5 no em-dashes.
//
// Runs every minute via vercel.json. The window is [4, 6] so a one-minute
// drift in cron firing time still catches the event. Skips events titled
// "Reminder: ..." (legacy sibling rows the bot used to create before this
// cron existed) so they do not double-fire alongside the parent event.

import { NextRequest, NextResponse } from "next/server";
import { sendTextAndLog, sendTemplateAndLog } from "@/lib/sendTextAndLog";
import { isInWindow } from "@/lib/whatsapp-window";
import { reminderPlan, REMINDER_TEMPLATE, REMINDER_TEMPLATE_LANG } from "@/lib/concierge/reminder-plan";
import { whoIs } from "@/lib/whatsapp";
import { dubaiToday } from "@/lib/time";
import { sbSelect, sbUpdateReturning, sbInsert, enc } from "@/lib/concierge/rest";
import { normalizeEventTitleKey } from "@/lib/concierge/ops";

export const runtime = "nodejs";
export const maxDuration = 30;

const LEAD_MIN = 5;
const WINDOW = 1;

function authed(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const hdr = req.headers.get("authorization") || "";
  const key = new URL(req.url).searchParams.get("key") || "";
  return hdr === `Bearer ${secret}` || key === secret;
}

function owners(): string[] {
  return (process.env.OWNER_WHATSAPP || "").split(",").map((n) => n.trim()).filter(Boolean);
}

function dubaiNowMinutes(): number {
  const s = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Dubai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
}

function parseHHMM(t: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(t || "");
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

async function handle(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const today = dubaiToday();
  const nowMin = dubaiNowMinutes();

  // outcome=is.null excludes events Jensen already concluded (complete_event stamps
  // outcome='happened'/'empty'/etc.) — without it the cron fires a reminder for a
  // meeting he already marked done, since completeEvent leaves reminded_at null
  // (FM-23 / the Memorae FM-09 bug reborn now that the reminder engine is live).
  const rows = await sbSelect<any>("events", `date=eq.${enc(today)}&reminded_at=is.null&outcome=is.null&order=time.asc`).catch(() => []);

  const due = rows.filter((ev: any) => {
    if (!ev?.time) return false;
    if (typeof ev.title === "string" && /^Reminder:/i.test(ev.title)) return false;
    const evMin = parseHHMM(ev.time);
    if (evMin == null) return false;
    const delta = evMin - nowMin;
    return delta >= LEAD_MIN - WINDOW && delta <= LEAD_MIN + WINDOW;
  });

  if (!due.length) return NextResponse.json({ ok: true, dubaiTime: today, nowMin, scanned: rows.length, fired: 0 });

  const to = owners().filter((n) => whoIs(n).role === "owner");
  if (!to.length) return NextResponse.json({ ok: false, reason: "no_owner_phone", fired: 0 });

  function nextRecurrence(curDate: string, recurrence: string): string | null {
    const d = new Date(curDate + "T12:00:00+04:00");
    if (recurrence === "weekly") d.setDate(d.getDate() + 7);
    else if (recurrence === "monthly") d.setMonth(d.getMonth() + 1);
    else if (recurrence === "yearly") d.setFullYear(d.getFullYear() + 1);
    else return null;
    return d.toISOString().slice(0, 10);
  }

  // Past 24h since his last message, free text is never delivered: use the
  // approved template (FM-21). Fails closed: if the window can't be read, template.
  const win = await isInWindow("jensen");

  const fired: any[] = [];
  for (const ev of due) {
    // Surface the meeting link AT reminder time (the thing he actually wanted).
    // It was saved on the event but the reminder never showed it (Sotiris, Jun 16).
    // Only the text path can carry it; the template invites him to reply for it.
    const plan = reminderPlan(ev, win);
    // CLAIM the reminder BEFORE sending. If we sent first and the reminded_at
    // latch then failed, the event would re-match reminded_at=is.null every tick
    // and spam the same reminder forever. At-most-once: only send after we have
    // successfully latched; if the latch fails, skip and retry next tick (no dup).
    // Guarded on reminded_at=is.null so two overlapping cron runs cannot both
    // claim (and both send) the same reminder.
    const latched = await sbUpdateReturning("events", `id=eq.${enc(ev.id)}&reminded_at=is.null`, { reminded_at: Date.now() })
      .then((rows) => rows.length === 1).catch(() => false);
    if (!latched) continue;
    let mode: string = plan.mode;
    for (const num of to) {
      if (plan.mode === "template") {
        const r = await sendTemplateAndLog(num, REMINDER_TEMPLATE, REMINDER_TEMPLATE_LANG, plan.params, plan.text, { force: true, party: "jensen" });
        if (r.ok) continue;
        // Refused while his window is closed: free text would be accepted and never
        // delivered, so none is sent (the chokepoint recorded it and paged the
        // developer). A wall drop still goes through sendTextAndLog so the drop is
        // logged and paged the usual way.
        if (!r.dropped && !win.open) { mode = "template-failed"; continue; }
        mode = r.dropped ? "template-dropped" : "template-failed-text";
      }
      await sendTextAndLog(num, plan.mode === "template" ? plan.fallbackText : plan.text, { force: true, party: "jensen" });
    }
    fired.push({ id: ev.id, title: ev.title, time: ev.time, mode, hoursSince: Number(win.hoursSince.toFixed(1)) });

    // Recurring: create the next occurrence if recurrence is set and not past until.
    if (ev.recurrence && ["weekly", "monthly", "yearly"].includes(ev.recurrence)) {
      const nextDate = nextRecurrence(ev.date, ev.recurrence);
      if (nextDate && (!ev.recurrence_until || nextDate <= ev.recurrence_until)) {
        const nextKey = normalizeEventTitleKey(ev.title);
        const collision = nextKey
          ? await sbSelect("events", `date=eq.${enc(nextDate)}&select=id&limit=1`).catch(() => [])
          : [];
        if (!collision?.length) {
          const nextRow = {
            id: Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4),
            title: ev.title, date: nextDate, time: ev.time,
            entity_id: ev.entity_id || null, note: ev.note || null,
            recurrence: ev.recurrence, recurrence_until: ev.recurrence_until || null,
            created_at: Date.now(),
          };
          await sbInsert("events", nextRow).catch(() => {});
        }
      }
    }
  }

  return NextResponse.json({ ok: true, dubaiTime: today, nowMin, scanned: rows.length, fired: fired.length, events: fired });
}

export async function GET(req: NextRequest) { return handle(req); }
export async function POST(req: NextRequest) { return handle(req); }
