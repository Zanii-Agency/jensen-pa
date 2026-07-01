#!/usr/bin/env node
// ROUTER STARVATION WALL (KT #206597). The mesh scopes the toolset per domain
// (scopeToolNames). A message that routes to a single lane whose manifest lacks
// the tool it needs is "starved" — the model cannot complete the action. This wall
// pins the fixed cases so a future manifest edit cannot silently re-starve them.
// Uses the REAL full tool list as the base (not an artificial subset — a subset
// trips scopeToolNames' never-starve fallback and hides the bug).
import { test } from "node:test";
import assert from "node:assert/strict";
import { routeDomain, scopeToolNames } from "../../lib/concierge/router.ts";
import { TOOLS } from "../../lib/concierge/tools.ts";

const ALL = TOOLS.map((t) => t.name);
const reaches = (phrase, tool) => scopeToolNames(routeDomain(phrase).domain, ALL).includes(tool);

test("send_task_to_peer reachable via the natural delegation verbs (forward/email to Taona)", () => {
  assert.ok(reaches("forward this to Taona", "send_task_to_peer"), "forward -> comms must expose send_task_to_peer");
  assert.ok(reaches("email this to Taona", "send_task_to_peer"), "email -> comms must expose send_task_to_peer");
  assert.ok(reaches("put this on Taona's task list", "send_task_to_peer"), "task list -> tasks must expose it");
});

test("store_summary reachable when asking about orders/revenue (Law 7: Shopify is canonical)", () => {
  assert.ok(reaches("how much revenue did we make on orders this month", "store_summary"));
});

test("add_contact reachable from a money/docs turn", () => {
  assert.ok(reaches("invoice Khalid 5000 aed and add his number", "add_contact"));
});

// Deliberate leanness (not a bug): remember_fact + entity_dashboard stay general-only
// so lanes stay lean. The bare phrasings route to general (which HAS them), and a
// scoped-lane "remember" degrades to add_note (cross-cutting). This pins that the
// bare phrasings are NOT starved.
test("bare 'remember X' and 'what's going on with X' route to general and reach their tool", () => {
  assert.ok(reaches("remember that Khalid moved offices", "remember_fact"));
  assert.ok(reaches("what's going on with the Sohum account", "entity_dashboard"));
});

test("a scoped 'remember' still has add_note (graceful capture, not data loss)", () => {
  assert.ok(reaches("remind me tomorrow and remember Khalid moved offices", "add_note"));
});
