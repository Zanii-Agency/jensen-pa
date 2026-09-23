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

import { buildPool, judgeIds, mergeSaid } from "../../lib/concierge/memory-judge.ts";

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
    return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ ids: [5, 5, 4, 999, 2, 1] }) }] }), { status: 200 });
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
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response("overloaded", { status: 529 });
  try {
    await assert.rejects(judgeIds("did I pay the DJ?", buildPool(rows)));
  } finally {
    globalThis.fetch = real;
  }
});

test("merged with keyword hits: judge first, each message once, newest first, at most 4", () => {
  const m = (ts) => ({ when: String(ts), text: `line ${ts}`, ts });
  // The judge read everything from ts 25 on: keyword hits at 30/40/50 are lines it
  // turned down, so only the older ones (20, 5) may fill the spare slots.
  assert.deepEqual(mergeSaid({ picks: [m(30)], coveredSince: 25 }, [m(50), m(40), m(30), m(20), m(5)], 4).map((x) => x.ts), [30, 20, 5]);
  // The judge picked nothing in its range: still nothing from that range.
  assert.deepEqual(mergeSaid({ picks: [], coveredSince: 25 }, [m(40)], 4), []);
  // The judge did not run or failed (null): keyword hits stand alone.
  assert.deepEqual(mergeSaid(null, [m(1), m(2)], 4).map((x) => x.ts), [2, 1]);
});
