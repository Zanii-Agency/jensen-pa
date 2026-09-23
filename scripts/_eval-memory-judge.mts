// Which model should judge memory, measured on Jensen's real history.
//   set -a && . ./.env.prod && set +a && npx tsx scripts/_eval-memory-judge.mts
//
// Read-only: reads his chat_messages, writes nothing, sends nothing. Calls the
// Anthropic API (Jensen's key, a few dollars at most). Two planted lines (the
// Sohum correction) exist only in memory, never in the database.
for (const k of Object.keys(process.env)) { const v = process.env[k]; if (v && /\\n$/.test(v)) process.env[k] = v.replace(/\\n$/, "").replace(/^"|"$/g, ""); }
const { sbSelect } = await import("../lib/concierge/rest");
const { buildPool, judgeIds } = await import("../lib/concierge/memory-judge");
const { memoryKeywords, pickSaid } = await import("../lib/concierge/memory-search");

const rows: any[] = await sbSelect("chat_messages", `party=eq.jensen&role=in.(user,assistant)&select=id,role,ts,content&order=ts.desc&limit=${process.env.EVAL_ROWS || 430}`);
const T0 = Date.now() - 4 * 864e5;
rows.push(
  { id: 9000001, role: "user", ts: T0, content: "Sohum tasting menu review is Friday at 16:00" },
  { id: 9000002, role: "assistant", ts: T0 + 60e3, content: "Noted. Friday at 16:00 for the Sohum tasting menu review." },
  { id: 9000003, role: "user", ts: T0 + 864e5, content: "they moved it, now 18:30" },
);
const pool = buildPool(rows);

// need: every id must be picked. never: none may be. empty: nothing may be picked.
const CASES: { q: string; need: number[]; never?: number[]; empty?: boolean }[] = [
  { q: "did I pay the DJ?", need: [5264] },                               // "I already paid him": no shared word
  { q: "when is my driving exam?", need: [5008] },                        // "final road test": no shared word
  { q: "what time is the tasting menu review?", need: [9000003, 9000001] }, // the change never names it
  { q: "any update on messaging Stéphane?", need: [5410, 5443] },
  { q: "is the Sheryl meeting still at 2?", need: [4837] },
  { q: "what's a good gift for a 5 year old?", need: [], empty: true },
  { q: "can you move my 3pm today to 4pm?", need: [], never: [4837] },   // shares "3pm" with an old, unrelated meeting
];
// A case whose line is older than the pool becomes a "nothing to find" case: the
// right answer is then an empty list, never some other line.
for (const c of CASES) if (c.need.some((id) => !pool.his.has(id))) { console.log(`note: "${c.q}" line not in the pool: expecting nothing`); c.never = [...(c.never ?? []), ...c.need]; c.need = []; c.empty = true; }

const score = (c: (typeof CASES)[number], ids: number[]) =>
  c.need.every((id) => ids.includes(id)) && !(c.never ?? []).some((id) => ids.includes(id)) && (!c.empty || ids.length === 0);

console.log(`pool: ${pool.his.size} of his lines, ~${Math.round(pool.text.length / 4)} tokens\n`);
const hisRows = [...pool.his.values()];
let kw = 0;
for (const c of CASES) { const ids = pickSaid(hisRows, memoryKeywords(c.q), 3).map((r: any) => r.id); if (score(c, ids)) kw++; }
console.log(`keyword search (today): ${kw}/${CASES.length}`);

const RUNS = (process.env.EVAL_RUNS || "claude-haiku-4-5,claude-sonnet-5,claude-opus-5").split(",");
for (const spec of RUNS) {
  const [model, mode] = spec.split(":"); const think = mode !== "nothink";
  let pass = 0; const ms: number[] = []; const misses: string[] = [];
  for (const c of CASES) for (let run = 0; run < 2; run++) {
    const t = Date.now();
    let ids: number[] = [];
    try { ids = await judgeIds(c.q, pool, model, 4, think); } catch (e: any) { misses.push(`${c.q} -> ERROR ${e?.message}`); }
    ms.push(Date.now() - t);
    if (score(c, ids)) pass++; else misses.push(`${c.q} -> [${ids.join(",")}]`);
  }
  ms.sort((a, b) => a - b);
  console.log(`\n${spec}: ${pass}/${CASES.length * 2} right, median ${ms[Math.floor(ms.length / 2)]}ms, slowest ${ms[ms.length - 1]}ms`);
  for (const m of [...new Set(misses)]) console.log(`   miss: ${m}`);
}
