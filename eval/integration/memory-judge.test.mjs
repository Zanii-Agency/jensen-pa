// The memory judge (memory-judge.ts) picks which of his past messages the main
// model sees, by meaning. What must hold whatever the model answers:
//  - only HIS short messages can be picked (not the bot's words, not pastes,
//    not the automated briefs);
//  - the judge returns ids, and only ids of lines it was shown survive, so it can
//    never put words in his mouth;
//  - merged with keyword hits, each message appears once, newest first.
// Which model and how well it picks is measured on his real history by
// scripts/_eval-memory-judge.mts (23 Sep: Sonnet 5 14/14, keyword alone 3/7).

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { buildPool, judgeIds, mergeSaid, pickedLine } from "../../lib/concierge/memory-judge.ts";
import { memoryKeywords } from "../../lib/concierge/memory-search.ts";

const day = 864e5, t0 = Date.parse("2026-09-16T07:00:00Z");
const rows = [
  { id: 5, role: "user", ts: t0 + 4 * day, content: "no need to send me reminder again about this I already paid him" },
  { id: 4, role: "assistant", ts: t0 + 4 * day - 60e3, content: "Reminder. Send payment for DJ (reminder 5) at 16:00." },
  { id: 3, role: "assistant", ts: t0 + day, content: "Morning, Jensen. How's the head? " + "x".repeat(400) },
  { id: 2, role: "user", ts: t0 + 2 * day, content: "UPDATE MY MASTER TASK LIST " + "y".repeat(900) },
  { id: 1, role: "user", ts: t0, content: "9:20 final road test 16th September" },
];

test("the pool: his short lines are pickable, bot lines are context, pastes and briefs are left out", () => {
  const pool = buildPool(rows);
  assert.deepEqual([...pool.his.keys()].sort(), [1, 5]);
  assert.ok(pool.text.indexOf("final road test") < pool.text.indexOf("already paid him"), "oldest first");
  assert.match(pool.text, /bot: Reminder\. Send payment for DJ/);
  assert.doesNotMatch(pool.text, /\[4\]/, "a bot line has no id, so it cannot be picked");
  assert.doesNotMatch(pool.text, /Morning, Jensen/);
  assert.doesNotMatch(pool.text, /MASTER TASK LIST/);
});

test("whatever the model returns, only ids of his lines that were shown survive", async () => {
  const pool = buildPool(rows);
  const real = globalThis.fetch;
  process.env.ANTHROPIC_API_KEY ||= "test";
  let sent;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ ids: [5, 5, 4, 999, 2, 1] }) }] }), { status: 200 });
  };
  try {
    assert.deepEqual(await judgeIds("did I pay the DJ?", pool), [5, 1]); // 4 = bot line, 999 unknown, 2 = paste
    assert.deepEqual(sent.thinking, { type: "disabled" }, "thinking off: measured faster at equal accuracy");
    assert.equal(sent.output_config.format.type, "json_schema");
  } finally {
    globalThis.fetch = real;
  }
});

test("a judge failure is not an answer: it throws, and recall() falls back to keyword hits", async () => {
  // Review of PR #13: an empty or refused reply used to read as "nothing relevant"
  // and silently removed the keyword hits too.
  const real = globalThis.fetch;
  const replies = [
    new Response("overloaded", { status: 529 }),
    new Response(JSON.stringify({ stop_reason: "refusal", content: [] }), { status: 200 }),
    new Response(JSON.stringify({ stop_reason: "max_tokens", content: [{ type: "text", text: '{"ids":[5' }] }), { status: 200 }),
    new Response(JSON.stringify({ stop_reason: "end_turn", content: [] }), { status: 200 }),
    new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: "{}" }] }), { status: 200 }),
  ];
  try {
    for (const r of replies) {
      globalThis.fetch = async () => r;
      await assert.rejects(judgeIds("did I pay the DJ?", buildPool(rows)));
    }
  } finally {
    globalThis.fetch = real;
  }
});

test("small talk runs no search and no judge call", () => {
  for (const s of ["merci", "Thank you so much", "Brilliant", "Good night", "cheers", "ok thanks"]) {
    assert.deepEqual(memoryKeywords(s), [], s);
  }
});

test("merged with keyword hits: judge first, each message once, newest first, at most 4", () => {
  const m = (ts) => ({ when: String(ts), text: `line ${ts}`, ts });
  // The judge read ts 25..45: keyword hits at 30/40 are lines it turned down. Hits
  // outside its range (20 and 5 older, 50 among the newest messages it skips) count.
  assert.deepEqual(mergeSaid({ picks: [m(30)], from: 25, to: 45 }, [m(50), m(40), m(30), m(20), m(5)], 4).map((x) => x.ts), [50, 30, 20, 5]);
  // The judge picked nothing in its range: still nothing from that range.
  assert.deepEqual(mergeSaid({ picks: [], from: 25, to: 45 }, [m(40)], 4), []);
  // The judge did not run or failed (null): keyword hits stand alone.
  assert.deepEqual(mergeSaid(null, [m(1), m(2)], 4).map((x) => x.ts), [2, 1]);
});

test("a correction he made in the last few messages keeps its date (portal and WhatsApp)", () => {
  // Review of PR #13, findings 1 and 2: the original "9:30" is in the judge's range,
  // the fresh "moved to 11" is among the newest messages the judge skips. Both must show.
  const m = (ts, text) => ({ when: String(ts), text, ts });
  const judged = { picks: [m(30, "Dentist Monday at 9:30")], from: 25, to: 45 };
  const out = mergeSaid(judged, [m(60, "dentist moved to 11"), m(30, "Dentist Monday at 9:30")], 4);
  assert.deepEqual(out.map((x) => x.text), ["dentist moved to 11", "Dentist Monday at 9:30"]);
});

test("a picked line comes with what the bot answered then, so a declined request is not read as a change", () => {
  // Review of PR #13, finding 7: "can we move the Kobe lunch to 2pm?" alone made the
  // main model's "newest wins" rule state 2pm, though the answer was no.
  const t = Date.parse("2026-09-10T08:00:00Z");
  const pool = buildPool([
    { id: 21, role: "user", ts: t, content: "can we move the Kobe lunch to 2pm?" },
    { id: 22, role: "assistant", ts: t + 60e3, content: "Kobe's office says 2pm does not work for them, so lunch stays at 13:00." },
    { id: 23, role: "user", ts: t + 3600e3, content: "ok" },
    { id: 24, role: "user", ts: t + 2 * 3600e3, content: "sent the deck" },
    { id: 25, role: "assistant", ts: t + 5 * 3600e3, content: "Much later, unrelated." },
  ]);
  assert.match(pickedLine(pool, 21).text, /^can we move the Kobe lunch to 2pm\? \(my reply then: Kobe's office says 2pm does not work/);
  // No bot answer after it, or only one hours later: nothing is attached.
  assert.equal(pickedLine(pool, 23).text, "ok");
  assert.equal(pickedLine(pool, 24).text, "sent the deck");
});
