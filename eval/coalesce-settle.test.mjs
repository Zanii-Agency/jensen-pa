// Adaptive settle (Jensen-elevation Phase 0). Asserts the burst debounce now
// returns EARLY for a quiet sender (the common single-message case) while still
// extending for a real burst and never exceeding the hard cap. This is the
// latency win that must NOT regress the double-reply coalescing guarantee.
//
// Pure: settleForBurst takes an injected getCount + timing opts, so no DB, no
// network, no Anthropic spend. Tiny timers keep the test fast.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { settleForBurst } from "../lib/whatsapp-coalesce.ts";

const OPTS = { capMs: 400, quietMs: 100, pollMs: 20 };

test("quiet sender (single message) returns after ~quietMs, well before cap", async () => {
  let calls = 0;
  const t0 = Date.now();
  await settleForBurst(async () => { calls++; return 1; }, OPTS); // count never grows
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= OPTS.quietMs, `should wait at least quietMs, waited ${elapsed}`);
  assert.ok(elapsed < OPTS.capMs, `should return before cap, waited ${elapsed}`);
});

test("burst: each new inbound resets the quiet timer, then settles", async () => {
  // count grows for the first ~150ms, then goes quiet -> should outlast a single
  // quiet window but still finish before the cap.
  const t0 = Date.now();
  await settleForBurst(async () => {
    const dt = Date.now() - t0;
    return dt < 150 ? Math.floor(dt / 30) + 1 : 6; // climbs, then flat at 6
  }, OPTS);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 150 + OPTS.quietMs - OPTS.pollMs, `should extend past the burst, waited ${elapsed}`);
  assert.ok(elapsed <= OPTS.capMs + OPTS.pollMs, `should respect cap, waited ${elapsed}`);
});

test("never-quiet burst is bounded by the hard cap", async () => {
  let n = 0;
  const t0 = Date.now();
  await settleForBurst(async () => ++n, OPTS); // count grows every poll, never quiet
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= OPTS.capMs - OPTS.pollMs, `should run to the cap, waited ${elapsed}`);
  assert.ok(elapsed <= OPTS.capMs + OPTS.pollMs * 2, `should not exceed cap+slack, waited ${elapsed}`);
});
