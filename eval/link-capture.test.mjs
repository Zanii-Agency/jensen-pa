// Jensen-elevation Phase 1 — link/memory convergence fix.
// Intent cases ARE the real production incidents from the transcript (B/C/D).
// We test the OUTCOME (which link is captured, which event it resolves to),
// not just that a function ran. zanii-codef: pure helpers, no DB/network.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { extractAnyUrl, extractMeetingLink, resolveEventByIdentity } from "../lib/digital-u.ts";

// --- Incident C: Luma link silently dropped (22 Jun) ---
test("incident C: a Luma link IS captured (link-first, not platform-gated)", () => {
  const msg = "send a calendar invite to Taona for 6pm tomorrow https://luma.com/DubaiTechTues103?fbclid=abc";
  // The old gate (extractMeetingLink) drops it -> the silent-drop bug.
  assert.equal(extractMeetingLink(msg), null, "Luma is not a join-able platform");
  // The fix captures it anyway, trailing junk trimmed.
  assert.equal(extractAnyUrl(msg), "https://luma.com/DubaiTechTues103?fbclid=abc");
});

test("known platforms still captured by both extractors", () => {
  for (const u of [
    "https://meet.google.com/oex-yxnq-syw",
    "https://teams.microsoft.com/meet/41145142143720?p=3nfr7UHTRBIV3r6UVa",
    "https://acme.zoom.us/j/123456789",
  ]) {
    assert.equal(extractAnyUrl(`here ${u} thanks`), u);
    assert.equal(extractMeetingLink(`here ${u} thanks`), u);
  }
});

test("no URL anywhere -> null (never clobber)", () => {
  assert.equal(extractAnyUrl("sotiris meeting tomorrow, send a reminder"), null);
});

// --- Incident D: link misrouted to "A2 Milk" via the word "meeting" (25 Jun) ---
const EVENTS = [
  { id: "a2", title: "Meeting with A2 Milk" },
  { id: "sot", title: "Meeting with Sotiris" },
  { id: "din", title: "Dinner" },
];

test("incident D: 'sotiris meeting ... with this link' resolves to Sotiris, NOT A2 Milk", () => {
  const r = resolveEventByIdentity("sotiris meeting tomorrow send me a reminder with this link", EVENTS);
  assert.equal(r?.id, "sot");
});

test("scaffold words alone ('send me a reminder with this link') resolve to NOTHING (no guess)", () => {
  // No distinctive token -> null -> caller must park + ask, never attach to A2 Milk.
  const r = resolveEventByIdentity("send me a reminder with this link", EVENTS);
  assert.equal(r, null);
});

test("ambiguous match (two events share a token) resolves to NOTHING, never a coin-flip", () => {
  const evs = [{ id: "1", title: "Sotiris lunch" }, { id: "2", title: "Sotiris dinner" }];
  assert.equal(resolveEventByIdentity("sotiris link below", evs), null);
});

// --- Incident B: link arrives before its event exists ---
test("incident B: link for a not-yet-created meeting resolves to NOTHING (-> park, don't drop)", () => {
  // Sotiris event does not exist yet; only A2 Milk does. Must NOT attach to A2.
  const r = resolveEventByIdentity("sotiris meeting tomorrow with this link", [{ id: "a2", title: "Meeting with A2 Milk" }]);
  assert.equal(r, null, "no Sotiris event yet -> no match -> park the link");
});
