// How the evening check reaches him (FM-21 sibling, 2026-09-24).
//
// Same WhatsApp rule as reminders: free text is only delivered within 24h of his
// last message. His window is closed on about a quarter of days (27 gaps over
// 24h across 110 days of his history), and the evening check used to just SKIP
// on those days, so a quiet evening meant no evening check and no record that
// one was missed. The morning brief already switched to a template off-window;
// this copies that, including its wording shape and its observability.
//
// Wording note: two earlier submissions were reclassified by Meta from UTILITY to
// MARKETING, and marketing templates may only go to people who opted in to
// marketing, which Jensen never did. evening_check_v2 used the morning brief's
// approved body verbatim and STILL came back MARKETING. evening_check_v3 drops the
// "Reply here to see the full check" call to action, which is the only part that
// reads as soliciting engagement rather than reporting his own status. A template
// whose category is not UTILITY must never be sent to him.
//
// Pure, so the wall tests exactly what prod sends.
export const EVENING_TEMPLATE_DEFAULT = "evening_check_v3"; // approved body: "Evening check, Jensen. {{1}} on your board today, {{2}} I am protecting, {{3}} on schedule, {{4}} email proposals waiting."
export const EVENING_TEMPLATE_LANG = "en_US";

// The name lives in env so a Meta rename never needs a deploy (the morning brief
// does the same). Empty means "not configured", which the route treats as a skip.
export function eveningTemplateName(env: Record<string, string | undefined> = process.env): string {
  return (env?.EVENING_CHECK_TEMPLATE ?? EVENING_TEMPLATE_DEFAULT).trim();
}

// Half an hour short of 24h, as in reminder-plan.ts: text sent at 23h59 can be
// past the window by the time Meta checks it.
const TEXT_SAFE_HOURS = 23.5;

export type EveningCounts = { q1: number; q2: number; upcoming: number; pendingMail: number };
type Win = { open: boolean; hoursSince: number } | undefined;

// Template parameters in the morning brief's phrasing (Meta's own approved
// example is "3 items", "2 items", "1 event", "4"). Meta rejects newlines.
export function eveningParams(c: EveningCounts): string[] {
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  return [plural(c.q1, "item"), plural(c.q2, "item"), plural(c.upcoming, "event"), `${c.pendingMail}`];
}

// The template body with its parameters filled in, i.e. exactly what he reads.
// Built from the params so the logged words cannot drift from the sent ones.
export function eveningTemplateText(params: string[]): string {
  return `Evening check, Jensen. ${params[0]} on your board today, ${params[1]} I am protecting, ${params[2]} on schedule, ${params[3]} email proposals waiting.`;
}

// `text` (in-window) is the full brief built by the caller. Off-window the template
// is a nudge: the full check flows on his reply, as the morning brief does.
export function eveningPlan(
  brief: string,
  counts: EveningCounts,
  win: Win,
  readFailed = false,
):
  | { mode: "text"; text: string }
  | { mode: "template"; params: string[]; text: string; fallbackText: string }
  | { mode: "skip"; reason: string } {
  if (win?.open && win.hoursSince < TEXT_SAFE_HOURS) return { mode: "text", text: brief };
  // Law 6: the counts came from a failed read, so they are not numbers he can be
  // shown. The in-window brief says so in words; a template can only state figures.
  if (readFailed) return { mode: "skip", reason: "off-window and the board could not be read" };
  const params = eveningParams(counts);
  return {
    mode: "template",
    params,
    text: eveningTemplateText(params),
    // Only used when the send wall kills the template: sendTextAndLog then logs
    // the catch and pages the developer, which is the point of the fallback.
    fallbackText: brief,
  };
}
