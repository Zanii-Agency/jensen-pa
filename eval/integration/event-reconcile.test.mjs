// Phase 2 cross-date reconcile (kills the duplicate-meeting class: the 3 "Meeting
// with Sotiris" rows). pickReconcileTarget is the pure decision: a moved meeting
// updates the one existing row; distinct/ambiguous never blind-merge.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { pickReconcileTarget, normalizeEventTitleKey } from "../../lib/concierge/ops.ts";

const k = (t) => normalizeEventTitleKey(t);

test("moved meeting: single same-identity upcoming on another date -> reconcile to it", () => {
  const upcoming = [
    { id: "old", title: "Meeting with Sotiris", date: "2026-06-26" },
    { id: "x", title: "Meeting with A2 Milk", date: "2026-06-29" },
  ];
  assert.equal(pickReconcileTarget(upcoming, k("Meeting with Sotiris"), "2026-06-27"), "old");
});

test("same date is NOT a cross-date move (the same-day dedup already handled it)", () => {
  const upcoming = [{ id: "old", title: "Meeting with Sotiris", date: "2026-06-27" }];
  assert.equal(pickReconcileTarget(upcoming, k("Meeting with Sotiris"), "2026-06-27"), null);
});

test("two distinct same-title upcoming meetings -> NULL (never blind-merge)", () => {
  const upcoming = [
    { id: "a", title: "Meeting with Sotiris", date: "2026-06-26" },
    { id: "b", title: "Meeting with Sotiris", date: "2026-06-28" },
  ];
  assert.equal(pickReconcileTarget(upcoming, k("Meeting with Sotiris"), "2026-06-30"), null);
});

test("no same-identity upcoming -> NULL (insert a fresh event)", () => {
  const upcoming = [{ id: "x", title: "Meeting with A2 Milk", date: "2026-06-29" }];
  assert.equal(pickReconcileTarget(upcoming, k("Meeting with Sotiris"), "2026-06-27"), null);
});

test("generic title ('Review') never reconciles -> distinct meetings stay separate", () => {
  const upcoming = [{ id: "r", title: "Review", date: "2026-06-26" }];
  assert.equal(pickReconcileTarget(upcoming, k("Review"), "2026-06-28"), null);
});

test("generic 'Call' / 'Sync' / 'Standup' never reconcile", () => {
  for (const g of ["Call", "Sync", "Standup", "Lunch"]) {
    const up = [{ id: "g", title: g, date: "2026-06-26" }];
    assert.equal(pickReconcileTarget(up, k(g), "2026-06-28"), null, `${g} must not reconcile`);
  }
});

test("identity ignores the 'Meeting with the' scaffold (same meeting, two phrasings)", () => {
  const upcoming = [{ id: "old", title: "Meeting with the Karafotias", date: "2026-06-26" }];
  assert.equal(pickReconcileTarget(upcoming, k("Karafotias"), "2026-06-27"), "old");
});

// --- Skeptic F1 (CRITICAL): a RECURRING anchor is one upcoming row; never move it ---
test("recurring weekly meeting is NEVER reconciled (would corrupt the series)", () => {
  const upcoming = [{ id: "rec1", title: "Weekly with Sotiris", date: "2026-07-06", recurrence: "weekly" }];
  assert.equal(pickReconcileTarget(upcoming, k("Weekly with Sotiris"), "2026-07-08"), null);
});

// --- Skeptic F3 (HIGH): two distinct meetings, same person, different entity ids ---
test("same title key but DIFFERENT entity -> NULL (two real meetings, don't merge)", () => {
  const upcoming = [{ id: "a", title: "Meeting with Sotiris", date: "2026-07-02", entity_id: "ent-A" }];
  assert.equal(pickReconcileTarget(upcoming, k("Meeting with Sotiris"), "2026-07-09", "ent-B"), null);
});
test("same title key and SAME entity -> reconcile (genuinely the same meeting moved)", () => {
  const upcoming = [{ id: "a", title: "Meeting with Sotiris", date: "2026-07-02", entity_id: "ent-A" }];
  assert.equal(pickReconcileTarget(upcoming, k("Meeting with Sotiris"), "2026-07-09", "ent-A"), "a");
});
test("entity present on new but absent on existing -> still reconcile (title identity fallback)", () => {
  const upcoming = [{ id: "a", title: "Meeting with Sotiris", date: "2026-07-02" }];
  assert.equal(pickReconcileTarget(upcoming, k("Meeting with Sotiris"), "2026-07-09", "ent-B"), "a");
});
