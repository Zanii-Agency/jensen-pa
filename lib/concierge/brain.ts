// The concierge brain. Hybrid retrieval (vector + keyword fused by Reciprocal
// Rank Fusion), durable fact memory, salience auto-capture, grounding. Raw
// PostgREST (rest.ts) so it is deterministic on Node 20 + Vercel. Server-only.

import { sbSelect, sbInsert, sbUpdate, sbRpc, enc } from "./rest";
import { claudeJSON } from "../anthropic";
import { embed as openaiEmbed } from "../openai";

const vec = (e: number[]) => `[${e.join(",")}]`;
const RRF_K = 60;
const now = () => Date.now();

async function tryEmbed(text: string): Promise<number[] | null> {
  try {
    const [e] = await openaiEmbed([text.slice(0, 4000)]);
    return e || null;
  } catch {
    return null;
  }
}

// Structural-class assertions are claims like "X is a contact" / "X is a single
// task" / "the two events are one". They look durable but they are actually
// structured-table assertions in disguise, and the LLM has no way to verify the
// table state. We refuse them at the chokepoint and let the caller (LLM) retry
// using the proper structured tool (add_contact, create_event, etc.).
// Wall-at-primitive (KT #229): the audit fires at the only door, not at every
// caller.
const CLASS_ASSERT_RE = /\b(is|are|refers to|noted as)\s+(?:(?:a|an|one|the|two|three|single|same|separate|duplicate)\s+){1,3}(contact|contacts|task|tasks|event|events|note|notes|person|people|entity|entities)\b/i;
export function isStructuralClassAssertion(fact: string): boolean {
  return CLASS_ASSERT_RE.test(fact || "");
}

export async function rememberFact(fact: string, opts?: { source?: string; kind?: string; subject?: string }): Promise<void> {
  const f = (fact || "").trim();
  if (!f) return;
  // Wall: structural-class assertions get blocked, except directives (the
  // operator can opt in with kind=directive when the assertion is intentional).
  if (opts?.kind !== "directive" && isStructuralClassAssertion(f)) {
    throw new Error(`structural class assertion blocked: ${f.slice(0, 120)}`);
  }
  const dup = await sbSelect("brain_facts", `fact=eq.${enc(f)}&select=id&limit=1`).catch(() => []);
  if (dup.length) return;
  const e = await tryEmbed(f);
  const row: any = { fact: f, source: opts?.source ?? null, kind: opts?.kind ?? "fact", subject: opts?.subject ?? null, status: "active", created_at: now() };
  if (e) row.embedding = vec(e);
  await sbInsert("brain_facts", row);
}

// Directives = standing instructions / preferences (ChatGPT "custom instructions"
// + shorthand). Unlike facts they are ALWAYS injected, every turn, verbatim.
export async function rememberDirective(text: string): Promise<void> {
  await rememberFact(text, { kind: "directive", source: "user" });
}

// Email -> brain (so a later reference resolves: "what did Khalid email about",
// "the contract he sent"). Pure fact-formatter (testable); content is what makes
// recall useful, so we keep the body/snippet, not just the 14-word triage summary.
export function emailFactText(m: { from?: string; fromEmail?: string; subject?: string; date?: string; body?: string }): string {
  const who = [m.from, m.fromEmail && m.fromEmail !== m.from ? `<${m.fromEmail}>` : ""].filter(Boolean).join(" ");
  const when = m.date ? ` on ${m.date}` : "";
  const subj = m.subject ? ` re "${m.subject}"` : "";
  // Full awareness: keep the whole body up to the embed window (tryEmbed slices
  // to 4000), so a long contract/brief is remembered in full, not gutted to a
  // preview. zanii-codef: cap = embed cap; raise both together if we ever embed
  // longer.
  const body = String(m.body || "").replace(/\s+/g, " ").trim().slice(0, 3800);
  return `Email from ${who || "unknown sender"}${when}${subj}: ${body}`.slice(0, 4000);
}

// Persist an email the owner saw. subject-column = sender so recall by person
// works. Deduped + best-effort via rememberFact. Caller skips noise (Q4).
export async function rememberEmail(m: { from?: string; fromEmail?: string; subject?: string; date?: string; body?: string }): Promise<void> {
  const fact = emailFactText(m);
  if (fact.length < 30) return;
  await rememberFact(fact, { source: "email", subject: m.from || m.fromEmail || undefined }).catch(() => {});
}

export async function listDirectives(): Promise<string[]> {
  const rows = await sbSelect<any>("brain_facts", `status=eq.active&kind=eq.directive&order=created_at.asc&select=fact`).catch(() => []);
  return rows.map((r) => r.fact);
}

// Full memory view (facts + directives) for the /memory panel.
export async function listMemory(): Promise<{ id: number; fact: string; kind: string; subject: string | null; created_at: number }[]> {
  return sbSelect<any>("brain_facts", `status=eq.active&order=created_at.desc&limit=300&select=id,fact,kind,subject,created_at`).catch(() => []);
}
// Soft-forget: archive so recall stops grounding on it (reversible, audit-safe).
export async function forgetMemory(id: number | string): Promise<void> {
  await sbUpdate("brain_facts", `id=eq.${enc(String(id))}`, { status: "archived" });
}

export async function queryMemory(about: string, limit = 12): Promise<string[]> {
  const q = (about || "").trim();
  const rows = await sbSelect<any>(
    "brain_facts",
    `status=eq.active&or=(fact.ilike.*${enc(q)}*,subject.ilike.*${enc(q)}*)&order=created_at.desc&limit=${limit}&select=fact`
  ).catch(() => []);
  return rows.map((r) => r.fact);
}

function rrf<T>(lists: T[][], key: (t: T) => string): T[] {
  const score = new Map<string, number>();
  const item = new Map<string, T>();
  for (const list of lists) {
    list.forEach((t, i) => {
      const k = key(t);
      score.set(k, (score.get(k) || 0) + 1 / (RRF_K + i));
      if (!item.has(k)) item.set(k, t);
    });
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => item.get(k)!).filter(Boolean);
}

export type Recall = { facts: string[]; docs: { title: string; text: string }[] };

export async function recall(query: string, opts?: { factK?: number; docK?: number }): Promise<Recall> {
  const factK = opts?.factK ?? 6;
  const docK = opts?.docK ?? 5;
  const q = (query || "").trim();
  if (!q) return { facts: [], docs: [] };
  const qe = await tryEmbed(q);

  // FACTS
  const factVec: any[] = qe ? await sbRpc("match_brain_facts", { query_embedding: vec(qe), match_count: 10 }).catch(() => []) : [];
  const factKw: any[] = factK ? await sbSelect("brain_facts", `status=eq.active&fact=ilike.*${enc(q)}*&limit=10&select=fact,source`).catch(() => []) : [];
  const facts = factK ? rrf<any>([factVec, factKw], (r) => r.fact).slice(0, factK).map((r) => r.fact) : [];

  // DOCS
  const docVec: any[] = qe && docK ? await sbRpc("match_doc_chunks", { query_embedding: vec(qe), match_count: 10 }).catch(() => []) : [];
  const docKwRows: any[] = docK ? await sbSelect("doc_chunks", `text=ilike.*${enc(q)}*&limit=10&select=text,doc_id`).catch(() => []) : [];
  let titles: Record<string, string> = {};
  const ids = [...new Set(docKwRows.map((r) => r.doc_id))];
  if (ids.length) {
    const t = await sbSelect<any>("docs", `id=in.(${ids.map((i) => enc(String(i))).join(",")})&select=id,title`).catch(() => []);
    titles = Object.fromEntries(t.map((r) => [r.id, r.title]));
  }
  const docKw = docKwRows.map((r) => ({ title: titles[r.doc_id] || "document", content: r.text }));
  const docVecNorm = docVec.map((r) => ({ title: r.title, content: r.content }));
  // DOCS-TABLE FALLBACK (embed-down / no-chunks resilience, KT #349). Degraded
  // intake files docs.content with NO doc_chunks rows (KT #348), and the vector
  // path is dead whenever the OpenAI embed key is. Without this, recall is blind
  // to every recently-uploaded doc and the brain cannot ground "find my X" on it.
  // Keyword-search the docs table directly (title OR content) so content-only
  // docs still surface. Purely additive: fused as a third source; the existing
  // chunk-based ranking is unchanged.
  const docTblRows: any[] = docK ? await sbSelect<any>("docs", `or=(title.ilike.*${enc(q)}*,content.ilike.*${enc(q)}*)&limit=10&select=title,content`).catch(() => []) : [];
  const docTbl = docTblRows.map((r) => ({ title: r.title || "document", content: (r.content || "").slice(0, 600) }));
  // RRF dedup key (Class C5 sibling, KT #206558): key on TITLE + content-prefix,
  // not content-prefix alone. Two DISTINCT docs sharing a letterhead/boilerplate
  // head (common for La Rencontre invoices/letters) collided to one key and one
  // was silently dropped from grounding. Adding the title disambiguates them;
  // the same doc surfaced across arms (same title + same head) still dedups.
  const docs = docK ? rrf<any>([docVecNorm, docKw, docTbl], (r: any) => { const t = String(r?.title || "").trim(); return t && t !== "document" ? "T:" + t.toLowerCase() : "C:" + (r?.content || "").slice(0, 80); }).slice(0, docK).map((r) => ({ title: r.title, text: r.content })) : [];

  return { facts, docs };
}

const SALIENCE_SYS =
  "You extract DURABLE facts about Jensen's business world from a chat turn, for an assistant's long-term memory. " +
  "Return only stable facts worth remembering for weeks (people, venues, clients, preferences, decisions, standing context). " +
  "DO NOT capture: tasks, to-dos, one-off questions, money amounts, dates of single events, greetings, or anything transient. " +
  "DO NOT classify entities. Never write a fact of the form 'X is a contact', 'X is a single task', 'the two events are one'. Those are structured-table assertions, not durable facts. State who/what/why, not the database class. " +
  "Return JSON {facts: string[]}. Each fact one short self-contained sentence. Empty array if nothing durable.";

// Onboarding mode capture is MUCH more inclusive — we are building the deepest
// possible picture of Jensen's world, so every detail counts. People, venues,
// clients, partners, routines, preferences, constraints, ambitions, family,
// languages, time zones, instincts, fears, wins, losses — all of it. The only
// filter is "would Jensen confirm this if I read it back to him."
const SALIENCE_ONBOARDING_SYS =
  "You are building the deepest possible picture of Jensen's world from this turn. " +
  "Capture LIBERALLY: every named person, every venue, every client, every partner, every routine, every preference, every constraint, every aspiration, every detail about how he works. " +
  "Even small things: time zones, languages, family, hobbies, instincts, fears, wins, losses, what worked, what did not. " +
  "DO NOT capture greetings, weather chit-chat, or things he is clearly speculating about. The filter is 'would Jensen confirm this if I read it back to him?' " +
  "Return JSON {facts: string[]}. Each fact a short self-contained sentence in third person about Jensen or his world. Up to 8 facts. Empty array only if the turn is purely social.";

export async function captureSalience(userMsg: string, assistantReply: string, opts?: { onboarding?: boolean }): Promise<number> {
  const sys = opts?.onboarding ? SALIENCE_ONBOARDING_SYS : SALIENCE_SYS;
  const maxFacts = opts?.onboarding ? 8 : 5;
  const tokens = opts?.onboarding ? 700 : 400;
  try {
    const out = await claudeJSON<{ facts: string[] }>(sys, `User: ${userMsg}\n\nAssistant: ${assistantReply}`, tokens);
    const facts = (out?.facts ?? []).filter((f) => typeof f === "string" && f.trim().length > 8).slice(0, maxFacts);
    let written = 0;
    // Per-fact try so a class-assertion rejection on one fact does not drop the rest.
    for (const f of facts) {
      try {
        await rememberFact(f, { source: "chat", kind: opts?.onboarding ? "onboarding_fact" : "auto_fact" });
        written += 1;
      } catch { /* class-assertion or transient db error, skip this fact */ }
    }
    return written;
  } catch {
    return 0;
  }
}
