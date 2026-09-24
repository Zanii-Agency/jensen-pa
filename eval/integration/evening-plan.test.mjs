// The evening check on a day he has been quiet (FM-21 sibling, 2026-09-24).
//
// WhatsApp delivers free text only within 24h of his last message. His window is
// closed on about a quarter of days, and the evening check used to vanish on
// those days. Now it goes as the approved template evening_check_v3:
//   "Evening check, Jensen. {{1}} on your board today, {{2}} I am protecting,
//    {{3}} on schedule, {{4}} email proposals waiting."
// No call to action: two earlier wordings were classified MARKETING by Meta, and
// marketing templates may only reach people who opted in to marketing.
//
// The assertions are the exact words he reads, in his own voice, for each case.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  eveningPlan, eveningParams, eveningTemplateText, eveningTemplateName,
} from "../../lib/concierge/evening-plan.ts";

const BRIEF = "Evening check, Jensen. Here is how your board sits.\n\nYou have 3 Q1 items still open.\nReply here anytime if you need me.";
const OPEN = { open: true, hoursSince: 3 };
const QUIET = { open: false, hoursSince: 30 };
const COUNTS = { q1: 3, q2: 2, upcoming: 1, pendingMail: 4 };

test("he wrote today: the full brief, unchanged", () => {
  const p = eveningPlan(BRIEF, COUNTS, OPEN);
  assert.equal(p.mode, "text");
  assert.equal(p.text, BRIEF);
});

test("quiet for 30h: the template, and the transcript records its exact words", () => {
  const p = eveningPlan(BRIEF, COUNTS, QUIET);
  assert.equal(p.mode, "template");
  assert.deepEqual(p.params, ["3 items", "2 items", "1 event", "4"]);
  assert.equal(p.text, "Evening check, Jensen. 3 items on your board today, 2 items I am protecting, 1 event on schedule, 4 email proposals waiting.");
  // The logged words are built from the params, so they cannot drift from the sent ones.
  assert.equal(p.text, eveningTemplateText(p.params));
});

test("an empty board states zeros, as the approved morning brief does", () => {
  const p = eveningPlan(BRIEF, { q1: 0, q2: 0, upcoming: 0, pendingMail: 0 }, QUIET);
  assert.deepEqual(p.params, ["0 items", "0 items", "0 events", "0"]);
});

test("one stays singular, as in Meta's own approved example", () => {
  assert.deepEqual(eveningParams({ q1: 1, q2: 1, upcoming: 1, pendingMail: 1 }), ["1 item", "1 item", "1 event", "1"]);
  assert.deepEqual(eveningParams({ q1: 2, q2: 0, upcoming: 5, pendingMail: 0 }), ["2 items", "0 items", "5 events", "0"]);
});

test("23h50 counts as closed: text sent then can land after the window shuts", () => {
  assert.equal(eveningPlan(BRIEF, COUNTS, { open: true, hoursSince: 23.8 }).mode, "template");
  assert.equal(eveningPlan(BRIEF, COUNTS, { open: true, hoursSince: 23.4 }).mode, "text");
});

test("a read that failed sends no numbers (Law 6): the template can only state figures", () => {
  const p = eveningPlan(BRIEF, { q1: 0, q2: 0, upcoming: 0, pendingMail: 0 }, QUIET, true);
  assert.equal(p.mode, "skip");
  assert.match(p.reason, /could not be read/);
});

test("a failed read while he IS in window still sends: the full brief says so in words", () => {
  assert.equal(eveningPlan(BRIEF, COUNTS, OPEN, true).mode, "text");
});

test("window unknown fails closed to the template, which always delivers", () => {
  assert.equal(eveningPlan(BRIEF, COUNTS, undefined).mode, "template");
});

test("a wall-killed template falls back to the brief, so the catch is logged and paged", () => {
  assert.equal(eveningPlan(BRIEF, COUNTS, QUIET).fallbackText, BRIEF);
});

test("template parameters carry no newlines (Meta rejects them)", () => {
  for (const p of eveningParams(COUNTS)) assert.doesNotMatch(p, /[\n\r\t]/);
});

test("the template name comes ONLY from env, and unset means do not send", () => {
  // Fail closed: an approved MARKETING template delivers fine, so a code default
  // would silently send one the day the Vercel variable is wiped. Unset or empty
  // means the evening check records a skip.
  assert.equal(eveningTemplateName({}), "");
  assert.equal(eveningTemplateName({ EVENING_CHECK_TEMPLATE: "" }), "");
  assert.equal(eveningTemplateName({ EVENING_CHECK_TEMPLATE: "   " }), "");
  assert.equal(eveningTemplateName({ EVENING_CHECK_TEMPLATE: " evening_v9 " }), "evening_v9");
});
