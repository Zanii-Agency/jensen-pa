// Prevention, not detection. A false completion claim never ships.
// Deterministic first (cannot fail open). The LLM check is a secondary net only.
//
// Replaces the old verifyReply rail (fail-open, appended a contradicting note
// after a standing lie) and the `reply = "Done."` empty-reply fallback.
import { claudeJSON } from "../anthropic";
import { COMPLETION_TOOLS } from "./tools";

type ToolRun = { name: string; ok: boolean; result?: any };

// Verbs that assert a finished action.
const CLAIM =
  /\b(done|created|added|saved|recorded|logged|booked|scheduled|filed|sent|updated|deleted|set|drafted|posted|charged|refunded|cancelled)\b/i;
// Future or honest phrasings that are NOT claims of a finished action.
const NOT_A_CLAIM =
  /\b(will|going to|about to|can|could|shall I|should I|want me to|let me|i'?ll|once you|after you|draft(ed)? (it )?for you)\b/i;
// Sent-claim verbs, checked against send tools specifically.
const SENT_CLAIM = /\b(sent|messaged|emailed|notified|told|forwarded)\b/i;
// Tool names whose ok=true backs a "sent/emailed/notified" claim. Jensen has no
// generic "send" tool (his WhatsApp reply IS the message); the only outbound
// tools are reply_email (sends an email) and call_owner (places a call).
const SEND_TOOLS = new Set<string>(["reply_email", "call_owner", "send_task_to_peer"]);
// Tools that REPORT existing records (a day's activity, the morning brief). Their
// replies are full of historical completion language ("vendors saved", "meeting
// set") that describes the PAST, not a fresh action this turn. The claim-rewrite
// must never fire on a report, or it eats correct summaries.
const REPORT_TOOLS = new Set<string>(["day_log", "morning_brief"]);
// The user ASKED for a recap / summary / "what did X do". The answer is a report
// of the PAST whether or not the model remembered to call day_log, so its
// past-tense verbs ("saved", "set", "booked") are NOT fresh-action claims. Without
// this, a day summary answered from memory gets eaten into "I have not done that
// yet" (the June 20 over-fire, KT #334).
const READ_ASK =
  /\b(summari[sz]e|summary|recap|run.?down|catch me up|what (did|happened|came in|was on)|how (was|did) (the|his|your|my) day|walk me through (the|his|your|my) day)\b/i;

const okIn = (runs: ToolRun[], names: Set<string>) =>
  runs.some((r) => names.has(r.name) && r.ok);

// Is the reply backed by a real action this turn?
//
// A successful COMPLETION tool ALWAYS backs the reply: a genuine write happened,
// so the reply is not a lie even if it incidentally mentions a future "reminder"
// or uses a send-ish verb about it. Only a PURE sent-claim with no completion
// success falls back to requiring an actual send tool.
//
// Bug it fixes (2026-06-30, live to Jensen): "Saved your meeting with Taona and
// Margot... I have notified your reminder to include the link" got rewritten to
// "I have not done that yet" even though create_event had SUCCEEDED (event row
// existed). The word "notified" routed the check to SEND_TOOLS only, ignoring
// the backing create_event. A real success must never be called a failure.
// Fabrication while backed (e.g. claims an email that never sent) is still caught
// by the LLM secondary net in honestReply.
function isBacked(text: string, runs: ToolRun[]): boolean {
  if (okIn(runs, COMPLETION_TOOLS)) return true;
  if (SENT_CLAIM.test(text)) return okIn(runs, SEND_TOOLS);
  return false;
}

// A completion-class tool that RAN, failed, and carries a real message (a reason
// or a disambiguation question). That message is the honest, useful answer.
function failingToolMessage(runs: ToolRun[]): string | null {
  const t = [...runs]
    .reverse()
    .find(
      (r) =>
        COMPLETION_TOOLS.has(r.name) &&
        r.ok === false &&
        typeof r.result?.summary === "string" &&
        r.result.summary.trim(),
    );
  return t ? (t.result.summary as string).trim() : null;
}

function rewriteToHonest(runs: ToolRun[]): string {
  const msg = failingToolMessage(runs);
  if (msg) return msg; // e.g. "Two events match, which one?"
  return "I have not done that yet. Say the word and I will, or tell me the correction.";
}

/**
 * True iff honestReply would rewrite this to the BARE "I have not done that yet"
 * stub: a finished-action claim with NO backing tool success AND no useful
 * failing-tool message to surface instead. This is exactly Mode 1 of the
 * model-reliability gap (KT #206540): the model narrated a completed action but
 * called no tool, so nothing happened. The loop uses this to fire ONE forced-tool
 * self-repair round so the clear command actually executes. It deliberately
 * returns false when a tool DID run (Mode 2 — wrong specifics — is a different
 * fix) and when a failing tool already carries a useful disambiguation message.
 */
export function isUnbackedClaim(reply: string, runs: ToolRun[], userAsk = ""): boolean {
  const text = (reply || "").trim();
  if (!text) return false; // empty -> honest fallback, not the stub
  if (runs.some((r) => REPORT_TOOLS.has(r.name))) return false;
  if (READ_ASK.test(userAsk)) return false;
  if (!CLAIM.test(text) || NOT_A_CLAIM.test(text)) return false;
  if (isBacked(text, runs)) return false; // a real action backs it (Mode 2 handled elsewhere)
  if (failingToolMessage(runs)) return false; // a useful failure message exists; surface that
  return true;
}

/**
 * Returns the reply that should actually ship.
 * - Empty reply never becomes "Done." It becomes something true.
 * - A finished-action claim with no backing tool success is rewritten to the truth.
 * - We never append a contradicting note after a standing lie.
 */
export async function honestReply(reply: string, runs: ToolRun[], userAsk = ""): Promise<string> {
  const text = (reply || "").trim();
  if (!text)
    return "I do not have anything to confirm there. Tell me what you need and I will action it.";
  // A record report (day_log / morning_brief) is not a fresh-action claim. Its
  // historical completion language must never be rewritten. Ship it as-is.
  if (runs.some((r) => REPORT_TOOLS.has(r.name))) return text;
  // Same when the USER asked for a recap/summary: the reply describes the past,
  // so its past-tense verbs are not claims of a fresh action this turn (KT #334).
  if (READ_ASK.test(userAsk)) return text;
  if (!CLAIM.test(text) || NOT_A_CLAIM.test(text)) return text;

  if (!isBacked(text, runs)) return rewriteToHonest(runs); // definite fake, deterministic, cannot fail open

  // Backed claim. Secondary net for subtle mismatches the regex missed.
  // If this check itself errors, the backed claim stands (safe failure).
  try {
    const succeeded = runs
      .filter((r) => r.ok && COMPLETION_TOOLS.has(r.name))
      .map((r) => r.name);
    const out = await claudeJSON<{ fabricated: boolean; issue?: string }>(
      "You check an assistant reply against the write tools that actually succeeded this turn. " +
        "If the reply claims a completed WRITE that no listed tool supports, set fabricated=true. " +
        "Drafting or showing without claiming it was saved is fine. Return JSON {fabricated:boolean, issue?:string}.",
      `Successful write tools: ${succeeded.join(", ") || "(none)"}\n\nReply:\n${text}`,
      300,
    );
    if (out?.fabricated) return rewriteToHonest(runs);
  } catch {
    /* secondary net only */
  }
  return text;
}
