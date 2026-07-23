// Deterministic "updated list" command (KT node #206540: a deterministic ROUTE
// for the action, not the LLM re-deciding the format every turn). The operator
// stated the contract verbatim on 2026-06-26: "when I say 'updated list' give me
// quadrants plus all upcoming reminders." Before this, the free-form brain led
// with "Today's Calendar", truncated the quadrants, and showed today-only
// reminders, forcing him to correct it three times in one thread.
//
// Pure + clock-free on purpose (agent-clock pattern): the caller passes tasks,
// events, and the Dubai `today`, so the SAME logic the bot runs is the logic the
// wall test exercises. Zero drift between proof and production.

const Q_LABELS = {
  1: "Q1 - Urgent + Important",
  2: "Q2 - Important, Not Urgent",
  3: "Q3 - Urgent, Not Important",
  4: "Q4 - Drop",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Client-boundary sanitizer for DB-derived strings (task/event titles) rendered
// into a luxury WhatsApp surface. Raw table content bypasses the model's persona
// governance, so a task title carrying an emoji, an arrow, or an em-dash reaches
// Jensen verbatim. On 2026-07-22 a dev task ("Evaluate Agent-Reach … 56.8k⭐ …
// MIT) — CLI … remote shell → sandbox …") rendered on his board. This is the wall
// that enforces Law 1 (no emoji), Law 4 (no non-luxury symbols) and Law 5 (no
// em/en dashes) at the one seam where table data becomes client copy.
export function cleanForClient(s) {
  return String(s == null ? "" : s)
    // emoji, pictographs, dingbats, arrows, misc symbols, variation selectors, ZWJ
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2900}-\u{29FF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{FE00}-\u{FE0F}\u{200D}]/gu, "")
    // em / en / horizontal-bar dash used as a break -> comma (Law 5)
    .replace(/[ \t]*[—–―][ \t]*/g, ", ")
    // tidy the whitespace/punctuation left behind by the removals. HORIZONTAL
    // whitespace only (spaces/tabs), never newlines, so a multi-line email body
    // keeps its line breaks when this same wall runs over forwarded snippets.
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([,.;:)])/g, "$1")
    .replace(/\([ \t]+/g, "(")
    .replace(/,[ \t]*,/g, ",")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Whole-message intent match. ANCHOR + GUARD, not strip-to-exact.
//
// The old matcher stripped lead-ins and required the residue to be exactly "list".
// That missed every natural phrasing the operator actually uses ("my updated task
// list", "pull up my updated list with all reminders", "send me my updated list
// as in to do list") because a single surviving word ("task", "reminders",
// "upcoming") broke the exact-match. Those all fell to the brain, which then
// looped hollow "Already in the system" / "I have not done that yet" replies
// (live incident, 2026-07-21). The operator's own words ARE the contract.
//
// New shape: fire when the message ANCHORS on the board (list / board / "updated
// task") and carries NO competing action. It must still NOT hijack a compound
// command ("updated list and add X"), an outbound send to a third party ("send
// the list to John"), or a scoped query ("list tasks for Acme", "who is on my
// list").
export function isUpdatedListRequest(text) {
  const t = normalize(text);
  if (!t) return false;

  // ANCHOR: the message must reference the board itself.
  const hasAnchor = /\blist\b/.test(t) || /\bboard\b/.test(t) || /\bupdated tasks?\b/.test(t);
  if (!hasAnchor) return false;

  // COMPOUND / additive / destructive action on a specific item -> brain, not board.
  // (Singular "reminder" is an action to CREATE one; plural "reminders" is part of
  // the board contract and intentionally does not match \breminder\b.)
  if (/\b(add|create|new|remove|delete|drop|schedule|book|remind|reminder|move|mark|complete|completed|done|file|record|draft|update|change|rename|set|cancel|reply|invite|charge|refund|find|search)\b/.test(t)) return false;

  // OUTBOUND to a THIRD PARTY ("send the list to John", "email it to the team")
  // is an action. "send me" / "to me" (to the operator himself) is a list request.
  if (/\b(send|email|forward|share)\b/.test(t) && /\bto\b/.test(t) && !/\bto do\b/.test(t) && !/\bsend me\b/.test(t) && !/\bto me\b/.test(t)) return false;

  // SCOPED to a specific entity/person, or a pointed question -> brain.
  if (/\bfor [a-z]/.test(t) && !/\bfor (me|today|tomorrow|now|the day|this week)\b/.test(t)) return false;
  if (/\b(who|when|where|why|how)\b/.test(t)) return false;

  return true;
}

// YYYY-MM-DD -> a stable weekday/day/month label without timezone drift. Calendar
// dates carry no time-of-day, so anchor at UTC noon (never crosses a day boundary).
function prettyDate(ymd) {
  const d = new Date(`${ymd}T12:00:00Z`);
  if (isNaN(d.getTime())) return ymd;
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  if (isNaN(d.getTime())) return ymd;
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function reminderLabel(e, today, tomorrow) {
  const when = e.date === today ? "Today" : e.date === tomorrow ? "Tomorrow" : prettyDate(e.date);
  const time = e.time ? ` ${e.time}` : "";
  return `${when}${time} - ${cleanForClient(e.title)}`;
}

// The canonical render. WhatsApp formatting only (*single asterisks* for bold,
// "• " bullets). No em-dashes (the send chokepoint also strips them, belt + braces).
export function formatUpdatedList({ tasks, events, today, name } = {}) {
  const who = name || "Jensen";
  // Bucket every open task. A row with a missing/invalid quadrant falls into Q2
  // (the same default createTask uses) so a task is NEVER silently dropped from
  // the list, the whole point of "give me everything".
  const open = (tasks || [])
    .filter((t) => !t.done)
    .map((t) => ({ ...t, q: [1, 2, 3, 4].includes(Number(t.quadrant)) ? Number(t.quadrant) : 2 }));
  const lines = [`Here is your full list, ${who}.`];

  for (const q of [1, 2, 3, 4]) {
    lines.push("");
    lines.push(`*${Q_LABELS[q]}*`);
    const items = open.filter((t) => t.q === q);
    if (!items.length) lines.push("• Nothing here.");
    else for (const it of items) lines.push(`• ${cleanForClient(it.title)}`);
  }

  // Upcoming reminders = every FUTURE event plus today's not-yet-past events
  // (each event fires a reminder 5 min before start). Date-then-time ordered.
  const tomorrow = addDays(today, 1);
  const upcoming = (events || [])
    .filter((e) => e.date && (e.date > today || (e.date === today && e.status !== "past")))
    .slice()
    .sort((a, b) => (a.date === b.date ? String(a.time || "").localeCompare(String(b.time || "")) : a.date.localeCompare(b.date)));

  lines.push("");
  lines.push("*Upcoming Reminders*");
  if (!upcoming.length) lines.push("• Nothing scheduled.");
  else for (const e of upcoming) lines.push(`• ${reminderLabel(e, today, tomorrow)}`);

  return lines.join("\n");
}
