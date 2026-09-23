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

test("everyday replies produce no search at all (review: they injected noise as 'facts')", () => {
  for (const s of ["ok", "pull out my list", "what are my meetings tomorrow", "yes", "", "perfect",
                   "cancel it", "at 10?", "why didn't you remind me?", "yes go ahead", "thanks jensen", "sounds good, confirmed"]) {
    assert.deepEqual(memoryKeywords(s), [], `'${s}' should not trigger a memory search`);
  }
});

test("a message of only numbers never searches (numbers support a match, never make one)", () => {
  assert.deepEqual(memoryKeywords("10"), []);
  assert.deepEqual(memoryKeywords("9:20"), []);
});

test("useful numbers survive alongside words, after them; single characters do not", () => {
  const k = memoryKeywords("9:20 final road test 16th September");
  assert.ok(k.includes("20") && k.includes("september") && k.includes("final"));
  assert.ok(!k.includes("9"), "a lone digit is too vague to search");
  assert.ok(k.indexOf("20") > k.indexOf("september"), "words rank before numbers");
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
