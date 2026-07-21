// Wall: deterministic "updated list" command (KT #206540).
// Intent (operator, verbatim, 2026-06-26): "when I say 'updated list' give me
// quadrants plus all upcoming reminders." The free-form brain led with "Today's
// Calendar", truncated quadrants, and showed today-only reminders, forcing three
// corrections in one thread. These checks assert the HUMAN-VISIBLE output, not
// that a function ran. Pure module = zero drift between this proof and prod.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isUpdatedListRequest, formatUpdatedList } from "../../lib/concierge/updated-list.mjs";

test("isUpdatedListRequest fires on the operator's real phrasings", () => {
  for (const s of [
    "updated list",
    "Give me full updated list",
    "Give me full updated list general",
    "give me full updated list with everything",
    "full list",
    "the full list",
    "give me my list",
    "list",
    "show me the updated list please",
    // The verbatim 07-21 phrasings that the tight matcher MISSED, so the request
    // fell to the brain and looped hollow "Already in the system" / "I have not
    // done that yet" replies. These are the operator's own words, they ARE the
    // contract: every one must reach the deterministic board.
    "Hello pull up my updated list with all reminders",
    "Pull out my full updated list meaning with all upcoming reminders",
    "what I mean I need my updated list which has all my task and upcmoning reminders",
    "I want you to send me my updated list as in to do list with urgent not urgent etc and all upcoming events",
    "I need my updated task list",
    "updated task",
    "give me the list",
    "whats on the board",
  ]) {
    assert.equal(isUpdatedListRequest(s), true, `should match: "${s}"`);
  }
});

test("isUpdatedListRequest does NOT hijack compound or scoped commands", () => {
  for (const s of [
    "list tasks for Acme",
    "add milk to my list",
    "updated list and add a task to review the contract",
    "send the list to John",            // sending the list to a THIRD PARTY is an action
    "email the list to the team",       // same, via email
    "who is on my contact list",        // scoped question, not the board
    "remind me at 3pm",
    "what's on today",
    "give me everything",          // no "list" word: stays with the brain by design
    "complete the contract task",
    "",
  ]) {
    assert.equal(isUpdatedListRequest(s), false, `should NOT match: "${s}"`);
  }
});

// The board as it stood in the real thread, plus a past-today event to prove
// past items are dropped from "upcoming".
const TODAY = "2026-06-26"; // Friday
const tasks = [
  { title: "Afrosensia: presentation and agreement", quadrant: 1, done: false },
  { title: "Sponsorship deck for Upaya", quadrant: 1, done: false },
  { title: "Review contract for Upaya with Taona", quadrant: 1, done: false },
  { title: "Minal: NDA agreement", quadrant: 2, done: false },
  { title: "Farai: event for Wednesdays", quadrant: 2, done: false },
  { title: "Draft email to Stephane: sponsors list", quadrant: 2, done: false },
  { title: "Dorje contract for Taona", quadrant: 2, done: false },
  { title: "Meeting with Steve: cafe takeover", quadrant: 2, done: false },
  { title: "Sara: final settlement", quadrant: 3, done: false },
  { title: "Marketing things for Vivek", quadrant: 4, done: false },
  { title: "OLD already-handled thing", quadrant: 1, done: true }, // must never show
];
const events = [
  { title: "Breakfast (already happened)", date: "2026-06-26", time: "08:00", status: "past" },
  { title: "Meeting with Sotiris (La Rencontre x Mawhub)", date: "2026-06-26", time: "15:00", status: "upcoming" },
  { title: "Meeting with Tailor", date: "2026-06-26", time: "16:00", status: "upcoming" },
  { title: "Meeting with Steve at Sohum Cafe", date: "2026-06-27", time: "15:00", status: "upcoming" },
  { title: "Meeting with Sotiris", date: "2026-06-29", time: "15:00", status: "upcoming" },
  { title: "Meeting with A2 Milk", date: "2026-06-29", time: "16:00", status: "upcoming" },
  { title: "Meeting with Nawel at Sohum", date: "2026-07-02", time: "15:00", status: "upcoming" },
  { title: "Upaya trade license: early renewal", date: "2026-08-10", time: "09:00", status: "upcoming" },
];

test("formatUpdatedList renders all four quadrants plus upcoming reminders, no today-calendar preamble", () => {
  const out = formatUpdatedList({ tasks, events, today: TODAY, name: "Jensen" });

  // Opens with the list, NOT a "Today's Calendar" block.
  assert.match(out, /^Here is your full list, Jensen\./);
  assert.ok(!/Today's Calendar/i.test(out), "must not lead with Today's Calendar");

  // All four quadrant headers present, in order.
  const iQ1 = out.indexOf("Q1 - Urgent + Important");
  const iQ2 = out.indexOf("Q2 - Important, Not Urgent");
  const iQ3 = out.indexOf("Q3 - Urgent, Not Important");
  const iQ4 = out.indexOf("Q4 - Drop");
  assert.ok(iQ1 > -1 && iQ2 > iQ1 && iQ3 > iQ2 && iQ4 > iQ3, "all four quadrants present, in order");

  // Q4 content present = proof nothing got truncated.
  assert.match(out, /• Marketing things for Vivek/);

  // Completed task never appears.
  assert.ok(!/OLD already-handled thing/.test(out));

  // Upcoming reminders section, date-ordered, with the operator's exact labels.
  assert.match(out, /\*Upcoming Reminders\*/);
  // Note: 2026-06-26 is a Friday, so 06-27 is "Tomorrow" and 07-02 is a THURSDAY.
  // The bot in the original thread mislabeled these (weekday-drift); the
  // deterministic renderer computes the true weekday, which is the point.
  assert.match(out, /• Today 15:00 - Meeting with Sotiris \(La Rencontre x Mawhub\)/);
  assert.match(out, /• Today 16:00 - Meeting with Tailor/);
  assert.match(out, /• Tomorrow 15:00 - Meeting with Steve at Sohum Cafe/);
  assert.match(out, /• Mon 29 Jun 15:00 - Meeting with Sotiris/);
  assert.match(out, /• Mon 29 Jun 16:00 - Meeting with A2 Milk/);
  assert.match(out, /• Thu 2 Jul 15:00 - Meeting with Nawel at Sohum/);
  assert.match(out, /• Mon 10 Aug 09:00 - Upaya trade license: early renewal/);

  // Past-today event is excluded from upcoming.
  assert.ok(!/already happened/.test(out));

  // Ordering: today before tomorrow before later dates.
  assert.ok(out.indexOf("Today 15:00") < out.indexOf("Tomorrow 15:00"), "today before tomorrow");
  assert.ok(out.indexOf("Tomorrow 15:00") < out.indexOf("Mon 29 Jun"), "tomorrow before Monday 29");
  assert.ok(out.indexOf("Mon 29 Jun 15:00") < out.indexOf("Mon 29 Jun 16:00"), "same-day time order");
});

test("empty board shows graceful placeholders, never a blank section", () => {
  const out = formatUpdatedList({ tasks: [], events: [], today: TODAY, name: "Jensen" });
  assert.match(out, /\*Q1 - Urgent \+ Important\*\n• Nothing here\./);
  assert.match(out, /\*Upcoming Reminders\*\n• Nothing scheduled\./);
});

test("a task with a missing quadrant is never dropped, it lands in Q2", () => {
  const out = formatUpdatedList({
    tasks: [{ title: "Orphan task no quadrant", done: false }, { title: "Bad quadrant", quadrant: 9, done: false }],
    events: [],
    today: TODAY,
    name: "Jensen",
  });
  const q2 = out.slice(out.indexOf("Q2 - Important, Not Urgent"), out.indexOf("Q3 -"));
  assert.match(q2, /• Orphan task no quadrant/);
  assert.match(q2, /• Bad quadrant/);
});

test("no em-dashes or markdown headings leak into the output", () => {
  const out = formatUpdatedList({ tasks, events, today: TODAY, name: "Jensen" });
  assert.ok(!/[—–]/.test(out), "no em/en dashes");
  assert.ok(!/^#/m.test(out), "no markdown headings");
  assert.ok(!/\*\*/.test(out), "no double-asterisk markdown bold");
});
