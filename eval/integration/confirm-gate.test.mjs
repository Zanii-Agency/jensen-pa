// The deterministic fast path for answering a held destructive action.
//
// classifyReply settles ONLY an exact bare yes or an exact bare no. Everything
// else returns null and goes to the model, which reads the reply in the context
// of the question that was actually asked.
//
// Why it is this strict (adversarial review, 2026-09-23): the previous parser
// matched a yes-WORD anywhere in the line. It confirmed "Don't do it" (contains
// "do it"), "not sure" ("sure"), "Is that right?" ("right"), "ok thanks", "I'm
// fine" and "do not confirm", while reading Jensen's real request "stop them" as a
// no. This file used to pass, because it only ever tested easy cases. The lists
// below are the cases that actually broke, so it cannot go green on them again.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { classifyReply, isConfirmation, describeOutcome } from "../../lib/concierge/dispatch.ts";

test("bare affirmations are settled as yes", () => {
  for (const s of ["yes", "Yes", "YES!", "yep", "yeah", "ok", "okay", "confirm", "go ahead", "do it",
                   "yes please", "sure", "ya", "100%", "absolutely", "go for it", "fine", "👍", "correct", "yes, go ahead."]) {
    assert.equal(classifyReply(s), "yes", `'${s}' should be a bare yes`);
  }
});

test("bare refusals are settled as no", () => {
  for (const s of ["no", "No.", "nope", "nah", "don't", "do not", "not now", "not yet", "wait", "leave it", "keep them", "never mind"]) {
    assert.equal(classifyReply(s), "no", `'${s}' should be a bare no`);
  }
});

test("THE PHRASES THAT BROKE: never settled as yes by code", () => {
  for (const s of ["Don't do it", "no, don't go ahead", "do not confirm", "not sure", "Is that right?",
                   "ok thanks", "I'm fine", "yes delete it but not the 5pm one", "sure, but tomorrow"]) {
    assert.notEqual(classifyReply(s), "yes", `'${s}' must NOT execute a held action`);
    assert.equal(isConfirmation(s), false);
  }
});

test("replies whose meaning depends on the question go to the model (null), not to a word list", () => {
  // "stop them" is YES to "remove these 4 reminders?" and would be NO to "send this
  // email?". Only the model, seeing the question, can tell. This is the 16-Sep case.
  for (const s of ["stop them", "cancel them", "stop sending me reminder for DJ payment",
                   "no need to send me reminder again about this I already paid him",
                   "ok no more reminders please", "send it", "remove them all"]) {
    assert.equal(classifyReply(s), null, `'${s}' must be left to the model`);
  }
});

test("an ordinary first request is not a confirmation", () => {
  for (const s of ["delete the sotiris meeting", "remove that task", "cancel the dinner event", "email khalid", "what happened yesterday", "the okra order"]) {
    assert.equal(classifyReply(s), null, `'${s}' is a request, not an answer`);
  }
});

test("empty input is not an answer", () => {
  assert.equal(classifyReply(""), null);
  assert.equal(classifyReply("   "), null);
});

test("in a burst, the owner's FINAL line governs", () => {
  // A reversal on the last line must never execute. Whether code settles it as "no"
  // or hands it to the model (null), nothing held runs.
  assert.notEqual(classifyReply("yes\nactually wait"), "yes");
  assert.notEqual(classifyReply("yes\nactually wait no"), "yes");
  assert.equal(classifyReply("yes\nwait"), "no");
  assert.equal(classifyReply("delete the dinner\nyes"), "yes");
});

// ---- the words he reads after a confirmation come from what actually happened ----

test("a failed action never reads as done", () => {
  assert.match(describeOutcome("send_email", { ok: false, error: "SMTP 550 mailbox unavailable" }), /did not go through/);
  assert.match(describeOutcome("delete_event", { ok: false, error: "timeout" }), /nothing changed/);
});

test("the delete count is the number actually deleted, not the number asked for", () => {
  assert.equal(describeOutcome("delete_event", { ok: true, result: { deleted: ["a", "b", "c", "d"] } }), "Done. Removed all 4 from your calendar.");
  assert.equal(describeOutcome("delete_event", { ok: true, result: { deleted: ["a"] } }), "Done. Removed from your calendar.");
  assert.match(describeOutcome("delete_event", { ok: true, result: { deleted: [] } }), /already gone/);
});

test("a simulated test turn never claims a real change", () => {
  assert.equal(describeOutcome("delete_event", { ok: true, result: { simulated: true } }), "Test turn: nothing was actually changed.");
  assert.equal(describeOutcome("send_email", { ok: true, result: { simulated: true } }), "Test turn: nothing was actually changed.");
});
