#!/usr/bin/env node
// PEER-SYNC ISOLATION WALL (ADR-0015). Proves the cross-bot bridge cannot leak
// PII, is fail-closed on auth, and is an inert no-op when the flag is off.
// Pure local: no DB, no network, no Anthropic.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toPeerPayload, sanitizeInbound, signPeer, verifyPeer, sendTaskToPeer,
  PEER_ALLOWED_FIELDS,
} from "../../lib/peer-sync.ts";

test("outbound payload carries ONLY the allowlisted fields, never PII", () => {
  const p = toPeerPayload({ title: "Review Upaya contract", due: "2026-07-04", status: "open", correlationId: "task_123" });
  assert.deepEqual(Object.keys(p).sort(), [...PEER_ALLOWED_FIELDS].sort());
  // entity_id / notes / phone / guest data have no path in — the mapper takes
  // named args, never a task row, so they physically cannot appear.
  assert.equal("entity_id" in p, false);
  assert.equal("note" in p, false);
  assert.equal(p.source_bot, "dorje");
});

test("inbound sanitizer DROPS any non-allowlisted key an attacker/peer injects", () => {
  const dirty = {
    title: "x", due: "2026-07-04", status: "done", correlation_id: "task_9", source_bot: "taona-bot",
    entity_id: "ent_secret", guest_phone: "+971500000000", note: "PII leak attempt", amount: 5000,
  };
  const clean = sanitizeInbound(dirty);
  assert.deepEqual(Object.keys(clean).sort(), [...PEER_ALLOWED_FIELDS].sort());
  assert.equal("entity_id" in clean, false);
  assert.equal("guest_phone" in clean, false);
  assert.equal("amount" in clean, false);
});

test("sanitizeInbound rejects a payload with no correlation_id (cannot inject a new task)", () => {
  assert.equal(sanitizeInbound({ title: "x", status: "done" }), null);
  assert.equal(sanitizeInbound(null), null);
});

test("verifyPeer is FAIL-CLOSED: no secret, no header, and bad signature all reject", () => {
  const raw = JSON.stringify({ a: 1 });
  delete process.env.PEER_SYNC_SECRET;
  assert.equal(verifyPeer(raw, "sha256=whatever"), false, "no secret -> reject");
  process.env.PEER_SYNC_SECRET = "s3cr3t";
  assert.equal(verifyPeer(raw, null), false, "no header -> reject");
  assert.equal(verifyPeer(raw, "sha256=deadbeef"), false, "bad sig -> reject");
  assert.equal(verifyPeer(raw, signPeer(raw)), true, "correct sig -> accept");
  delete process.env.PEER_SYNC_SECRET;
});

test("sendTaskToPeer is an inert no-op when PEER_SYNC is off (default)", async () => {
  delete process.env.PEER_SYNC;
  const r = await sendTaskToPeer(toPeerPayload({ title: "x", status: "open", correlationId: "c1" }));
  assert.equal(r.skipped, true);
  assert.equal(r.ok, false);
});

test("sendTaskToPeer no-ops when enabled but unconfigured (no URL/secret) — never throws", async () => {
  process.env.PEER_SYNC = "on";
  delete process.env.PEER_TAONA_URL;
  delete process.env.PEER_SYNC_SECRET;
  const r = await sendTaskToPeer(toPeerPayload({ title: "x", status: "open", correlationId: "c1" }));
  assert.equal(r.skipped, true);
  delete process.env.PEER_SYNC;
});
