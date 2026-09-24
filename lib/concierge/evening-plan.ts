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
// "Reply here to see the full check" call to action, the only part that reads as
// soliciting engagement rather than reporting his own status.
//
// FAIL CLOSED ON PURPOSE: the template name comes ONLY from the
// EVENING_CHECK_TEMPLATE env var, currently "evening_check_v3" on Vercel. There is
// deliberately no code default. An approved MARKETING template delivers perfectly
// well, so a default here would silently defeat the rule above the moment the env
// var is wiped, which is a documented repeat failure mode in this fleet. Unset
// means the evening check records a skip.
//
// Pure, so the wall tests exactly what prod sends.
// STATUS 2026-09-24: NO template is configured, on purpose. Meta classified all
// three submitted wordings as MARKETING, not UTILITY, including one with no call
// to action, and an approved template's category cannot be changed. Marketing
// templates may only reach people who opted in to marketing, which Jensen never
// did, so sending one would risk his business account. The template path below is
// therefore INERT until someone submits a wording Meta accepts as UTILITY and sets
// EVENING_CHECK_TEMPLATE. Until then a quiet evening records a visible skip, which
// is still better than the silent vanish this replaced.
//
// The last attempted body, kept so the next attempt starts from it rather than
// from zero. seam.114 rebuilds it from eveningTemplateText and compares the two
// strings, so neither side can drift. KEEP THIS ON ONE LINE: the seam reads it as
// a single string.
// approved body: "Evening check, Jensen. {{1}} on your board today, {{2}} I am protecting, {{3}} on schedule, {{4}} email proposals waiting."
export const EVENING_TEMPLATE_LANG = "en_US";

// The name lives ONLY in env (as MORNING_BRIEF_TEMPLATE does), so a Meta rename
// never needs a deploy AND a missing variable disables the template instead of
// sending one whose category nobody has checked.
export function eveningTemplateName(env: Record<string, string | undefined> = process.env): string {
  return (env?.EVENING_CHECK_TEMPLATE ?? "").trim();
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
