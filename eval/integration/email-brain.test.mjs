// Email -> brain capture (so a later reference resolves). Tests the pure fact
// formatter: it keeps sender + subject + body content, so query_memory("Khalid")
// and recall("the contract") can match it later.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { emailFactText } from "../../lib/concierge/brain.ts";

test("captures sender, subject, and body content", () => {
  const f = emailFactText({ from: "Khalid Aziz", fromEmail: "khalid@acme.ae", subject: "Sohum contract terms", date: "2026-06-28", body: "Please find the revised AED 80k terms attached, 30 day payment." });
  assert.match(f, /Khalid Aziz/);
  assert.match(f, /khalid@acme\.ae/);
  assert.match(f, /Sohum contract terms/);
  assert.match(f, /80k/, "body content kept for recall, not just the summary");
});

test("a person reference can be found in the fact text", () => {
  const f = emailFactText({ from: "Khalid", subject: "lunch", body: "let's meet Tuesday" }).toLowerCase();
  assert.ok(f.includes("khalid"), "recall by sender name works");
});

test("body is whitespace-collapsed and capped (no giant rows)", () => {
  const f = emailFactText({ from: "X", subject: "s", body: "a\n\n  b   c".repeat(500) });
  assert.ok(f.length <= 900, `capped (got ${f.length})`);
  assert.ok(!/\n/.test(f), "newlines collapsed");
});

test("missing sender still produces a usable fact", () => {
  const f = emailFactText({ subject: "no sender", body: "hello" });
  assert.match(f, /unknown sender/);
});
