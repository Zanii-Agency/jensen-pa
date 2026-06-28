// Jensen mesh router (Phase 3 — de-monolith). Sasa's "router → specialist scoped
// to its own tools" pattern, tuned to Jensen and his "always delivers" guardrail.
//
// What it does NOT do (deliberate divergence from Sasa): it never hard-errors and
// never starves the model of a tool it needs. It scopes the toolset ONLY when one
// domain is the clear, unambiguous winner; on any doubt (no winner, a tie, or a
// multi-domain message) it returns `general` = the FULL toolset, i.e. exactly
// today's monolith behaviour. So the common single-intent turn (calendar/task/
// finance/email) sees ~12-18 tools instead of 62 (faster, more precise), and the
// ambiguous turn loses nothing. This is a keyword router (no model call → no added
// latency); a Haiku tie-breaker is a later upgrade, not needed for safety.

export type Domain = "calendar" | "tasks" | "docs" | "comms" | "money" | "general";

// Tools every specialist always gets — the "search before asking" trio + light
// lookups the model reaches for in any lane. Keeps a scoped lane from starving.
// Trimmed to the TRUE cross-lane core (audit: 13 was over-stuffing every lane).
// Each of these is genuinely reached for in any lane: resolve a person, recall a
// fact, check the calendar for truthful context, read settings, capture a standing
// instruction or a passing note (losing a "note that X" is data-loss, so add_note
// stays here on the never-worse rule). Everything else moved to the lane(s) that
// actually use it; `general` (full toolset) still exposes all of them on ambiguity.
const CROSS_CUTTING = [
  "find_contact", "query_memory", "query_calendar", "get_settings",
  "remember_preference", "add_note",
];

// Per-domain tool manifests (generous on purpose: a lane includes the adjacent
// tools its work naturally spills into, e.g. calendar can create a task).
const MANIFEST: Record<Exclude<Domain, "general">, string[]> = {
  calendar: [
    "day_log", "create_event", "update_event", "delete_event",
    "complete_event", "accept_meeting_tasks", "send_meeting_invite", "create_task",
    "add_contact", // invite/attach a new person to a meeting
  ],
  tasks: [
    "list_tasks", "create_task", "update_task", "complete_task", "delete_task",
    "accept_meeting_tasks", "morning_brief", "list_notes",
  ],
  docs: [
    "send_filed_document", "list_documents", "file_document", "delete_document",
    "generate_document", "generate_legal", "set_legal_blueprint",
    "sanad_draft_contract", "sanad_review_contract",
    "send_email", "draft_reply", // docs work routinely ends in "email this out"
    "search_documents", "find_entity", // docs is the home of doc search + entity tie
  ],
  comms: [
    "list_inbox", "read_email", "search_email", "reply_email", "draft_reply",
    "send_email", "send_meeting_invite", "call_owner",
    "add_contact", "search_documents", // email a new person; answer a mail about a doc
  ],
  money: [
    "finance_summary", "list_finance", "record_finance", "update_finance",
    "delete_finance", "vat_report", "ct_estimate",
    "send_email", "generate_document", "send_filed_document", // "send them the receipt/invoice"
    "find_entity", // tie finance to a client/venue
  ],
};

// Keyword signals per domain. Scored by count of distinct hits; a clear single
// winner (strictly highest, margin >= 1) routes, else general.
const SIGNALS: Record<Exclude<Domain, "general">, RegExp[]> = {
  // De-greeded (skeptic 5c): dropped the bare `event` (trapped finance questions
  // like "what did I spend on the Sohum event" in a toolless calendar lane) and
  // the bare `file` (over-fired docs). Specific phrases kept.
  calendar: [/\bmeeting|meet\b|calendar|schedule|reschedul|appointment|reminder|remind me|invite|zoom|teams\b/i, /\b(\d{1,2}\s?(am|pm)|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i, /\bmove (it|the|my)\b/i],
  tasks: [/\btask|to-?do|checklist|priority|urgent|follow up|follow-up\b/i, /\b(q1|q2|q3|q4|quadrant)\b/i, /\b(mark|it'?s)\s+done\b/i, /\bmy list\b/i],
  docs: [/\bdocument|contract|passport|emirates id|visa|pdf|attach|invoice template|sanad|legal|blueprint\b/i, /\bsend me (the|my)\b/i, /\bgenerate (a|the)\b/i],
  comms: [/\bemail|inbox|reply|e-mail|mailbox|forward\b/i, /\bdraft (a|an|the)? ?(reply|email|mail)\b/i],
  money: [/\binvoice|payment|paid|finance|expense|revenue|profit|salary|payroll|spend|spent|cost|budget\b/i, /\b(vat|tax|ct|corporate tax|aed)\b/i],
};

export type RouteResult = { domain: Domain; confidence: number; reason: string };

// Decide the domain for a message. Pure + deterministic (testable, no I/O).
export function routeDomain(text: string): RouteResult {
  const t = String(text || "");
  const scores = (Object.keys(SIGNALS) as Exclude<Domain, "general">[]).map((d) => ({
    d,
    score: SIGNALS[d].reduce((n, re) => n + (re.test(t) ? 1 : 0), 0),
  }));
  // Scope ONLY when EXACTLY ONE domain fires at all. If two domains both fire
  // (e.g. "move my meeting AND email Khalid"), it is multi-domain -> general
  // (full toolset), because a scoped lane would starve the other intent and the
  // bot would fail to deliver. Conservative until DECOMPOSE (Phase 3b) lands.
  const firing = scores.filter((s) => s.score >= 1).sort((a, b) => b.score - a.score);
  if (firing.length === 1) {
    return { domain: firing[0].d, confidence: firing[0].score, reason: `${firing[0].d}:${firing[0].score} (sole domain)` };
  }
  return { domain: "general", confidence: 0, reason: firing.length === 0 ? "no domain signal" : `multi-domain (${firing.map((f) => f.d).join("+")}) -> full toolset` };
}

// Scope a base toolset to the routed domain. general -> unchanged (full set, the
// graceful fallback). A scoped domain -> its manifest ∩ base, plus cross-cutting,
// intersected with what actually exists in the base (never invents a tool).
export function scopeToolNames(domain: Domain, baseNames: string[]): string[] {
  if (domain === "general") return baseNames;
  const allow = new Set([...(MANIFEST[domain] || []), ...CROSS_CUTTING]);
  const scoped = baseNames.filter((n) => allow.has(n));
  // Safety net: if scoping somehow emptied the set, fall back to the full set
  // rather than hand the model zero tools (never starve -> always delivers).
  return scoped.length ? scoped : baseNames;
}

// A short focus line for the system prompt so the specialist knows its lane,
// without being told it is "restricted" (the model still understands freely).
export function focusBlock(domain: Domain): string {
  if (domain === "general") return "";
  const job: Record<Exclude<Domain, "general">, string> = {
    calendar: "scheduling, events, meetings and reminders",
    tasks: "tasks and the priority list",
    docs: "documents, files and contracts",
    comms: "email and outbound messages",
    money: "finance, invoices, VAT and tax",
  };
  return `FOCUS THIS TURN: ${job[domain]}. Use your tools for this. If the request clearly belongs to another area, just handle it directly and briefly, never say you are limited.`;
}
