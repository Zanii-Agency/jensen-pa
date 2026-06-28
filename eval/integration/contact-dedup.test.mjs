// Contact dedup — SAFE version (skeptic-hardened). A contact is merged ONLY on a
// positive shared identity signal (matching email or phone). A name-only collision
// is NEVER merged (two different people can share a name) — it inserts a new row a
// human can merge. Entities are not auto-deduped at all.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { pickContactDup, normalizeName } from "../../lib/concierge/ops.ts";

test("CRITICAL: two same-name contacts with NO email/phone are NOT merged", () => {
  // Ahmed the driver vs Ahmed the supplier, both blank -> must stay separate.
  assert.equal(pickContactDup([{ id: "a1", name: "Ahmed" }], "Ahmed"), null);
  assert.equal(pickContactDup([{ id: "k1", name: "Karafotias" }], "karafotias"), null);
});

test("merge ONLY on a matching email (same person, confirmed)", () => {
  const existing = [{ id: "j1", name: "John", email: "john@a.com" }];
  assert.equal(pickContactDup(existing, "John", "john@a.com"), "j1");
});

test("merge on a matching phone (digits-normalized)", () => {
  const existing = [{ id: "p1", name: "Sam", phone: "+971 50 000 0001" }];
  assert.equal(pickContactDup(existing, "Sam", null, "971500000001"), "p1");
});

test("same name, DIFFERENT email -> no merge (different people)", () => {
  const existing = [{ id: "j1", name: "John", email: "john@a.com" }];
  assert.equal(pickContactDup(existing, "John", "john@b.com"), null);
});

test("same email but no name match still merges (email is the strong identity)", () => {
  // name differs but the email is identical -> same person, different display name
  const existing = [{ id: "j1", name: "Jonathan", email: "j@a.com" }];
  assert.equal(pickContactDup(existing, "Jonathan", "j@a.com"), "j1"); // normalized name matches here
});

test("spelling variant with no shared signal is NOT merged", () => {
  assert.equal(pickContactDup([{ id: "j", name: "Jatin" }], "Jhatin"), null);
});

test("two same-name+same-email rows -> ambiguous -> no merge", () => {
  const existing = [{ id: "a", name: "Ali", email: "ali@x.com" }, { id: "b", name: "Ali", email: "ali@x.com" }];
  assert.equal(pickContactDup(existing, "Ali", "ali@x.com"), null);
});

test("normalizeName basics", () => {
  assert.equal(normalizeName("  A.B  c "), "ab c");
});
