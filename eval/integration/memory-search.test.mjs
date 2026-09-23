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

// ---- ranking (review round 2 blocker): the relevant message must not be pushed out ----
import { pickSaid } from "../../lib/concierge/memory-search.ts";
const day = 86_400_000, T = 1_790_000_000_000;
const row = (daysAgo, content) => ({ ts: T - daysAgo * day, content });

test("3 NEWER messages that share only one common word never push out the real match", () => {
  const words = memoryKeywords("what time is my final road test?"); // final, road, test
  const rows = [
    row(21, "9:20 final road test 16th September give me a reminder the day before"),
    row(13, "road test moved to 11:00"),
    row(4, "send the final invoice to Sohum"),
    row(3, "final menu for Upaya is approved"),
    row(1, "use the final version of the deck"),
  ];
  const got = pickSaid(rows, words, 3).map((r) => r.content);
  assert.equal(got[0], "road test moved to 11:00", "the newest message that is actually about the road test comes first");
  assert.equal(got[1], "9:20 final road test 16th September give me a reminder the day before");
  assert.ok(!got.slice(0, 2).some((c) => /invoice|menu|deck/.test(c)), "one-word noise never outranks a real match");
});

test("a name alone still finds him, when no message shares two words", () => {
  const words = memoryKeywords("stephane I still expect the reminder"); // stephane, expect
  const got = pickSaid([row(2, "remind me in two weeks to message stephane"), row(1, "lunch with marc")], words, 3);
  assert.deepEqual(got.map((r) => r.content), ["remind me in two weeks to message stephane"]);
});

test("the AI workshop keeps its most important word", () => {
  assert.ok(memoryKeywords("what time is the AI workshop?").includes("ai"));
  const words = memoryKeywords("what time is the AI workshop?");
  const got = pickSaid([row(5, "payment link for the AI workshop"), row(1, "Marisa Peer workshop on 10 October")], words, 3);
  assert.equal(got[0].content, "payment link for the AI workshop", "both words beat the newer one-word match");
});

test("pastes and pasted emails are never 'things he said'", () => {
  const long = "UPDATE MY MASTER TASK LIST ".repeat(40) + " road test";
  assert.equal(pickSaid([row(1, long)], ["road", "test"], 3).length, 0);
});
