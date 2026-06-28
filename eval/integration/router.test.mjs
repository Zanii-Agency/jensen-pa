// Mesh router (Phase 3 de-monolith). Asserts single-intent turns scope to a lane,
// ambiguous/multi-domain turns keep the FULL toolset (never starve = always
// delivers), and scoping never invents or empties tools.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { routeDomain, scopeToolNames, focusBlock } from "../../lib/concierge/router.ts";

const ALL = [
  "query_calendar", "create_event", "update_event", "delete_event", "complete_event",
  "accept_meeting_tasks", "send_meeting_invite", "day_log",
  "list_tasks", "create_task", "update_task", "complete_task", "delete_task",
  "list_inbox", "read_email", "search_email", "reply_email", "send_email", "draft_reply", "call_owner",
  "finance_summary", "list_finance", "record_finance", "update_finance", "delete_finance", "vat_report", "ct_estimate",
  "send_filed_document", "list_documents", "file_document", "delete_document", "generate_document", "generate_legal", "set_legal_blueprint", "sanad_draft_contract", "sanad_review_contract",
  "list_entities", "find_entity", "create_entity", "update_entity", "delete_entity",
  "list_contacts", "find_contact", "add_contact", "update_contact", "delete_contact", "entity_dashboard",
  "list_notes", "add_note", "delete_note",
  "query_memory", "remember_fact", "remember_preference", "list_memory", "forget_memory",
  "get_settings", "update_prefs", "set_goals", "store_summary", "morning_brief", "read_owner_chats",
];

test("single-intent calendar turn routes to calendar + shrinks the toolset", () => {
  const r = routeDomain("move my Sotiris meeting to 3pm tomorrow");
  assert.equal(r.domain, "calendar");
  const scoped = scopeToolNames("calendar", ALL);
  assert.ok(scoped.includes("create_event"));
  assert.ok(scoped.includes("find_contact"), "cross-cutting present");
  assert.ok(!scoped.includes("record_finance"), "finance tool not in calendar lane");
  assert.ok(scoped.length < ALL.length, "toolset shrank");
});

test("finance turn routes to money", () => {
  assert.equal(routeDomain("log the 5000 AED invoice payment").domain, "money");
});
test("email turn routes to comms", () => {
  assert.equal(routeDomain("reply to the email from Khalid").domain, "comms");
});
test("task turn routes to tasks", () => {
  assert.equal(routeDomain("add buy shoes to my list, not urgent").domain, "tasks");
});
test("docs turn routes to docs", () => {
  assert.equal(routeDomain("send me my passport document").domain, "docs");
});

// --- The always-delivers guardrail: ambiguity keeps the FULL toolset ---
test("ambiguous/no-signal turn -> general -> FULL toolset (never starve)", () => {
  const r = routeDomain("hey, what's going on");
  assert.equal(r.domain, "general");
  assert.deepEqual(scopeToolNames("general", ALL), ALL);
});

test("multi-domain turn (calendar + email) -> general -> full toolset (no starve)", () => {
  // both calendar and comms fire -> tie/multi -> general, so the model keeps
  // create_event AND send_email and can do both.
  const r = routeDomain("move my 2pm meeting and email Khalid the new time");
  assert.equal(r.domain, "general");
  assert.deepEqual(scopeToolNames("general", ALL), ALL);
});

test("scoping never invents a tool not in the base set", () => {
  const scoped = scopeToolNames("calendar", ["create_event", "find_contact"]);
  assert.deepEqual(scoped, ["create_event", "find_contact"]);
});

test("scoping never returns empty (falls back to full if manifest misses)", () => {
  const base = ["some_unknown_tool"]; // none in calendar manifest
  assert.deepEqual(scopeToolNames("calendar", base), base, "empty scope -> full base, never zero tools");
});

test("focus block is empty for general, present for a lane", () => {
  assert.equal(focusBlock("general"), "");
  assert.match(focusBlock("calendar"), /scheduling/i);
});

// --- Skeptic FIX-FIRST: starvation triggers must now have the needed tool ---
test("5c: 'what did I spend on the Sohum event' routes to money, NOT a toolless calendar lane", () => {
  const r = routeDomain("what did I spend on the Sohum event");
  assert.equal(r.domain, "money");
  assert.ok(scopeToolNames("money", ALL).includes("finance_summary"));
});

test("4: a 'from now on...' preference is never dropped in a scoped lane", () => {
  // calendar turn that also sets a standing preference
  const scoped = scopeToolNames("calendar", ALL);
  assert.ok(scoped.includes("remember_preference"), "remember_preference is cross-cutting");
  assert.ok(scoped.includes("add_note"), "add_note is cross-cutting");
});

test("1a: any lane can look up + add a contact to email/invite a person", () => {
  for (const d of ["calendar", "comms", "docs", "money"]) {
    const s = scopeToolNames(d, ALL);
    assert.ok(s.includes("find_contact") && s.includes("list_contacts") && s.includes("add_contact"), `${d} can resolve a contact`);
  }
});

test("1b/1e: docs and money lanes can send their output (no send-starve)", () => {
  assert.ok(scopeToolNames("docs", ALL).includes("send_email"), "docs can email out");
  assert.ok(scopeToolNames("money", ALL).includes("send_email"), "money can send a receipt");
  assert.ok(scopeToolNames("money", ALL).includes("send_filed_document"));
});

test("1c: every lane can read the calendar for truthful context", () => {
  for (const d of ["comms", "tasks", "docs", "money"]) {
    assert.ok(scopeToolNames(d, ALL).includes("query_calendar"), `${d} can check the calendar`);
  }
});
