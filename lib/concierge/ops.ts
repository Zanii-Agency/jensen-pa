// Granular data operations for the concierge tools. Raw PostgREST (see rest.ts)
// so it works on Node 20 and Vercel alike. One row per call. Server-only.

import { sbSelect, sbInsert, sbUpsert, sbUpdate, sbDelete, enc } from "./rest";
import { dubaiToday, dubaiHHMM } from "../time";
import { kvGet, kvSet } from "../db";

// ---------- PENDING MEETING-TASK PROPOSAL (Digital Jensen wrap-up) ----------
// Tasks a finished meeting proposed but Jensen has NOT yet accepted. Stored in
// kv (single-tenant, one Jensen) so /api/ingest can park them and the brain can
// create them deterministically from THIS list when he accepts. KT #206574.
const PENDING_MEETING_TASKS_KEY = "lr_pending_meeting_tasks";
export type PendingMeetingTasks = { title: string; proposedAt: number; tasks: { title: string; quadrant: number }[] };
export async function setPendingMeetingTasks(p: PendingMeetingTasks): Promise<void> {
  await kvSet(PENDING_MEETING_TASKS_KEY, p);
}
export async function getPendingMeetingTasks(): Promise<PendingMeetingTasks | null> {
  return kvGet<PendingMeetingTasks | null>(PENDING_MEETING_TASKS_KEY, null).catch(() => null);
}
export async function clearPendingMeetingTasks(): Promise<void> {
  await kvSet(PENDING_MEETING_TASKS_KEY, null).catch(() => {});
}

// Tag each calendar row with a derived status so the LLM never has to compare
// time strings against "now" when rendering Jensen's board. Past items must
// never be rendered as upcoming (bug repro 2026-06-12 11:47: "10:35 Call to
// set driving test" rendered as if it were still coming up). Field is the
// source of truth — model is told (in loop.ts) to trust `status` and not
// recompute. NOW_WINDOW_MIN keeps items within the next hour highlighted as
// live so Jensen sees what is happening this minute.
const NOW_WINDOW_MIN = 60;
type EventStatus = "past" | "now" | "upcoming";
function tagEventStatus(row: any, today: string, nowHHMM: string): any {
  const d: string = row.date || "";
  const t: string = row.time || "";
  let status: EventStatus = "upcoming";
  if (d && d < today) status = "past";
  else if (d && d > today) status = "upcoming";
  else if (d === today) {
    if (!t) status = "upcoming";
    else if (t < nowHHMM) status = "past";
    else {
      const [nh, nm] = nowHHMM.split(":").map(Number);
      const [eh, em] = t.split(":").map(Number);
      const diff = (eh * 60 + em) - (nh * 60 + nm);
      status = diff >= 0 && diff <= NOW_WINDOW_MIN ? "now" : "upcoming";
    }
  }
  return { ...row, status };
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
const now = () => Date.now();
const like = (v: string) => `ilike.*${enc(v)}*`;

// ---------- ENTITIES ----------
export async function listEntities(f: { kind?: string; status?: string } = {}) {
  let qs = "order=created_at.asc";
  if (f.kind) qs += `&kind=eq.${enc(f.kind)}`;
  if (f.status) qs += `&status=${like(f.status)}`;
  return sbSelect("entities", qs);
}
export async function findEntity(name: string) { return sbSelect("entities", `name=${like(name)}&limit=5`); }
// Normalized identity key for people/entities: lowercase, strip punctuation,
// collapse spaces. EXACT match only — "Karafotias" == "karafotias" but NOT a
// spelling variant ("Jatin" vs "Jhatin"), which would risk merging two real people.
export function normalizeName(s: string): string {
  return (s || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
}

// Pure dedup decision for contacts (testable). The id of the SINGLE existing
// same-name contact whose identity is COMPATIBLE (no conflicting email/phone), or
// null. Conflicting identity (different email/phone) or ambiguity -> null (insert
// new; never merge two distinct people who share a name).
export function pickContactDup(
  existing: { id: string; name: string; email?: string | null; phone?: string | null }[],
  name: string,
  email?: string | null,
  phone?: string | null,
): string | null {
  const key = normalizeName(name);
  if (!key) return null;
  const e = (email || "").toLowerCase().trim();
  const p = (phone || "").replace(/\D/g, "");
  // Skeptic CRITICAL: a same-NAME match is NOT enough to merge — two different
  // people share a first name (Ahmed the driver vs Ahmed the supplier), both
  // blank, would be wrong-merged. Require a POSITIVE shared identity signal
  // (matching email or phone). Name-only collisions insert a new row (a harmless
  // extra the owner can merge), never a silent wrong-merge.
  if (!e && !p) return null;
  const confirmed = (existing || []).filter((c) => {
    if (normalizeName(c.name) !== key) return false;
    const ce = (c.email || "").toLowerCase().trim();
    const cp = (c.phone || "").replace(/\D/g, "");
    return (!!e && ce === e) || (!!p && cp === p);
  });
  return confirmed.length === 1 ? confirmed[0].id : null;
}

export async function createEntity(i: { kind: string; name: string; subtitle?: string; status?: string; notes?: string }) {
  // No auto-dedup here (skeptic CRITICAL): entities have no secondary identity
  // signal, so name-only merge would silently alias two distinct same-named orgs
  // ("A&B Catering" vs "AB Catering", two clients named "Sohum"). findEntity lets
  // the model look up first; a real duplicate is a human-confirmed merge, not a
  // silent one. Insert-only is the safe choice (an extra row beats a wrong-merge).
  const row = { id: uid(), kind: i.kind, name: i.name, subtitle: i.subtitle ?? null, status: i.status ?? null, notes: i.notes ?? null, created_at: now() };
  await sbInsert("entities", row);
  return { id: row.id, kind: i.kind, name: i.name };
}
export async function updateEntity(i: any) {
  const patch: any = {};
  for (const k of ["name", "subtitle", "status", "notes"]) if (i[k] !== undefined) patch[k] = i[k];
  await sbUpdate("entities", `id=eq.${enc(i.id)}`, patch);
  return { id: i.id, updated: Object.keys(patch) };
}
export async function deleteEntity(id: string) { await sbDelete("entities", `id=eq.${enc(id)}`); return { deleted: id }; }

// ---------- TASKS ----------
export async function listTasks(f: { quadrant?: number; entityId?: string; done?: boolean } = {}) {
  let qs = "order=created_at.desc";
  if (f.quadrant) qs += `&quadrant=eq.${f.quadrant}`;
  if (f.entityId) qs += `&entity_id=eq.${enc(f.entityId)}`;
  if (f.done !== undefined) qs += `&done=is.${f.done}`;
  return sbSelect("tasks", qs);
}
export async function createTask(i: { title: string; quadrant?: number; entityId?: string; due?: string }) {
  const q = [1, 2, 3, 4].includes(i.quadrant as any) ? i.quadrant : 2;
  // Soft-dedup: never create a duplicate of an existing open task (Memorae's worst bug).
  const dup = await sbSelect<any>("tasks", `title=eq.${enc(i.title)}&done=is.false&select=id,quadrant&limit=1`).catch((e) => { console.warn(`createTask dedup query failed (inserting anyway, may duplicate): ${String(e?.message || e).slice(0, 160)}`); return []; });
  if (dup.length) return { id: dup[0].id, title: i.title, quadrant: dup[0].quadrant, deduped: true };
  const row = { id: uid(), title: i.title, quadrant: q, entity_id: i.entityId ?? null, done: false, due: i.due ?? null, created_at: now() };
  await sbInsert("tasks", row);
  return { id: row.id, title: i.title, quadrant: q };
}
export async function updateTask(i: any) {
  const patch: any = {};
  for (const k of ["title", "quadrant", "due", "done"]) if (i[k] !== undefined) patch[k] = i[k];
  await sbUpdate("tasks", `id=eq.${enc(i.id)}`, patch);
  return { id: i.id, updated: Object.keys(patch) };
}
export async function deleteTask(id: string) { await sbDelete("tasks", `id=eq.${enc(id)}`); return { deleted: id }; }

// ---------- FINANCE ----------
export async function listFinance(f: { entityId?: string; kind?: string } = {}) {
  let qs = "order=date.desc";
  if (f.entityId) qs += `&entity_id=eq.${enc(f.entityId)}`;
  if (f.kind) qs += `&kind=eq.${enc(f.kind)}`;
  return sbSelect("finance", qs);
}
export async function recordFinance(i: { kind: "income" | "expense"; amount: number; vatApplies?: boolean; label: string; date?: string; entityId?: string; receiptUrl?: string; source?: "manual" | "receipt" | "recurring" }) {
  const row = { id: uid(), kind: i.kind === "income" ? "income" : "expense", amount: Number(i.amount) || 0, vat_applies: !!i.vatApplies, label: i.label, date: i.date || dubaiToday(), entity_id: i.entityId ?? null, source: i.source ?? "manual", receipt_url: i.receiptUrl ?? null, created_at: now() };
  await sbInsert("finance", row);
  return { id: row.id, kind: row.kind, amount: row.amount, label: row.label, date: row.date };
}
export async function updateFinance(i: any) {
  const patch: any = {};
  if (i.amount !== undefined) patch.amount = i.amount;
  if (i.label !== undefined) patch.label = i.label;
  if (i.vatApplies !== undefined) patch.vat_applies = i.vatApplies;
  if (i.date !== undefined) patch.date = i.date;
  await sbUpdate("finance", `id=eq.${enc(i.id)}`, patch);
  return { id: i.id, updated: Object.keys(patch) };
}
export async function deleteFinance(id: string) { await sbDelete("finance", `id=eq.${enc(id)}`); return { deleted: id }; }

// ---------- EVENTS ----------
export async function queryCalendar(f: { from?: string; to?: string; entityId?: string } = {}) {
  let qs = "order=date.asc";
  if (f.from) qs += `&date=gte.${enc(f.from)}`;
  if (f.to) qs += `&date=lte.${enc(f.to)}`;
  if (f.entityId) qs += `&entity_id=eq.${enc(f.entityId)}`;
  const rows = await sbSelect<any>("events", qs);
  const today = dubaiToday();
  const nowHHMM = dubaiHHMM();
  return rows.map((r: any) => tagEventStatus(r, today, nowHHMM));
}

// Date-bounded activity for ONE Dubai day. Wall-at-primitive (same shape as the
// EVENT STATUS calendar wall, KT #229/#243): the runtime returns the real dated
// rows so the model never INFERS which day things happened on. Fixes the
// "summarize yesterday" bug where mixed-date scrollback got stamped with one day.
export async function dayLog(date: string) {
  const dateISO = (date || "").slice(0, 10);
  const start = Date.parse(`${dateISO}T00:00:00+04:00`); // Dubai midnight -> epoch ms
  if (Number.isNaN(start)) return { date: dateISO, error: "invalid date, expected YYYY-MM-DD" };
  const end = start + 86_400_000;
  const [msgs, events, tasks] = await Promise.all([
    sbSelect<any>("chat_messages", `party=eq.jensen&ts=gte.${start}&ts=lt.${end}&order=ts.asc&select=role,content,ts&limit=200`).catch(() => []),
    sbSelect<any>("events", `date=eq.${enc(dateISO)}&order=time.asc&select=time,title`).catch(() => []),
    sbSelect<any>("tasks", `created_at=gte.${start}&created_at=lt.${end}&order=created_at.asc&select=title,quadrant`).catch(() => []),
  ]);
  const hhmm = (ts: number) => {
    const d = new Date(ts + 4 * 3_600_000); // shift epoch ms into Dubai local
    return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  };
  const messages = (msgs as any[])
    .filter((m) => (m.role === "user" || m.role === "assistant") && String(m.content || "").trim())
    .map((m) => ({ time: hhmm(m.ts), who: m.role === "assistant" ? "Dorje" : "Jensen", text: String(m.content).slice(0, 300) }));
  const evs = (events as any[]).map((e) => ({ time: e.time, title: e.title }));
  const tks = (tasks as any[]).map((t) => ({ title: t.title, quadrant: t.quadrant }));
  return {
    date: dateISO,
    messages,
    events: evs,
    tasksCreated: tks,
    note: messages.length === 0 && evs.length === 0 && tks.length === 0
      ? `No recorded activity on ${dateISO}.`
      : `This is the COMPLETE record for ${dateISO}. Report only what is listed here; do not add items from other days.`,
  };
}
// Normalized title key for soft-dedup. Strips lead "meeting with the",
// trailing " at <location>", lowercases, collapses whitespace. Two model-produced
// titles describing the same meeting (one with location in title, one with
// location in note) collapse to the same key.
export function normalizeEventTitleKey(title: string): string {
  return (title || "")
    .toLowerCase()
    .replace(/^meeting (with|w\/)\s+(the\s+)?/i, "")
    .replace(/\s+at\s+[^,]+$/i, "")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Pure reconcile decision (Phase 2, unit-testable): the id of the SINGLE upcoming
// event that shares this identity on a different date (the meeting being moved),
// or null when there is no unambiguous single match (insert a fresh event instead
// of blind-merging two distinct same-title meetings).
// Generic identities that are NOT distinctive enough to assume "same meeting
// moved" — two "Review"s on different days are usually different meetings. Only a
// distinctive identity (a name/org: sotiris, karafotias, a2 milk) reconciles.
const GENERIC_EVENT_KEYS = new Set([
  "", "review", "call", "sync", "meeting", "catch up", "catchup", "standup",
  "lunch", "dinner", "coffee", "chat", "check in", "checkin", "1 1", "one on one",
]);

export function pickReconcileTarget(
  upcoming: { id: string; title: string; date: string; recurrence?: string | null; entity_id?: string | null }[],
  key: string,
  newDate: string,
  newEntityId?: string | null,
): string | null {
  // Guard 1: a generic title is never reconciled (would move a distinct meeting).
  if (GENERIC_EVENT_KEYS.has(key) || key.length < 4) return null;
  const matches = (upcoming || []).filter(
    (r) =>
      normalizeEventTitleKey(r.title) === key &&
      r.date !== newDate &&
      // Guard 2 (skeptic F1, CRITICAL): never move a RECURRING anchor — a weekly
      // meeting is a single upcoming row; reconciling it corrupts the whole series.
      // A recurring meeting is moved via update_event, never via a new create.
      !r.recurrence &&
      // Guard 3 (skeptic F3, HIGH): if both carry an entity, they must be the SAME
      // entity. Two distinct meetings with the same person (same title key) must not
      // merge. Absent entity on either side falls back to title-identity only.
      (!newEntityId || !r.entity_id || r.entity_id === newEntityId),
  );
  return matches.length === 1 ? matches[0].id : null;
}

export async function createEvent(i: { title: string; date: string; time?: string; entityId?: string; note?: string; recurrence?: string; recurrenceUntil?: string; meetingUrl?: string }) {
  // Soft-dedup: normalized title + same date (+ same time if both provided) is
  // the same event, not a copy. Prevents the 06-13 Karafotias case where the
  // model produced "Meeting with the Karafotias at Dubai Hills Mall" and
  // "Meeting with the Karafotias" 75s apart for the same 14:30 slot.
  const key = normalizeEventTitleKey(i.title);
  if (key) {
    const sameDay = await sbSelect<any>("events", `date=eq.${enc(i.date)}&select=id,title,time&limit=20`).catch((e) => { console.warn(`createEvent dedup query failed (inserting anyway, may duplicate): ${String(e?.message || e).slice(0, 160)}`); return []; });
    const dup = sameDay.find((r: any) => {
      if (normalizeEventTitleKey(r.title) !== key) return false;
      if (i.time && r.time && i.time !== r.time) return false;
      return true;
    });
    if (dup) return { id: dup.id, title: dup.title, date: i.date, deduped: true };

    // Cross-date identity reconcile (Phase 2 — kills the duplicate-meeting class,
    // e.g. the 3 "Meeting with Sotiris" rows across 06-17/26/29). If EXACTLY ONE
    // upcoming event shares this identity on a DIFFERENT date, a "new" create is
    // that meeting being MOVED, not a copy: update it in place. Ambiguous (0 or
    // 2+ matches) falls through to insert — we never blind-merge two distinct
    // same-title meetings. Guards (skeptic-hardened): generic titles, RECURRING
    // anchors, and differing-entity meetings are all excluded from reconcile.
    const today = dubaiToday(); // skeptic F5: Dubai +4, not raw UTC (matches the rest of this file)
    const upcoming = await sbSelect<any>("events", `date=gte.${enc(today)}&select=id,title,date,time,recurrence,entity_id&limit=50`).catch(() => []);
    const targetId = pickReconcileTarget(upcoming as any[], key, i.date, i.entityId);
    if (targetId) {
      // Forward the fields the model supplied on THIS create (skeptic F2): a move
      // that drops the new note/entity silently loses the operator's intent.
      await updateEvent({ id: targetId, date: i.date, time: i.time, meetingUrl: i.meetingUrl, note: i.note, entityId: i.entityId });
      return { id: targetId, title: i.title, date: i.date, reconciled: true };
    }
  }
  const validRecurrence = ["weekly", "monthly", "yearly"].includes(i.recurrence || "") ? i.recurrence : null;
  const row: any = { id: uid(), title: i.title, date: i.date, time: i.time ?? null, entity_id: i.entityId ?? null, note: i.note ?? null, recurrence: validRecurrence, recurrence_until: i.recurrenceUntil ?? null, created_at: now() };
  if (i.meetingUrl) row.meeting_url = i.meetingUrl;
  await sbInsert("events", row);
  return { id: row.id, title: i.title, date: i.date, time: i.time, recurrence: validRecurrence, meetingUrlSaved: !!i.meetingUrl };
}
export async function updateEvent(i: any) {
  const patch: any = {};
  for (const k of ["title", "date", "time", "note", "recurrence", "recurrence_until"]) if (i[k] !== undefined) patch[k] = i[k];
  // entityId maps to entity_id (the loop above uses snake_case keys; the camelCase
  // entityId the model/reconcile passes was previously dropped on update).
  if (i.entityId !== undefined) patch.entity_id = i.entityId;
  // Meeting link maps to the meeting_url column (only when provided, never clobbered to null).
  if (i.meetingUrl) patch.meeting_url = i.meetingUrl;
  // Wall-at-primitive: any change to fire-time invalidates the reminder latch.
  // Without this, a moved event keeps its old reminded_at and the cron's
  // `reminded_at IS NULL` filter silently skips the row on the new date.
  if (patch.date !== undefined || patch.time !== undefined) patch.reminded_at = null;
  await sbUpdate("events", `id=eq.${enc(i.id)}`, patch);
  return { id: i.id, updated: Object.keys(patch) };
}
export async function deleteEvent(id: string) { await sbDelete("events", `id=eq.${enc(id)}`); return { deleted: id }; }

// complete_event (KT #288). When Jensen says "Sara done / Toana done", Dorje
// used to punt with "they were calendar events, so marked past automatically",
// a behavioral fiction (Law 1 persona-purity asks for honesty, Law 6 numbers-
// reconcile asks for status to match state). Stamps outcome="completed" and
// prepends a one-line marker on note. The reminders cron's reminded_at latch
// already gates re-firing, so completion is purely a status record.
export async function completeEvent(i: { id: string; note?: string }) {
  const stamp = new Date().toISOString().slice(0, 10);
  const noteLine = i.note ? `[completed ${stamp}: ${i.note}]` : `[completed ${stamp}]`;
  const rows = await sbSelect<any>("events", `id=eq.${enc(i.id)}&select=note&limit=1`).catch(() => []);
  const prev = rows?.[0]?.note || "";
  const merged = prev ? `${noteLine}\n${prev}` : noteLine;
  // outcome must be a constraint-allowed value (events_outcome.sql): "completed"
  // is NOT allowed and the write 400'd every time, so "mark the meeting done"
  // silently failed. "happened" is the allowed value meaning the meeting took
  // place; the human-readable completion stamp lives on the note above.
  await sbUpdate("events", `id=eq.${enc(i.id)}`, { outcome: "happened", note: merged });
  return { id: i.id, completed: true };
}

// ---------- NOTES ----------
export async function listNotes(f: { kind?: string } = {}) {
  let qs = "order=created_at.desc";
  if (f.kind) qs += `&kind=eq.${enc(f.kind)}`;
  return sbSelect("notes", qs);
}
export async function addNote(i: { kind?: string; title?: string; body: string; url?: string; entityId?: string }) {
  const row = { id: uid(), kind: i.kind || "note", title: i.title ?? null, body: i.body, url: i.url ?? null, entity_id: i.entityId ?? null, pinned: false, created_at: now() };
  await sbInsert("notes", row);
  return { id: row.id, kind: row.kind };
}
export async function deleteNote(id: string) { await sbDelete("notes", `id=eq.${enc(id)}`); return { deleted: id }; }

// ---------- CONTACTS ----------
export async function listContacts() { return sbSelect("contacts", "order=created_at.desc"); }
export async function findContact(q: string) { return sbSelect("contacts", `or=(name.${like(q)},company.${like(q)})&limit=8`); }
export async function addContact(i: { name: string; company?: string; role?: string; email?: string; phone?: string; entityId?: string }) {
  // Dedup (the recurring "same person" / duplicate-contact friction): a same-name
  // compatible contact already exists -> enrich its blank fields instead of making
  // a second row. Conflicting email/phone -> different person -> insert new.
  const existing = await sbSelect<any>("contacts", `order=created_at.asc&select=id,name,email,phone,company,role,entity_id&limit=200`).catch(() => []);
  const dupId = pickContactDup(existing as any[], i.name, i.email, i.phone);
  if (dupId) {
    const cur = (existing as any[]).find((c) => c.id === dupId) || {};
    const patch: any = {};
    if (i.email && !cur.email) patch.email = i.email;
    if (i.phone && !cur.phone) patch.phone = i.phone;
    if (i.company && !cur.company) patch.company = i.company;
    if (i.role && !cur.role) patch.role = i.role;
    if (i.entityId && !cur.entity_id) patch.entity_id = i.entityId;
    if (Object.keys(patch).length) await sbUpdate("contacts", `id=eq.${enc(dupId)}`, patch).catch(() => {});
    return { id: dupId, name: i.name, deduped: true };
  }
  const row = { id: uid(), name: i.name, company: i.company ?? null, role: i.role ?? null, email: i.email ?? null, phone: i.phone ?? null, entity_id: i.entityId ?? null, created_at: now() };
  await sbInsert("contacts", row);
  return { id: row.id, name: i.name };
}
export async function updateContact(i: any) {
  const patch: any = {};
  for (const k of ["name", "company", "role", "email", "phone"]) if (i[k] !== undefined) patch[k] = i[k];
  await sbUpdate("contacts", `id=eq.${enc(i.id)}`, patch);
  return { id: i.id, updated: Object.keys(patch) };
}
export async function deleteContact(id: string) { await sbDelete("contacts", `id=eq.${enc(id)}`); return { deleted: id }; }

// ---------- DOCUMENTS ----------
const RESTRICTED = ["finance", "legal", "identity", "contracts"];
export async function addDoc(d: { id: string; title: string; fileName?: string; mime?: string; kind?: string; text: string; folder?: string; entityId?: string; dataUrl?: string; chunks?: { text: string; embedding: number[] }[]; createdAt?: number }) {
  const created = d.createdAt ?? now();
  const folder = d.folder || "general";
  await sbInsert("docs", {
    id: d.id, title: d.title, file_name: d.fileName ?? null, mime: d.mime ?? null, kind: d.kind ?? "document",
    entity_id: d.entityId ?? null, content: d.text ?? "", folder, sensitivity: RESTRICTED.includes(folder) ? "restricted" : "normal",
    // data_url carries the Supabase Storage PATH of the original file bytes so
    // the bot can send the real file (e.g. a passport PDF) back later. Without it,
    // only OCR text was kept and "pull up my passport" had nothing to return.
    data_url: d.dataUrl ?? null,
    size: 0, created_at: created,
  });
  const rows = (d.chunks || []).filter((c) => c.embedding?.length).map((c, i) => ({ doc_id: d.id, idx: i, text: c.text, embedding: `[${c.embedding.join(",")}]`, created_at: created }));
  if (rows.length) await sbInsert("doc_chunks", rows);
  return { id: d.id, folder };
}
export async function listDocs(f: { folder?: string; entityId?: string } = {}) {
  let qs = "select=id,title,folder,kind,sensitivity,entity_id,created_at&order=created_at.desc";
  if (f.folder) qs += `&folder=eq.${enc(f.folder)}`;
  if (f.entityId) qs += `&entity_id=eq.${enc(f.entityId)}`;
  return sbSelect("docs", qs);
}
export async function fileDocument(i: { id: string; folder: string; entityId?: string; sensitivity?: string }) {
  const patch: any = { folder: i.folder, sensitivity: i.sensitivity || (RESTRICTED.includes(i.folder) ? "restricted" : "normal") };
  if (i.entityId !== undefined) patch.entity_id = i.entityId;
  await sbUpdate("docs", `id=eq.${enc(i.id)}`, patch);
  return { id: i.id, folder: i.folder, sensitivity: patch.sensitivity };
}
export async function deleteDoc(id: string) { await sbDelete("docs", `id=eq.${enc(id)}`); return { deleted: id }; }

// ---------- CHAT (append-only, one-brain, PARTY-SCOPED privacy wall) ----------
// Every message belongs to a `party` (the person the conversation is with).
// Jensen's history and Taona's dev history never mix; Jensen can only ever load
// his own. (Asymmetric wall: an admin tool can read Jensen's; nothing lets Jensen
// read the admin's.)
//
// Wall 1 of "fragment match without anchor" (2026-06-16, KT #293):
//   externalId           outbound Meta wamid, set so a later inbound m.context.id
//                        can join chat_messages.reply_to_external_id -> external_id.
//   replyToExternalId    set on the inbound row when the user reply-quoted a
//                        prior Dorje message; the worker resolves it at turn time.
// Both are optional; existing call sites pass nothing and behavior is identical.
// Returns the inserted row id so the caller can back-patch external_id once Meta
// returns the wamid (sendTextAndLog and the whatsapp route both rely on this).
export async function chatAppend(
  role: "user" | "assistant",
  content: string,
  channel = "portal",
  party = "jensen",
  opts?: { externalId?: string | null; replyToExternalId?: string | null }
): Promise<number | null> {
  // Idempotent on external_id (the WhatsApp message id). A text inbound is
  // early-saved before the gates AND re-saved with the swipe anchor; both carry
  // the same id, so the second call must UPDATE the existing row, not insert a
  // duplicate. This was the "ok sure"/"organic food" double-row bug. Never drops:
  // on any lookup error it falls through to a normal insert.
  if (opts?.externalId) {
    try {
      const existing: any[] = await sbSelect("chat_messages", `external_id=eq.${enc(opts.externalId)}&role=eq.${role}&select=id,content&limit=1`);
      const ex = existing?.[0];
      if (ex && typeof ex.id === "number") {
        // Same WhatsApp message re-saved (early-save stub -> full transcript/OCR,
        // or a chokepoint re-save of the same text). Update the existing row to
        // the RICHER content instead of inserting a duplicate. "Only grow" guard:
        // never let a shorter stub overwrite a fuller body if calls arrive out of
        // order. This makes every inbound path converge on ONE row per message.
        const patch: any = {};
        if (content && content.length > String(ex.content || "").length) patch.content = content;
        if (opts.replyToExternalId) patch.reply_to_external_id = opts.replyToExternalId;
        if (Object.keys(patch).length) await sbUpdate("chat_messages", `id=eq.${ex.id}`, patch).catch(() => {});
        return ex.id;
      }
    } catch { /* fall through to insert (never drop a message) */ }
  }
  const row: any = { role, content, channel, party, ts: now() };
  if (opts?.externalId) row.external_id = opts.externalId;
  if (opts?.replyToExternalId) row.reply_to_external_id = opts.replyToExternalId;
  try {
    const rows: any[] = await sbInsert("chat_messages", row);
    const id = rows?.[0]?.id;
    return typeof id === "number" ? id : null;
  } catch {
    return null;
  }
}
// Back-patch a chat_messages row with the wamid Meta returned post-send. Best
// effort: the row itself already holds the transcript, only the anchor join
// degrades on failure.
export async function chatPatchExternalId(rowId: number, externalId: string): Promise<void> {
  try {
    await sbUpdate("chat_messages", `id=eq.${rowId}`, { external_id: externalId });
  } catch {
    // never block delivery, never throw upstream
  }
}
export async function chatRecent(party = "jensen", limit = 12): Promise<{ role: "user" | "assistant"; content: string }[]> {
  const rows = await sbSelect<any>("chat_messages", `party=eq.${enc(party)}&select=role,content,ts&order=ts.desc&limit=${limit}`);
  return rows.reverse().map((r) => ({ role: r.role, content: r.content }));
}
// Admin-only: read Jensen's recent conversation (development access, one-way).
export async function readOwnerChats(limit = 40): Promise<{ role: string; content: string; channel: string; ts: number }[]> {
  const rows = await sbSelect<any>("chat_messages", `party=eq.jensen&select=role,content,channel,ts&order=ts.desc&limit=${limit}`);
  return rows.reverse();
}

// ---------- KV ----------
export async function getPrefs() { const r = await sbSelect<any>("kv", `key=eq.prefs&select=value`); return r[0]?.value ?? {}; }
export async function setPrefs(p: any) { await sbUpsert("kv", { key: "prefs", value: p, updated_at: now() }, "key"); return { ok: true }; }
export async function getGoals() { const r = await sbSelect<any>("kv", `key=eq.goals&select=value`); return (r[0]?.value as string[]) ?? []; }
export async function setGoals(g: string[]) { await sbUpsert("kv", { key: "goals", value: g, updated_at: now() }, "key"); return { ok: true, goals: g }; }
export async function getBlueprint() { const r = await sbSelect<any>("kv", `key=eq.legalBlueprint&select=value`); return (r[0]?.value as string) ?? ""; }
export async function setBlueprint(t: string) { await sbUpsert("kv", { key: "legalBlueprint", value: t, updated_at: now() }, "key"); return { ok: true }; }

// ---------- SANAD (UAE legal brain via /api/v1/*) ----------
// sanadStartDraft enqueues an async draft job on Sanad and records the pending
// row locally so the cron at /api/cron/sanad-deliver can poll it and deliver
// the PDF to the recipient WA when ready. Returns context the model uses to
// tell the user "I will have that ready in two minutes" in first person.
import { sanadDraftContract, sanadReviewContract, type SanadKind, type SanadJurisdiction } from "../sanad/client";

interface SanadDraftToolInput {
  kind: SanadKind;
  jurisdiction: SanadJurisdiction;
  party_a_name: string;
  party_a_details?: string;
  party_b_name: string;
  party_b_details?: string;
  effective_date?: string;
  additional_context?: string;
  recipient_wa: string;
}

export async function sanadStartDraft(input: SanadDraftToolInput) {
  if (!input?.recipient_wa) {
    return { ok: false, error: "recipient_wa is required so the PDF can be delivered when ready." };
  }
  const r = await sanadDraftContract({
    kind: input.kind,
    jurisdiction: input.jurisdiction,
    party_a: { name: input.party_a_name, details: input.party_a_details },
    party_b: { name: input.party_b_name, details: input.party_b_details },
    effective_date: input.effective_date,
    additional_context: input.additional_context
  });
  if (!r.ok) {
    return { ok: false, error: r.reason, status: r.status, hint: r.reason === "sanad_disabled" ? "Sanad v1 env vars (SANAD_V1_BASE_URL + SANAD_V1_API_KEY) are not set on this deployment." : undefined };
  }
  await sbInsert("sanad_pending_drafts", {
    job_id: r.data.job_id,
    recipient_wa: input.recipient_wa,
    kind: input.kind,
    jurisdiction: input.jurisdiction,
    status: "queued",
    poll_url: r.data.poll_url,
    metadata: {
      party_a_name: input.party_a_name,
      party_b_name: input.party_b_name,
      effective_date: input.effective_date,
      additional_context: input.additional_context
    }
  });
  return {
    ok: true,
    job_id: r.data.job_id,
    eta_seconds: r.data.eta_seconds,
    message_to_user: r.data.message,
    note: "Job queued. The cron at /api/cron/sanad-deliver polls Sanad and delivers the PDF to recipient_wa via sendTextAndLog when ready."
  };
}

export async function sanadReview(input: { text: string; kind?: SanadKind; jurisdiction?: SanadJurisdiction }) {
  if (!input?.text || input.text.length < 200) {
    return { ok: false, error: "text must be at least 200 chars." };
  }
  const r = await sanadReviewContract(input);
  if (!r.ok) {
    return { ok: false, error: r.reason, status: r.status, hint: r.reason === "sanad_disabled" ? "Sanad v1 env vars not set." : undefined };
  }
  return { ok: true, ...r.data };
}
