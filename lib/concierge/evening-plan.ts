// How the evening check reaches him (FM-21 sibling, 2026-09-24).
//
// Same WhatsApp rule as reminders: free text is only delivered within 24h of his
// last message. His window is closed on about a quarter of days (27 gaps over
// 24h across 110 days of his history), and the evening check used to just SKIP
// on those days, so a quiet evening meant no evening check and no record that
// one was missed. The morning brief already switched to a template off-window;
// this copies that, including its wording shape.
//
// Wording note: the first submission ("{{1}} still open on your board ... Reply
// here to see the full check") was reclassified by Meta from UTILITY to
// MARKETING, and marketing templates may only go to people who opted in to
// marketing, which Jensen never did. evening_check_v2 uses the morning brief's
// already-approved body shape verbatim, only the greeting differs.
//
// Pure, so the wall tests exactly what prod sends.
export const EVENING_TEMPLATE = "evening_check_v2"; // approved body: "Evening check, Jensen. {{1}} on your board today, {{2}} I am protecting, {{3}} on schedule, {{4}} email proposals waiting. Reply here to see the full check."
export const EVENING_TEMPLATE_LANG = "en_US";

export type EveningCounts = { q1: number; q2: number; events: number; pendingMail: number };
type Win = { open: boolean; hoursSince: number } | undefined;

// Template parameters in the morning brief's phrasing. Meta rejects newlines.
export function eveningParams(c: EveningCounts): string[] {
  return [`${c.q1} items`, `${c.q2} items`, `${c.events} events`, `${c.pendingMail}`];
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
  | { mode: "template"; params: string[]; text: string }
  | { mode: "skip"; reason: string } {
  if (win?.open) return { mode: "text", text: brief };
  // Law 6: the counts came from a failed read, so they are not numbers he can be
  // shown. The in-window brief says so in words; a template can only state figures.
  if (readFailed) return { mode: "skip", reason: "off-window and the board could not be read" };
  const params = eveningParams(counts);
  return {
    mode: "template",
    params,
    text: `Evening check, Jensen. ${params[0]} on your board today, ${params[1]} I am protecting, ${params[2]} on schedule, ${params[3]} email proposals waiting. Reply here to see the full check.`,
  };
}
