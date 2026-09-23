// How a calendar reminder reaches him (FM-21, 2026-09-23).
//
// WhatsApp delivers free text only within 24 hours of his last message. After
// that Meta accepts the message, returns an id, and never delivers it. In the 60
// days to 23 Sep, 7 of 54 reminders went out after a quiet day (Prateek, Nas,
// Waren, two meetings with Taona) and most likely never arrived. The morning
// brief already switched to a template off-window; reminders never did.
//
// Pure, so the wall tests exactly what prod sends.

export const REMINDER_TEMPLATE = "event_reminder_v1"; // approved body: "Reminder. {{1}} at {{2}}. Reply here if you need anything for it."
export const REMINDER_TEMPLATE_LANG = "en_US";

// Half an hour short of 24h: a reminder sent at 23h59 as text can be past the
// window by the time Meta checks it.
const TEXT_SAFE_HOURS = 23.5;

// Meta rejects template parameters containing newlines, tabs or long runs of spaces.
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

export function reminderPlan(ev, win) {
  const text = `Reminder. ${ev.title} at ${ev.time}.${ev.meeting_url ? `\nHere is your link to join: ${ev.meeting_url}` : ""}`;
  if (win?.open && win.hoursSince < TEXT_SAFE_HOURS) return { mode: /** @type {const} */ ("text"), text };
  const title = oneLine(ev.title) || "Your event";
  const time = oneLine(ev.time);
  return {
    mode: /** @type {const} */ ("template"),
    params: [title, time],
    // Exactly what he reads, so the transcript matches the wire. It starts with
    // "Reminder. <title> at" so his "done" reply still finds this event.
    text: `Reminder. ${title} at ${time}. Reply here if you need anything for it.`,
    // If Meta refuses the template, the old text path is no worse than before.
    fallbackText: text,
  };
}
