// Keyword memory that works with NO embedding key.
//
// WHY THIS EXISTS (2026-09-23): the bot's long-term memory had been effectively off
// since at least 23 June. The vector path depends on an OpenAI embed key that
// returns 401, and the "keyword fallback" searched `fact ilike *<his whole
// message>*`, so "did I tell you the time for tomorrow road test?" matched nothing,
// although he had said "9:20 final road test 16th September" on 2 Sep. The ~1,000
// facts it had saved were stored but unreachable.
//
// This searches the IMPORTANT WORDS of his message (stopwords and generic
// scheduling words dropped), fetches rows containing any of them, and ranks by how
// many distinct words each row contains, then by recency. Plain ilike, not
// Postgres full-text: measured on his data both find the right row, and ilike is
// steadier (~490ms from Dubai vs 490-1850ms), keeps substrings ("remind" hits
// "reminder"), and needs no index or DDL.
import { sbSelect, enc } from "./rest";

const STOP = new Set(
  (
    "a an the and or but if then so to of in on at for with by from up down out about into over after before " +
    "is are was were be been being am do does did done have has had i me my mine you your yours he she it its " +
    "we our they them their this that these those what which who whom whose when where why how can could would " +
    "should will shall may might must not no yes ok okay please pls thanks thank just also too very any all some " +
    "there here tell told say said give gave get got put set send sent make let know want need like one now " +
    // generic scheduling words: in nearly every message, so they rank noise first
    "today tomorrow yesterday time times meeting meetings call calls remind reminder reminders list lists " +
    "task tasks pull show check again still upcoming " +
    "will morning evening tonight week month day"
  ).split(/\s+/),
);

// The words worth searching for, longest (usually rarest) first.
export function memoryKeywords(text: string, max = 6): string[] {
  const words = String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // "Stéphane" -> "stephane" so accents never block a match
    .split(/[^a-z0-9]+/)
    .filter((w) => (/^\d+$/.test(w) ? w.length >= 2 : w.length >= 3) && !STOP.has(w));
  return [...new Set(words)].sort((a, b) => b.length - a.length).slice(0, max);
}

const fold = (s: string) => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
// Rank by distinct important words hit. A long pasted block (his "UPDATE MY MASTER
// TASK LIST" pastes run to thousands of characters) hits many words by sheer
// length, so it is demoted half a hit: a short message that names the thing
// outranks a paste that merely contains it. Ties go to the most recent.
function rank<T>(rows: T[], words: string[], textOf: (r: T) => string, timeOf?: (r: T) => number): { row: T; hits: number }[] {
  return rows
    .map((row) => {
      const t = fold(textOf(row));
      const raw = words.filter((w) => t.includes(w)).length;
      return { row, raw, hits: raw - (t.length > 400 ? 0.5 : 0) };
    })
    .filter((x) => x.raw > 0)
    .sort((a, b) => b.hits - a.hits || (timeOf ? timeOf(b.row) - timeOf(a.row) : 0))
    .map(({ row, hits }) => ({ row, hits }));
}
const anyOf = (col: string, words: string[]) => words.map((w) => `${col}.ilike.*${enc(w)}*`).join(",");

// Saved facts about his world.
export async function searchFacts(text: string, k = 6): Promise<string[]> {
  const words = memoryKeywords(text);
  if (!words.length) return [];
  const rows = await sbSelect<{ fact: string }>("brain_facts", `status=eq.active&or=(${anyOf("fact", words)})&select=fact&limit=80`).catch(() => []);
  return rank(rows, words, (r) => r.fact).slice(0, k).map((x) => x.row.fact);
}

// What HE said before, in his own words, with the date. Answers "did I tell you
// X?" and stops the bot calling something he gave it "a default". The current
// message is already saved when this runs, so anything from the last 90 seconds is
// skipped (it would only ever find itself). With 2+ words, a row must hit 2 of
// them: one generic hit is noise.
export async function searchSaid(text: string, party = "jensen", k = 3): Promise<{ when: string; text: string }[]> {
  const words = memoryKeywords(text);
  if (!words.length) return [];
  const before = Date.now() - 90_000;
  const rows = await sbSelect<{ content: string; ts: number }>(
    "chat_messages",
    `party=eq.${enc(party)}&role=eq.user&ts=lt.${before}&or=(${anyOf("content", words)})&select=content,ts&order=ts.desc&limit=100`,
  ).catch(() => []);
  // Keep a row that hits 2+ of his words, OR that contains his single most specific
  // word (the longest, usually a name: "stephane", "patrice") when it is 6+ letters.
  // "stephane I still expect the reminder" must find "remind me in two weeks to
  // message stephane", which shares only the name.
  const need = words.length >= 2 ? 2 : 1;
  const key = words[0] && words[0].length >= 6 ? words[0] : "";
  return rank(rows, words, (r) => r.content, (r) => Number(r.ts))
    .filter((x) => Math.ceil(x.hits) >= need || (key !== "" && fold(x.row.content).includes(key)))
    .slice(0, k)
    .map((x) => ({
      when: new Date(Number(x.row.ts)).toLocaleDateString("en-GB", { timeZone: "Asia/Dubai", day: "2-digit", month: "short" }),
      text: String(x.row.content).replace(/\s+/g, " ").slice(0, 220),
    }));
}

// Documents: title or text containing his important words (chunks and whole docs).
export async function searchDocs(text: string, k = 5): Promise<{ title: string; content: string }[]> {
  const words = memoryKeywords(text);
  if (!words.length) return [];
  const docs = await sbSelect<{ title: string; content: string }>(
    "docs",
    `or=(${anyOf("title", words)},${anyOf("content", words)})&select=title,content&limit=40`,
  ).catch(() => []);
  return rank(docs, words, (r) => `${r.title} ${String(r.content || "").slice(0, 4000)}`)
    .slice(0, k)
    .map((x) => ({ title: x.row.title || "document", content: String(x.row.content || "").slice(0, 600) }));
}
