// PARTY WALL ON PERSISTENT WRITES (live incident, 2026-07-22, KT: dev-content on
// the client board). Taona's own dev tasks ("Evaluate Agent-Reach", "Vibe-Trading",
// "Trading ledger") were sitting in Jensen's Q1 board because a Taona/admin turn's
// tool WRITES persisted to Jensen's single tenant. The codebase already walls Taona
// out of Jensen's auto-captured memory; this pins the same wall on tool writes.
//
// Pure predicate, no DB, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { skipTenantWriteForDev } from "../../lib/concierge/dispatch.ts";

test("a non-Jensen turn is walled off from every persistent tenant write", () => {
  for (const name of [
    "create_task", "update_task", "complete_task", "delete_task", "accept_meeting_tasks",
    "create_event", "update_event", "delete_event",
    "record_finance", "add_contact", "add_note", "create_entity",
    "remember_fact", "remember_preference", "set_goals", "update_prefs",
  ]) {
    assert.equal(skipTenantWriteForDev(name, "taona"), true, `taona ${name} must be walled`);
  }
});

test("Jensen's own turn writes normally (never walled)", () => {
  for (const name of ["create_task", "create_event", "record_finance", "remember_fact"]) {
    assert.equal(skipTenantWriteForDev(name, "jensen"), false, `jensen ${name} must persist`);
  }
});

test("reads, and sending a file back to whoever asked, are never walled on a dev turn", () => {
  for (const name of ["list_tasks", "query_calendar", "search_documents", "send_filed_document", "day_log", "find_contact"]) {
    assert.equal(skipTenantWriteForDev(name, "taona"), false, `${name} must not be walled`);
  }
});

// Law 10: test traffic never reaches a real person. Until 2026-09-23 these outward
// sends were unwalled, so a developer typing "yes" during a test could send a real
// email from Jensen's mailbox, invite a real guest, or ring his phone -- the same
// class as the 2026-09-09 zanii.ai incident (a prod test fired ~9 real emails).
test("a dev turn can never make a real outward send from Jensen's accounts", () => {
  for (const name of ["send_email", "reply_email", "send_meeting_invite", "call_owner", "sanad_draft_contract"]) {
    assert.equal(skipTenantWriteForDev(name, "taona"), true, `taona ${name} must be walled`);
  }
});

test("Jensen's own turns still send for real", () => {
  for (const name of ["send_email", "reply_email", "send_meeting_invite", "call_owner"]) {
    assert.equal(skipTenantWriteForDev(name, "jensen"), false, `jensen ${name} must not be walled`);
  }
});

test("missing/empty party defaults to writing (portal/system callers pass no party)", () => {
  assert.equal(skipTenantWriteForDev("create_task", undefined), false);
  assert.equal(skipTenantWriteForDev("create_task", ""), false);
});
