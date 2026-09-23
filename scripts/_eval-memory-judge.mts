// Memory recall measured on Jensen's real history, shaped like production.
//   set -a && . ./.env.prod && set +a && npx tsx scripts/_eval-memory-judge.mts
//   EVAL_RUNS="claude-sonnet-5:nothink,claude-opus-5:nothink" EVAL_REPEAT=3 ...
//
// Read-only: reads his chat_messages, writes nothing, sends nothing. Calls the
// Anthropic API (Jensen's key, a few dollars at most). Planted lines exist only in
// memory, never in the database.
//
// Shaped like production (review of PR #13): the newest 30 messages are the chat
// window the judge skips; it reads the 400 before that; keyword search covers his
// whole history; what is SCORED is the merged list the main model sees. None of
// the answers appear in the judge's prompt.
for (const k of Object.keys(process.env)) { const v = process.env[k]; if (v && /\\n$/.test(v)) process.env[k] = v.replace(/\\n$/, "").replace(/^"|"$/g, ""); }
const { sbSelect } = await import("../lib/concierge/rest");
const { buildPool, judgeIds, mergeSaid, pickedLine } = await import("../lib/concierge/memory-judge");
const { memoryKeywords, pickSaid } = await import("../lib/concierge/memory-search");

const all: any[] = await sbSelect("chat_messages", "party=eq.jensen&role=in.(user,assistant)&select=id,role,ts,content&order=ts.desc&limit=1500");
const poolRows = all.slice(30, 430);
const poolFrom = Number(poolRows[poolRows.length - 1].ts), poolTo = Number(poolRows[0].ts);
const inPool = (days: number) => poolTo - days * 864e5; // days before the newest row the judge reads
const now = Date.now();

// Planted: a correction that never names its topic; a request the bot's reply
// shows did not happen; a fresh change inside the chat window.
const planted = [
  { id: 9000001, role: "user", ts: inPool(3), content: "Sohum tasting menu review is Friday at 16:00" },
  { id: 9000002, role: "assistant", ts: inPool(3) + 60e3, content: "Noted. Friday at 16:00 for the Sohum tasting menu review." },
  { id: 9000003, role: "user", ts: inPool(2), content: "they pushed it to 18:30" },
  { id: 9000011, role: "user", ts: inPool(6), content: "can we move the Kobe lunch to 2pm?" },
  { id: 9000012, role: "assistant", ts: inPool(6) + 60e3, content: "Kobe's office says 2pm does not work for them, so lunch stays at 13:00." },
  { id: 9000021, role: "user", ts: inPool(5), content: "Dentist appointment Monday at 9:30" },
  { id: 9000022, role: "user", ts: now - 3600e3, content: "dentist moved to 11" }, // in the window, newer than the judge's range
  // The realistic shape of a change (same as the real DJ thread): a reply to the reminder.
  { id: 9000031, role: "user", ts: inPool(9), content: "Pitch rehearsal with Omar Thursday 15:00" },
  { id: 9000032, role: "assistant", ts: inPool(8), content: "Reminder. Pitch rehearsal with Omar at 15:00." },
  { id: 9000033, role: "user", ts: inPool(8) + 90e3, content: "he pushed it to 17:00" },
];
const pool = buildPool([...poolRows, ...planted.filter((p) => p.ts <= poolTo)]);
const corpus = [...all, ...planted].filter((r) => r.role === "user");

const CASES: { q: string; need: number[]; never?: number[]; empty?: boolean }[] = [
  { q: "did I pay the DJ?", need: [5264] },                                  // "I already paid him": no shared word
  { q: "when is my driving exam?", need: [5008] },                           // "final road test": no shared word
  { q: "what time is the tasting menu review?", need: [9000001, 9000003] },  // HARD: change a day later, no topic, no context
  { q: "when is the rehearsal with Omar?", need: [9000031, 9000033] },       // change as a reply to the reminder
  { q: "what time is the dentist?", need: [9000022, 9000021] },              // fresh change in the window keeps its date
  { q: "any update on messaging Stéphane?", need: [5410, 5443] },
  { q: "is the Nimiri meeting still at 2?", need: [4877] },                  // older than the judge's range: keyword's job
  { q: "what's a good gift for a 5 year old?", need: [], empty: true },
  { q: "can you move my 3pm today to 4pm?", need: [], never: [4837] },       // shares "3pm" with an old, unrelated meeting
  { q: "what time is lunch with Kobe?", need: [] },                          // a declined request: see the check below
];
// If the declined request is shown, its outcome must come with it.
const outcomeShown = (text: string) => !/move the Kobe lunch/.test(text) || /does not work/.test(text);

const byTs = new Map(corpus.map((r) => [Number(r.ts), r.id]));
const said = (r: any) => ({ when: "", text: r.content, ts: Number(r.ts) });
const keywordFor = (q: string) => pickSaid(corpus, memoryKeywords(q), 3).map(said);
const idsOf = (list: { ts: number }[]) => list.map((x) => byTs.get(x.ts));
const score = (c: (typeof CASES)[number], ids: any[]) =>
  c.need.every((id) => ids.includes(id)) && !(c.never ?? []).some((id) => ids.includes(id)) && (!c.empty || ids.length === 0);

console.log(`window 30, judge reads ${pool.his.size} of his lines (~${Math.round(pool.text.length / 4)} tokens), corpus ${corpus.length} of his lines\n`);
let kw = 0; const kwMiss: string[] = [];
for (const c of CASES) { const ids = idsOf(mergeSaid(null, keywordFor(c.q), 4)); if (score(c, ids)) kw++; else kwMiss.push(`${c.q} -> [${ids.join(",")}]`); }
console.log(`keyword only (live today): ${kw}/${CASES.length}`);
for (const m of kwMiss) console.log(`   miss: ${m}`);

const REPEAT = Number(process.env.EVAL_REPEAT || 2);
if (process.env.EVAL_ONLY) CASES.splice(0, CASES.length, ...CASES.filter((c) => process.env.EVAL_ONLY!.split("|").some((q) => c.q.startsWith(q))));
for (const spec of (process.env.EVAL_RUNS || "claude-sonnet-5:nothink").split(",")) {
  const [model, mode] = spec.split(":"); const think = mode !== "nothink";
  let pass = 0; const ms: number[] = []; const misses: string[] = [];
  for (const c of CASES) for (let run = 0; run < REPEAT; run++) {
    const t = Date.now();
    let picks: number[] = [], failed = false;
    try { picks = await judgeIds(c.q, pool, model, 4, think); } catch (e: any) { failed = true; misses.push(`${c.q} -> judge failed (${e?.message}), keyword only`); }
    ms.push(Date.now() - t);
    const judged = failed ? null : { picks: picks.map((id) => pickedLine(pool, id)), from: poolFrom, to: poolTo };
    const merged = mergeSaid(judged, keywordFor(c.q), 4);
    const ids = idsOf(merged);
    const ok = score(c, ids) && merged.every((m) => outcomeShown(m.text));
    if (ok) pass++; else misses.push(`${c.q} -> judge [${picks.join(",")}], merged [${ids.join(",")}]${merged.some((m) => !outcomeShown(m.text)) ? " (request shown without its outcome)" : ""}`);
  }
  ms.sort((a, b) => a - b);
  console.log(`\njudge + keyword, ${spec}: ${pass}/${CASES.length * REPEAT} right, judge median ${ms[Math.floor(ms.length / 2)]}ms, slowest ${ms[ms.length - 1]}ms`);
  for (const m of [...new Set(misses)]) console.log(`   miss: ${m}`);
}
