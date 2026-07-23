// Phase 1 park-buffer matching (incident B: link arrives before its event).
// Pure decision test: a parked link is claimed by the event its message names,
// and NEVER by a same-day decoy it doesn't name.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { pickParkedLink } from "../../lib/pending-links.ts";

const parked = [
  { url: "https://teams.microsoft.com/meet/41145142143720", hint: "sotiris meeting tomorrow send me a reminder with this link", ts: Date.now() },
];

test("incident B: Sotiris link is claimed when the Sotiris event is created", () => {
  assert.equal(pickParkedLink(parked, "Meeting with Sotiris"), 0);
});

test("the parked Sotiris link is NOT claimed by an A2 Milk event (no misroute)", () => {
  assert.equal(pickParkedLink(parked, "Meeting with A2 Milk"), -1);
});

test("scaffold-only hint never claims any event", () => {
  const junk = [{ url: "https://x.co/1", hint: "send me a reminder with this link", ts: Date.now() }];
  assert.equal(pickParkedLink(junk, "Meeting with Sotiris"), -1);
});

test("empty buffer -> -1", () => {
  assert.equal(pickParkedLink([], "Anything"), -1);
});

// --- Skeptic F1: park key and take key MUST share the same keyspace, or every
// parked link is orphaned. parkLink is called with inboundParty (role) in the
// route; takeParkedLinkFor is called with ctx.party (role) in dispatch. Both must
// be the ROLE string, never the phone number, so kv keys match. ---
import { readFileSync } from "node:fs";
const routeSrc = readFileSync(new URL("../../app/api/whatsapp/route.ts", import.meta.url), "utf8");
const dispatchSrc = readFileSync(new URL("../../lib/concierge/dispatch.ts", import.meta.url), "utf8");

test("F1: route parks with inboundParty (role), not the phone number", () => {
  assert.match(routeSrc, /parkLink\(inboundParty,/, "route must park by role so the key matches the take side");
  assert.doesNotMatch(routeSrc, /parkLink\(from,/, "parking by phone orphans the link (take side reads by role)");
});
test("F1: dispatch claims parked links by ctx.party (same role keyspace)", () => {
  assert.match(dispatchSrc, /takeParkedLinkFor\(ctx\.party,/, "drain must read by the same role key the route parks under");
});
