// How a calendar reminder reaches him (FM-21, 2026-09-23).
//
// WhatsApp delivers free text only within 24 hours of his last message. After
// that Meta accepts the message, returns an id, and never delivers it. In the 60
// days to 23 Sep, 7 of 54 reminders went out after a quiet day (Prateek, Nas,
// Waren, two meetings with Taona) and most likely never arrived. The morning
// brief already switched to a template off-window; reminders never did.
//
// Pure, so the wall tests exactly what prod sends.
import { stripDashes } from "../whatsapp";

export const REMINDER_TEMPLATE = "event_reminder_v1"; // approved body: "Reminder. {{1}} at {{2}}. Reply here if you need anything for it."
export const REMINDER_TEMPLATE_LANG = "en_US";

// Half an hour short of 24h: a reminder sent at 23h59 as text can be past the
// window by the time Meta checks it.
const TEXT_SAFE_HOURS = 23.5;

// Meta rejects template parameters containing newlines, tabs or long runs of
// spaces, and the send primitive strips dashes (Law 5). Cleaning here, once, keeps
// the words logged, the words sent and the words the "done" match looks for the same.
const clean = (s: unknown) => stripDashes(String(s ?? "")).replace(/\s+/g, " ").trim();

// The title as every reminder shows it. pingedJustNow() matches his "done" reply
// against `Reminder. ${reminderTitle(title)} at`, so both sides use this.
export function reminderTitle(title: unknown): string {
  return clean(title) || "Your event";
}

type Plan =
  | { mode: "text"; text: string }
  | { mode: "template"; params: string[]; text: string; fallbackText: string };

export function reminderPlan(
  ev: { title?: unknown; time?: unknown; meeting_url?: string | null },
  win: { open: boolean; hoursSince: number } | undefined,
): Plan {
  const title = reminderTitle(ev.title);
  const time = clean(ev.time);
  const text = `Reminder. ${title} at ${time}.${ev.meeting_url ? `\nHere is your link to join: ${ev.meeting_url}` : ""}`;
  if (win?.open && win.hoursSince < TEXT_SAFE_HOURS) return { mode: "text", text };
  return {
    mode: "template",
    params: [title, time],
    // Exactly what he reads, so the transcript matches the wire.
    text: `Reminder. ${title} at ${time}. Reply here if you need anything for it.`,
    // Used only if Meta refuses the template while his window is still open.
    fallbackText: text,
  };
}
