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

// The words worth searching for, most specific (longest non-number) first. Empty
// when nothing specific is left: then no search runs at all.
export function memoryKeywords(text: string, max = 6): string[] {
  const words = fold(text)
    .split(/[^a-z0-9]+/)
    .filter((w) => (isNum(w) ? w.length >= 2 : w.length >= 3) && !STOP.has(w));
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

const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
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

// Saved facts. Facts that came from a third party's email are labelled so they are
// never presented as something he said; facts from his old ChatGPT export are
// labelled as older notes (they may be out of date).
export async function searchFacts(text: string, k = 6): Promise<string[]> {
  const words = memoryKeywords(text);
  if (!words.length) return [];
  return withTimeout((async () => {
    const rows = await fetchTwoPass<{ fact: string; kind: string; source: string }>(
      "brain_facts", ["fact"], "fact,kind,source", words, "status=eq.active&", 60, (r) => r.fact,
    );
    return rows
      .map((r) => ({ r, s: score(r.fact, words) }))
      .filter((x) => x.s.words > 0)
      .sort((a, b) => b.s.hits - a.s.hits)
      .slice(0, k)
      .map(({ r }) =>
        r.source === "email" ? `[from an email he received, unverified] ${r.fact}`
        : r.kind === "archive_fact" ? `[older note] ${r.fact}`
        : r.fact);
  })(), 2500, [] as string[]);
}

// What HE said before, in his own words, dated, NEWEST FIRST. Only short messages
// (pastes and pasted emails are not statements he made). The current message is
// already saved when this runs, so the last 90 seconds are skipped. A message must
// hit 2 specific words, or contain his single most specific word when that is 5+
// letters (usually a name: "stephane", "patrice").
export async function searchSaid(text: string, party = "jensen", k = 3): Promise<{ when: string; text: string }[]> {
  const words = memoryKeywords(text);
  if (!words.length) return [];
  const key = words[0] && !isNum(words[0]) && words[0].length >= 5 ? words[0] : "";
  return withTimeout((async () => {
    const rows = await fetchTwoPass<{ content: string; ts: number }>(
      "chat_messages", ["content"], "content,ts", words,
      `party=eq.${enc(party)}&role=eq.user&ts=lt.${Date.now() - 90_000}&order=ts.desc&`, 100, (r) => `${r.ts}`,
    );
    return rows
      .filter((r) => String(r.content || "").length <= 800)
      .map((r) => ({ r, s: score(r.content, words) }))
      .filter((x) => x.s.words >= 2 || (key !== "" && hitsWord(fold(x.r.content), key)))
      .sort((a, b) => Number(b.r.ts) - Number(a.r.ts))
      .slice(0, k)
      .map(({ r }) => ({
        when: new Date(Number(r.ts)).toLocaleDateString("en-GB", { timeZone: "Asia/Dubai", weekday: "short", day: "numeric", month: "short", year: "numeric" }),
        text: String(r.content).replace(/\s+/g, " ").slice(0, 220),
      }));
  })(), 2500, [] as { when: string; text: string }[]);
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
