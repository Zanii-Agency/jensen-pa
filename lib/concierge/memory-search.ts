// Keyword memory that works with NO embedding key.
//
// WHY THIS EXISTS (2026-09-23): the bot's long-term memory had been effectively off
// since at least 23 June. The vector path depends on an OpenAI embed key that
// returns 401, and the "keyword fallback" searched `fact ilike *<his whole
// message>*`, so "did I tell you the time for tomorrow road test?" matched nothing,
// although he had said "9:20 final road test 16th September" on 2 Sep.
//
// How it searches (each rule closes a failure found in review):
//  - Only the IMPORTANT words of his message: stopwords, contractions, chat
//    filler ("perfect", "go ahead", "cancel it") and generic scheduling words are
//    dropped, so everyday replies trigger no search and inject no noise.
//  - Whole words, not substrings: "road" must not hit "abroad", "sara" must not
//    hit "sarah" (plural/-ing/-ed endings still count).
//  - Numbers only support a match, never make one ("at 10?" must not surface
//    "AED 10,500").
//  - A first pass requires BOTH of the two most specific words, so as his data
//    grows, common words cannot crowd the relevant rows out of the fetch window.
//  - Every call has a timeout and fails soft: memory can make a reply better,
//    never slower than ~2.5s and never broken.
import { sbSelect, enc } from "./rest";

const STOP = new Set(
  (
    // grammar
    "a an the and or but if then so to of in on at for with by from up down out about into over after before " +
    "is are was were be been being am do does did done have has had i me my mine you your yours he she it its " +
    "we our they them their this that these those what which who whom whose when where why how can could would " +
    "should will shall may might must not no yes ok okay please pls just also too very any all some there here " +
    // contractions, as they split ("didn't" -> "didn")
    "didn doesn don isn wasn weren won wouldn couldn shouldn haven hasn hadn aren ain ll ve re " +
    // chat filler and acknowledgements
    "thanks thank perfect great good fine sure cool nice awesome noted sounds works right correct wrong sorry " +
    "hello hey hi dear ahead actually really maybe think know want need like one now else anything something " +
    "merci cheers bye night much lovely brilliant excellent amazing wonderful welcome appreciate appreciated " +
    // generic verbs of asking the bot to act
    "tell told say said give gave get got put set send sent make made let add added delete remove move moved " +
    "change changed update updated cancel cancelled confirm confirmed keep kept book booked mark " +
    // generic scheduling words: in nearly every message, so they rank noise first
    "today tomorrow yesterday time times meeting meetings call calls remind reminder reminders list lists " +
    "task tasks pull show check again still upcoming morning evening tonight week weeks month day days " +
    // his assistant's own names
    "jensen dorje rencontre"
  ).split(/\s+/),
);

const fold = (s: string) => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
const isNum = (w: string) => /^\d+$/.test(w);

// Two-letter words that carry the meaning of a message ("the AI workshop" vs the
// Marisa Peer workshop, a real 18 Sep mix-up). Everything else under 3 letters is
// too vague to search.
const SHORT_KEEP = new Set(["ai", "pr", "hr", "ux", "ui", "qr", "pa", "ea"]);

// The words worth searching for, most specific (longest non-number) first. Empty
// when nothing specific is left: then no search runs at all.
export function memoryKeywords(text: string, max = 6): string[] {
  const words = fold(text)
    .split(/[^a-z0-9]+/)
    .filter((w) => (isNum(w) ? w.length >= 2 : w.length >= 3 || SHORT_KEEP.has(w)) && !STOP.has(w));
  const uniq = [...new Set(words)].sort((a, b) => Number(isNum(a)) - Number(isNum(b)) || b.length - a.length);
  return uniq.some((w) => !isNum(w)) ? uniq.slice(0, max) : [];
}

// Whole word, allowing common endings (plural, -ed, -ing, -er): "test" hits
// "tests" and "testing" but never "latest".
function hitsWord(text: string, w: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${w}(s|es|ed|ing|er|ers)?([^a-z0-9]|$)`).test(text);
}
// Score = specific words hit, numbers half a point. Long pastes (a 3,000-char
// "UPDATE MY MASTER TASK LIST") hit many words by sheer length: minus half.
function score(text: string, words: string[]): { hits: number; words: number } {
  const t = fold(text);
  let hits = 0, wordHits = 0;
  for (const w of words) if (hitsWord(t, w)) { hits += isNum(w) ? 0.5 : 1; if (!isNum(w)) wordHits++; }
  return { hits: hits - (t.length > 400 ? 0.5 : 0), words: wordHits };
}

export const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([p.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
const ilikes = (col: string, words: string[]) => words.map((w) => `${col}.ilike.*${enc(w)}*`).join(",");

// Two passes: rows containing BOTH top words first (precise, and never crowded out
// as data grows), then rows containing any word. Merged, de-duplicated by key.
async function fetchTwoPass<T>(table: string, cols: string[], select: string, words: string[], extra: string, limit: number, keyOf: (r: T) => string): Promise<T[]> {
  const specific = words.filter((w) => !isNum(w));
  const both = specific.length >= 2
    ? cols.map((c) => sbSelect<T>(table, `${extra}and=(${ilikes(c, specific.slice(0, 2))})&select=${select}&limit=${limit}`).catch(() => [] as T[]))
    : [];
  const any = sbSelect<T>(table, `${extra}or=(${cols.map((c) => ilikes(c, words)).join(",")})&select=${select}&limit=${limit}`).catch(() => [] as T[]);
  const seen = new Set<string>();
  const out: T[] = [];
  for (const batch of await Promise.all([...both, any])) for (const r of batch) { const k = keyOf(r); if (!seen.has(k)) { seen.add(k); out.push(r); } }
  return out;
}

// Saved facts, with where each came from. Labelling happens in recall(), AFTER the
// keyword and vector results are merged, so a fact from a third party's email is
// never presented as something he said, whichever search found it. Ties go to the
// newest fact, so of two conflicting facts the more recent one leads.
export type FoundFact = { fact: string; label: "" | "email" | "older" };
export async function searchFacts(text: string, k = 6): Promise<FoundFact[]> {
  const words = memoryKeywords(text);
  if (!words.length) return [];
  return withTimeout((async () => {
    const rows = await fetchTwoPass<{ fact: string; kind: string; source: string; created_at: string }>(
      "brain_facts", ["fact"], "fact,kind,source,created_at", words, "status=eq.active&", 60, (r) => r.fact,
    );
    return rows
      .map((r) => ({ r, s: score(r.fact, words) }))
      .filter((x) => x.s.words > 0)
      .sort((a, b) => b.s.hits - a.s.hits || String(b.r.created_at).localeCompare(String(a.r.created_at)))
      .slice(0, k)
      .map(({ r }): FoundFact => ({ fact: r.fact, label: r.source === "email" ? "email" : r.kind === "archive_fact" ? "older" : "" }));
  })(), 2500, [] as FoundFact[]);
}
export function labelFact(f: FoundFact): string {
  return f.label === "email" ? `[from an email he received, unverified] ${f.fact}` : f.label === "older" ? `[older note] ${f.fact}` : f.fact;
}

// What HE said before, in his own words, dated, NEWEST FIRST. Only short messages
// (pastes and pasted emails are not statements he made). The current message is
// already saved when this runs, so the last 90 seconds are skipped. A message must
// hit 2 specific words, or contain his single most specific word when that is 5+
// letters (usually a name: "stephane", "patrice").
// One past message as the main model sees it. `ts` lets recall() merge and order
// these with the memory judge's picks (memory-judge.ts).
export function saidLine(r: { content: string; ts: number }): { when: string; text: string; ts: number } {
  return {
    when: new Date(Number(r.ts)).toLocaleDateString("en-GB", { timeZone: "Asia/Dubai", weekday: "short", day: "numeric", month: "short", year: "numeric" }),
    text: String(r.content).replace(/\s+/g, " ").slice(0, 220),
    ts: Number(r.ts),
  };
}

export async function searchSaid(text: string, party = "jensen", k = 3): Promise<{ when: string; text: string; ts: number }[]> {
  const words = memoryKeywords(text);
  if (!words.length) return [];
  return withTimeout((async () => {
    const rows = await fetchTwoPass<{ content: string; ts: number }>(
      "chat_messages", ["content"], "content,ts", words,
      `party=eq.${enc(party)}&role=eq.user&ts=lt.${Date.now() - 90_000}&order=ts.desc&`, 100, (r) => `${r.ts}`,
    );
    return pickSaid(rows, words, k).map(saidLine);
  })(), 2500, [] as { when: string; text: string; ts: number }[]);
}

// The ranking behind searchSaid, pure so it can be tested without a database.
// TIERED: messages that hit 2+ of his words come first (newest first among them);
// messages that only share his single most specific word fill any slots left.
// Sorting everything by date alone let "final invoice" / "final menu" (newer, one
// shared word) push out "9:20 final road test" (review round 2 blocker).
export function pickSaid<R extends { content: string; ts: number }>(rows: R[], words: string[], k = 3): R[] {
  const key = words[0] && !isNum(words[0]) && words[0].length >= 5 ? words[0] : "";
  const scored = rows
    .filter((r) => String(r.content || "").length <= 800)
    .map((r) => ({ r, s: score(r.content, words) }));
  const newest = (a: { r: R }, b: { r: R }) => Number(b.r.ts) - Number(a.r.ts);
  const strong = scored.filter((x) => x.s.words >= 2).sort(newest);
  const keyOnly = scored.filter((x) => x.s.words < 2 && key !== "" && hitsWord(fold(x.r.content), key)).sort(newest);
  return [...strong, ...keyOnly].slice(0, k).map((x) => x.r);
}

// Documents: title or text containing his important words.
export async function searchDocs(text: string, k = 5): Promise<{ title: string; content: string }[]> {
  const words = memoryKeywords(text);
  if (!words.length) return [];
  return withTimeout((async () => {
    const docs = await fetchTwoPass<{ title: string; content: string }>(
      "docs", ["title", "content"], "title,content", words, "", 40, (r) => `${r.title}|${String(r.content || "").slice(0, 60)}`,
    );
    return docs
      .map((r) => ({ r, s: score(`${r.title} ${String(r.content || "").slice(0, 4000)}`, words) }))
      .filter((x) => x.s.words > 0)
      .sort((a, b) => b.s.hits - a.s.hits)
      .slice(0, k)
      .map(({ r }) => ({ title: r.title || "document", content: String(r.content || "").slice(0, 600) }));
  })(), 2500, [] as { title: string; content: string }[]);
}
