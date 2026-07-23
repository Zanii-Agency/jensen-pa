// C1 fix: a destructive action confirms on the OWNER'S real affirmation, not a
// model-set field. isConfirmation is the gate's decision — it must accept genuine
// yeses, reject imperatives (the first request) and negations.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { isConfirmation } from "../../lib/concierge/dispatch.ts";

test("genuine affirmations are confirmations", () => {
  for (const s of ["yes", "Yes", "yep", "yeah", "ok", "okay", "confirm", "go ahead", "do it", "send it", "yes please", "yes delete it"]) {
    assert.equal(isConfirmation(s), true, `'${s}' should confirm`);
  }
});

test("the FIRST destructive request (an imperative) is NOT a confirmation", () => {
  // The owner asking to delete is not itself the confirm; the bot must ask + wait.
  for (const s of ["delete the sotiris meeting", "remove that task", "cancel the dinner event", "email khalid"]) {
    assert.equal(isConfirmation(s), false, `'${s}' must require a separate yes`);
  }
});

test("negations and holds are NOT confirmations", () => {
  for (const s of ["no", "no don't", "don't delete it", "not yet", "wait", "stop", "cancel that"]) {
    assert.equal(isConfirmation(s), false, `'${s}' must not confirm`);
  }
});

test("'yesterday' and lookalikes do not false-confirm", () => {
  assert.equal(isConfirmation("what happened yesterday"), false);
  assert.equal(isConfirmation("the okra order"), false);
});

test("empty / whitespace is not a confirmation", () => {
  assert.equal(isConfirmation(""), false);
  assert.equal(isConfirmation("   "), false);
});

// --- Skeptic #6 CRITICAL: burst reversal — the owner's LAST line governs ---
test("'yes\\nactually wait no' is NOT a confirmation (reversal in a burst)", () => {
  assert.equal(isConfirmation("yes\nactually wait no"), false);
  assert.equal(isConfirmation("yes\nactually cancel that"), false);
  assert.equal(isConfirmation("delete it\nno wait"), false);
});
test("'delete the dinner\\nyes' DOES confirm (yes is the final word)", () => {
  assert.equal(isConfirmation("delete the dinner\nyes"), true);
});

// --- Skeptic #3: casual yeses the owner actually uses must work ---
test("casual affirmations confirm (no legit-block)", () => {
  for (const s of ["sure", "ya", "100%", "absolutely", "go for it", "do that one", "fine", "👍", "correct"]) {
    assert.equal(isConfirmation(s), true, `'${s}' should confirm`);
  }
});
