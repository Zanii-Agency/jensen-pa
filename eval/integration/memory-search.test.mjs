// Keyword memory (2026-09-23). Long-term memory had been effectively OFF since June:
// the embed key returns 401 and the fallback searched his WHOLE message as one
// substring. These pin the word extraction that replaced it, using his real phrasing.
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { memoryKeywords } from "../../lib/concierge/memory-search.ts";

test("the road-test question searches for the thing, not the filler", () => {
  assert.deepEqual(memoryKeywords("did I tell you the time for tomorrow road test?"), ["road", "test"]);
});

test("names are kept and accents never block a match", () => {
  assert.deepEqual(memoryKeywords("stephane I still expect the reminder"), ["stephane", "expect"]);
  assert.ok(memoryKeywords("Message Stéphane").includes("stephane"), "Stéphane must fold to stephane");
  assert.ok(memoryKeywords("What's the angle with Patrice Evra?").includes("patrice"));
});

test("pure chatter produces no search at all (no noise, no cost)", () => {
  for (const s of ["ok", "pull out my list", "what are my meetings tomorrow", "yes", ""]) {
    assert.deepEqual(memoryKeywords(s), [], `'${s}' should not trigger a memory search`);
  }
});

test("useful numbers survive; single characters do not", () => {
  const k = memoryKeywords("9:20 final road test 16th September");
  assert.ok(k.includes("20") && k.includes("september") && k.includes("final"));
  assert.ok(!k.includes("9"), "a lone digit is too vague to search");
});

test("the most specific (longest) word comes first, and the list is capped", () => {
  const k = memoryKeywords("sofitel ras al khaimah presentation deck pricing appendix revision");
  assert.equal(k[0], "presentation");
  assert.ok(k.length <= 6);
});

test("keywords are URL-safe tokens only (they go into a PostgREST filter)", () => {
  for (const w of memoryKeywords(`drop table; select * from x where a='b' -- "quote" (paren) |pipe| %25`)) {
    assert.match(w, /^[a-z0-9]+$/);
  }
});
