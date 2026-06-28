// Dispatch a tool call to a real handler. Returns a compact JSON-able result the
// model reads back. Errors are surfaced (never a fake success).

import * as ops from "./ops";
import { recall, rememberFact, queryMemory, rememberDirective, listMemory, forgetMemory } from "./brain";
import { vatFromNet, corporateTax } from "../tax";
import { askClaude, NO_DASHES, SONNET } from "../anthropic";
import { dubaiToday, dubaiNow } from "../time";
import { ordersContext } from "../shopify";
import { callOwner } from "../voice-call";
import { aggregateInbox, readUnified, sendUnified, unpackId, sendMeetingInviteEmail, sendNewEmail } from "../mail-provider";
import { dubaiLocalToUtc } from "../ics";
import { searchDocsWithClaude } from "../docs-server";
import { enrichDraftContext } from "../mail-draft-context";
import { kvGet } from "../db";
import { sbSelect, enc } from "./rest";
import { sendWhatsAppDocument, devPhone, whoIs } from "../whatsapp";
import { signedReceiptUrl } from "../storage";
import { meetingUrlForWrite } from "../digital-u";
import { takeParkedLinkFor } from "../pending-links";
import { selectProposedTasks } from "./meeting-proposal.mjs";

type Result = any;

// Wall 2 of "fragment match without anchor" (2026-06-16, KT #293 port from
// Sasa's KT #274). When complete/update/delete_task or complete_event resolves
// a candidate row whose TITLE carries a first name from Jensen's contacts that
// the operator did NOT name in their last inbound message (and DID name a
// different one), refuse the write and surface the disagreement. The 06-15
// "meeting taona done -> closed meeting with haneen" misroute on Sasa lives
// here: the LLM dispatched an id whose title carries the wrong name, the
// primitive accepted it, the wall above (anchor) does not fire if Jensen did
// not swipe. Wall-at-primitive: every task or event target write primitive
// calls this guard with the resolved row title BEFORE the update.
//
// Lifted to @sinanagency/brain-core v0.7 on 2026-06-16 as the first primitive
// in the cross-bot tool registry. Jensen-side adapters wire the pure logic to
// Jensen's contacts + chat_messages tables (Sasa uses team_members + messages;
// CTH has no surface for this yet). Same regex, two adapter callbacks,
// brain-core owns the truth.
import { discriminatorMismatch as _bcDiscriminatorMismatch } from "@/lib/brain-core/index.js";
function jensenDiscriminatorAdapters(ctx: { party?: string }) {
  return {
    getActiveTeamFirstNames: async (): Promise<string[]> => {
      const contacts: any[] = await sbSelect("contacts", "select=name").catch(() => []);
      return contacts
        .map((r) => String(r?.name || "").trim().split(/\s+/)[0])
        .filter((s: string) => !!s);
    },
    getLastUserInbound: async (): Promise<string | null> => {
      const party = ctx.party || "jensen";
      const rows: any[] = await sbSelect(
        "chat_messages",
        `party=eq.${enc(party)}&role=eq.user&select=content&order=ts.desc&limit=1`,
      ).catch(() => []);
      return String(rows?.[0]?.content || "");
    },
  };
}
async function discriminatorMismatch(
  ctx: { party?: string },
  candidateTitle: string
) {
  return _bcDiscriminatorMismatch(candidateTitle, jensenDiscriminatorAdapters(ctx));
}

// Deterministic weekday backstop (failure-surface iter 6 / KT #206566). The model
// computes "Thursday" -> a date and occasionally lands on the WRONG weekday (the
// 06-22 'Thursday' -> 26 June (a Friday) slip). When the user named a weekday and
// did NOT give an explicit day-of-month, the named weekday is source of truth:
// correct a date that falls on a different weekday to the next occurrence. It does
// NOT touch number-based dates, weekday+number conflicts, or a valid-but-different
// occurrence of the SAME weekday (the model's occurrence choice) — better, never
// worse. Proven across edge cases before wiring.
const _WD = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
function reconcileWeekday(userMsg: string, date: string, todayYmd: string): string {
  const m = (userMsg || "").toLowerCase().match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (!m) return date;
  if (/\b\d{1,2}(st|nd|rd|th)\b/i.test(userMsg) || /\b\d{4}-\d{2}-\d{2}\b/.test(userMsg) || /\bthe\s+\d{1,2}\b/i.test(userMsg)) return date;
  const named = _WD.indexOf(m[1]);
  const d = new Date(date + "T00:00:00Z");
  if (isNaN(d.getTime()) || d.getUTCDay() === named) return date;
  const today = new Date(todayYmd + "T00:00:00Z");
  if (isNaN(today.getTime())) return date;
  const delta = (named - today.getUTCDay() + 7) % 7;
  return new Date(today.getTime() + delta * 86400000).toISOString().slice(0, 10);
}
async function reconcileEventDate(ctx: { party?: string } | undefined, input: any): Promise<void> {
  try {
    if (!input?.date || !ctx?.party) return;
    const last = await jensenDiscriminatorAdapters(ctx).getLastUserInbound();
    const fixed = reconcileWeekday(String(last || ""), String(input.date), dubaiToday());
    if (fixed !== input.date) input.date = fixed;
  } catch { /* best-effort backstop; never block the write */ }
}

// Deterministic meeting-link capture (KT #206573). When Jensen schedules or moves
// a meeting in a message that carries a Zoom/Teams/Meet link, attach the link to
// the event's meeting_url even if the model forgot to pass meetingUrl. The
// reminder cron already renders meeting_url, so this is the missing half: capture.
// Never clobbers an explicit value; never writes null (no link in message = no-op).
async function attachMeetingLink(ctx: { party?: string } | undefined, input: any): Promise<void> {
  try {
    if (input?.meetingUrl) return; // explicit value the model passed wins
    if (!ctx?.party) return;
    const last = await jensenDiscriminatorAdapters(ctx).getLastUserInbound();
    const url = meetingUrlForWrite(undefined, String(last || ""));
    if (url) { input.meetingUrl = url; return; }
    // No link in this message. A link may have been PARKED earlier for this exact
    // meeting (incident B: link sent before the event existed). Claim it now, only
    // if the parked link's original message identity-names this event's title.
    if (input?.title) {
      const parked = await takeParkedLinkFor(ctx.party, String(input.title));
      if (parked) input.meetingUrl = parked;
    }
  } catch { /* best-effort; never block the write */ }
}

// Best-effort observability emit. Sasa has an events table for this; Jensen
// writes a system row into chat_messages so the wall firings show up in the
// same transcript review surface Taona already uses.
async function emitDiscriminatorRefusal(tool: string, taskId: string, title: string, expected: string, got: string, party?: string): Promise<void> {
  try {
    const { admin } = await import("@/lib/db");
    await admin().from("chat_messages").insert({
      role: "system",
      content: `dorje.discriminator_mismatch_refused tool=${tool} id=${taskId} expected=${expected} got=${got} title=${String(title).slice(0, 120)}`,
      channel: "audit",
      party: party || "jensen",
      ts: Date.now(),
    });
  } catch {
    // never block; the refusal already returned.
  }
}

// JENSEN-DOCTRINE Law 8 (tool-call safety) enforcement.
// Destructive or money-moving tools must NOT run inline. The model must ask
// the user to confirm; only when the next call comes back with confirm:true
// (or _confirmed:true) does the action execute.
//
// This is the chokepoint pattern again: one place that decides whether the
// dangerous action gets through, rather than asking the model to remember
// the rule every turn.
const DESTRUCTIVE = new Set([
  "delete_entity",
  "delete_task",
  "delete_event",
  "delete_finance",
  "delete_document",
  "delete_contact",
  "delete_note",
  "forget_memory",
  "reply_email",   // sends real outbound mail
  "call_owner",    // places a real Twilio phone call
  "send_meeting_invite", // sends a real calendar invite to an external person
  "send_email",    // composes + sends a brand-new outbound email
  // ADR-0002 Phase 0: a contract draft enqueues a real legal PDF delivered to a
  // WhatsApp number (sanad_pending_drafts -> cron/sanad-deliver). It must surface
  // a confirm to Jensen first, same as send_email — it was UNGATED (Class C1).
  // The structural self-confirm fix (pending_actions, distinct-inbound) is
  // ADR-0002 Phase 1; C1 stays OPEN until then.
  "sanad_draft_contract",
]);

// A genuine affirmation FROM THE OWNER (not the model). Bounded so "yesterday"
// and the like never match; negations ("no, don't") never match.
const CONFIRM_RE = /\b(yes+|yep|yeah|yup|ya|okay|ok|k|sure|fine|correct|right|absolutely|100%?|confirm|confirmed|go ahead|go for it|do it|do that|send it|delete it|please do|that'?s right|approved)\b|👍/i;
export function isConfirmation(text: string): boolean {
  // Skeptic #6: a coalesced burst joins lines with "\n"; the owner's FINAL line
  // governs. "yes\nactually wait no" must read as the reversal, not the yes.
  const lines = String(text || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const t = lines[lines.length - 1] || "";
  if (!t) return false;
  if (/\b(no|don'?t|do not|cancel|stop|wait|not yet|never ?mind)\b/i.test(t) && !/\b(yes|confirm|go ahead|do it)\b/i.test(t)) return false;
  return CONFIRM_RE.test(t);
}

// C1 FIX (was self-gatable): a destructive/outbound tool no longer executes on a
// model-supplied `confirm:true` — the model could set that itself with no real
// approval. Confirmation must be the OWNER'S ACTUAL last inbound being a yes. The
// model cannot forge the owner's message, so it can only get here after genuinely
// asking and the owner genuinely confirming. The model's confirm field is ignored.
// (_confirmed is reserved for a future server-set deterministic execute path.)
export function isDestructive(name: string): boolean {
  return DESTRUCTIVE.has(name);
}

function destructiveGate(name: string, input: any, lastUser: string): { ok: boolean; error?: string } | null {
  if (!DESTRUCTIVE.has(name)) return null;
  const serverConfirmed = input?._confirmed === true; // server-set only, never the model
  const ownerConfirmed = isConfirmation(lastUser);
  if (serverConfirmed || ownerConfirmed) return null;
  return {
    ok: false,
    error:
      `Destructive tool '${name}' refused: the owner has not confirmed. ` +
      `JENSEN-DOCTRINE Law 8: write tools never run inline. ` +
      `Ask a clear yes/no ('Delete X? Reply yes to confirm') and wait. The action ` +
      `runs only when the owner's own next message is a yes (a confirm:true flag is ignored).`,
  };
}

async function financeSummary(i: { entityId?: string; from?: string; to?: string }) {
  let rows = await ops.listFinance({ entityId: i.entityId });
  if (i.from) rows = rows.filter((r: any) => r.date >= i.from!);
  if (i.to) rows = rows.filter((r: any) => r.date <= i.to!);
  const income = rows.filter((r: any) => r.kind === "income").reduce((s: number, r: any) => s + Number(r.amount), 0);
  const expense = rows.filter((r: any) => r.kind === "expense").reduce((s: number, r: any) => s + Number(r.amount), 0);
  const byEntity: Record<string, { income: number; expense: number }> = {};
  for (const r of rows) {
    const k = r.entity_id || "unassigned";
    byEntity[k] = byEntity[k] || { income: 0, expense: 0 };
    byEntity[k][r.kind === "income" ? "income" : "expense"] += Number(r.amount);
  }
  return { income, expense, net: income - expense, currency: "AED", count: rows.length, byEntity };
}

async function vatReport(i: { from?: string; to?: string }) {
  let rows = await ops.listFinance({ kind: "income" });
  if (i.from) rows = rows.filter((r: any) => r.date >= i.from!);
  if (i.to) rows = rows.filter((r: any) => r.date <= i.to!);
  let vat = 0, net = 0;
  for (const r of rows) if (r.vat_applies) { const v = vatFromNet(Number(r.amount)); vat += v.vat; net += v.net; }
  return { period: { from: i.from || "all", to: i.to || "all" }, vatableNet: net, outputVatDue: Math.round(vat * 100) / 100, rate: "5%", note: "Output VAT on income where VAT applies. Net of input VAT not included." };
}

async function ctEstimate(i: { from?: string; to?: string }) {
  const s = await financeSummary(i);
  const ct = corporateTax(s.net);
  return { taxableProfit: s.net, corporateTax: ct.tax, detail: ct, note: "9% on taxable income above AED 375,000. Estimate only; confirm with an accountant." };
}

// Send the OWNER the actual stored file of a filed document (KT #206561). Finds
// the best title/content/filename match that has vaulted bytes (data_url),
// downloads it from Supabase Storage, and delivers it via the document send.
// Not destructive: it returns the owner his own file (no external recipient, no
// confirm gate). Honest on miss: says so rather than pretending it sent.
function jensenOwnerNumber(): string | null {
  return (process.env.OWNER_WHATSAPP || "")
    .split(",").map((n) => n.replace(/[^0-9]/g, "")).filter(Boolean)
    .find((d) => whoIs(d).role === "owner") || null;
}
export async function sendFiledDocument(query: string, party?: string, opts?: { autoLatest?: boolean }): Promise<{ ok: boolean; result?: any; error?: string }> {
  const q = (query || "").trim();
  if (!q) return { ok: false, error: "Tell me which document to send, e.g. 'my passport'." };
  const rows: any[] = await sbSelect(
    "docs",
    `or=(title.ilike.*${enc(q)}*,content.ilike.*${enc(q)}*,file_name.ilike.*${enc(q)}*)&data_url=not.is.null&select=id,title,file_name,mime,data_url,folder&order=created_at.desc&limit=5`,
  ).catch(() => []);
  if (!rows.length) {
    return { ok: false, error: `I don't have the actual file for "${q}" vaulted yet. If it was uploaded before I started keeping the file itself, please send it again and I will vault it permanently.` };
  }
  // WRONG-RECORD GUARD (failure-surface, send_filed_document × wrong-record): when
  // the query matches MULTIPLE DISTINCT documents, do NOT silently send the newest
  // — that ships the wrong private file. Disambiguate by TITLE (the record's
  // identity), not content. autoLatest (the deterministic identity route) sends
  // the newest of same-titled re-uploads (a re-sent passport), which is safe.
  const distinctTitles = [...new Set(rows.map((r) => String(r.title || "").trim().toLowerCase()))];
  if (distinctTitles.length > 1 && !opts?.autoLatest) {
    return {
      ok: false,
      error: `I have ${rows.length} documents matching "${q}": ${rows.map((r) => r.title).join(", ")}. Which one should I send?`,
      result: { ambiguous: true, matches: rows.map((r) => r.title) },
    };
  }
  const doc = rows[0];
  let buf: Buffer;
  try {
    const url = await signedReceiptUrl(doc.data_url, 300);
    const res = await fetch(url);
    if (!res.ok) return { ok: false, error: `found "${doc.title}" but could not fetch the stored file (${res.status}).` };
    buf = Buffer.from(await res.arrayBuffer());
  } catch (e: any) {
    return { ok: false, error: `found "${doc.title}" but the file fetch failed: ${e?.message || e}` };
  }
  const to = party && party !== "jensen" ? devPhone() : jensenOwnerNumber();
  if (!to) return { ok: false, error: "no recipient number is configured." };
  const filename = doc.file_name || `${doc.title}.pdf`;
  const wamid = await sendWhatsAppDocument(to, buf, filename, doc.title, { force: true });
  if (!wamid) return { ok: false, error: `found "${doc.title}" but the WhatsApp file send failed.` };
  return { ok: true, result: { sent: doc.title, file: filename, folder: doc.folder } };
}

const GEN_SYS = (kind: string) =>
  `You are Rencontre, drafting a ${kind} for Jensen, founder of La Rencontre, a luxury F&B hospitality consultancy in Dubai. Write a polished, client-ready ${kind} in clean prose with clear headings. UAE context (AED, 5% VAT, local norms). ${NO_DASHES} Output the document body only.`;

const LEGAL_SYS = (kind: string, blueprint: string) =>
  `You are Rencontre, drafting a UAE ${kind} for Jensen / La Rencontre. Ground it in this legal blueprint where relevant:\n${blueprint || "(no blueprint saved yet; use sensible UAE defaults and flag where Jensen must fill specifics)"}\nDraft a clear, professional document under Dubai/UAE law. Add a short note that a UAE lawyer should review before signing. ${NO_DASHES} Output the document body only.`;

export async function runAction(name: string, input: any, ctx?: { party?: string; lastUser?: string }): Promise<{ ok: boolean; result?: Result; error?: string }> {
  try {
    const gated = destructiveGate(name, input, ctx?.lastUser || "");
    if (gated) return gated;
    let result: Result;
    switch (name) {
      // entities
      case "list_entities": result = await ops.listEntities(input); break;
      case "find_entity": result = await ops.findEntity(input.name); break;
      case "create_entity": result = await ops.createEntity(input); break;
      case "update_entity": result = await ops.updateEntity(input); break;
      case "delete_entity": result = await ops.deleteEntity(input.id); break;
      // tasks
      case "list_tasks": result = await ops.listTasks(input); break;
      case "create_task": {
        result = await ops.createTask(input);
        if (result?.ok !== false && result?.quadrant === 1) {
          try {
            const { sendTextAndLog } = await import("@/lib/sendTextAndLog");
            const { whoIs } = await import("@/lib/whatsapp");
            const nums = (process.env.OWNER_WHATSAPP || "").split(",").map((n: string) => n.trim()).filter(Boolean);
            const owner = nums.find((n: string) => whoIs(n).role === "owner");
            if (owner) sendTextAndLog(owner, `Heads up. I just added *${result.title}* to your Q1. It is marked urgent.`, { force: true, party: "jensen" }).catch(() => {});
          } catch {}
        }
        break;
      }
      case "update_task": {
        // Wall 2: look up the resolved title BEFORE writing so we can refuse
        // when the operator's last inbound names a different team contact.
        const trow: any[] = await sbSelect("tasks", `id=eq.${enc(String(input.id))}&select=title&limit=1`).catch(() => []);
        const title = String((trow?.[0]?.title) || "");
        const disc = await discriminatorMismatch({ party: ctx?.party }, title);
        if (!disc.ok) {
          await emitDiscriminatorRefusal("update_task", String(input.id), title, disc.expected, disc.got, ctx?.party);
          return { ok: false, error: `I cannot update "${title}" from your message about ${disc.got}. Those name different people. Tell me which task you meant.` };
        }
        result = await ops.updateTask(input);
        break;
      }
      case "complete_task": {
        // Wall 2 mirror of update_task.
        const trow: any[] = await sbSelect("tasks", `id=eq.${enc(String(input.id))}&select=title&limit=1`).catch(() => []);
        const title = String((trow?.[0]?.title) || "");
        const disc = await discriminatorMismatch({ party: ctx?.party }, title);
        if (!disc.ok) {
          await emitDiscriminatorRefusal("complete_task", String(input.id), title, disc.expected, disc.got, ctx?.party);
          return { ok: false, error: `I cannot close "${title}" from your message about ${disc.got}. Those name different people. Tell me which task you meant.` };
        }
        result = await ops.updateTask({ id: input.id, done: true });
        break;
      }
      case "delete_task": {
        // Wall 2 mirror, doubly important because delete is irreversible.
        const trow: any[] = await sbSelect("tasks", `id=eq.${enc(String(input.id))}&select=title&limit=1`).catch(() => []);
        const title = String((trow?.[0]?.title) || "");
        const disc = await discriminatorMismatch({ party: ctx?.party }, title);
        if (!disc.ok) {
          await emitDiscriminatorRefusal("delete_task", String(input.id), title, disc.expected, disc.got, ctx?.party);
          return { ok: false, error: `I will not delete "${title}" from your message about ${disc.got}. Those name different people. Tell me which task you meant.` };
        }
        result = await ops.deleteTask(input.id);
        break;
      }
      // meeting-task proposal acceptance (Digital Jensen wrap-up). Creates tasks
      // DETERMINISTICALLY from the stored proposal (KT #206574) so the model
      // cannot re-type, drop, or invent items. Jensen's reply IS the confirmation,
      // so this is not destructive-gated; the gate is that nothing was created
      // until he said so.
      case "accept_meeting_tasks": {
        if (input.skip === true) { await ops.clearPendingMeetingTasks(); result = { skipped: true }; break; }
        const pending = await ops.getPendingMeetingTasks();
        if (!pending || !pending.tasks?.length) { result = { ok: false, error: "No meeting action items are waiting to be accepted right now." }; break; }
        const which = Array.isArray(input.numbers) && input.numbers.length ? input.numbers : "all";
        const chosen = selectProposedTasks(pending.tasks, which);
        if (!chosen.length) { result = { error: "None of those numbers matched the proposed list.", proposed: pending.tasks.map((t: any, i: number) => ({ n: i + 1, title: t.title })) }; break; }
        const created: any[] = [];
        for (const t of chosen) { try { created.push(await ops.createTask({ title: t.title, quadrant: t.quadrant })); } catch { /* skip single failure */ } }
        await ops.clearPendingMeetingTasks();
        result = { accepted: created.length, fromMeeting: pending.title, tasks: created };
        break;
      }
      // calendar
      case "query_calendar": result = await ops.queryCalendar(input); break;
      case "day_log": result = await ops.dayLog(input.date); break;
      case "create_event": { await reconcileEventDate(ctx, input); await attachMeetingLink(ctx, input); result = await ops.createEvent(input); break; }
      case "send_email": {
        try {
          const r = await sendNewEmail({ toEmail: String(input.to), subject: String(input.subject || ""), body: String(input.body || "") });
          result = { sent: true, to: input.to, subject: input.subject, from_mailbox: r.from };
        } catch (e: any) {
          result = { ok: false, error: `Could not send the email: ${String(e?.message || e).slice(0, 200)}` };
        }
        break;
      }
      case "send_meeting_invite": {
        const start = dubaiLocalToUtc(String(input.date || ""), String(input.time || ""));
        if (!start) { result = { ok: false, error: "Need a valid date (YYYY-MM-DD) and time (HH:MM, Dubai)." }; break; }
        const dur = Number(input.durationMin) > 0 ? Number(input.durationMin) : 60;
        const end = new Date(start.getTime() + dur * 60000);
        const hh = String(input.time).match(/^(\d{1,2}):(\d{2})/);
        const timeLabel = hh ? `${hh[1].padStart(2, "0")}:${hh[2]}` : String(input.time);
        const whenLabel = `${input.date}, ${timeLabel} (Dubai)`;
        try {
          const inv = await sendMeetingInviteEmail({
            toEmail: String(input.attendeeEmail), toName: input.attendeeName || undefined,
            subject: String(input.title), whenLabel, start, end,
            location: input.location || undefined, description: input.note || undefined,
          });
          // Mirror onto Jensen's board so it shows on his list + a reminder fires.
          const mirror = await ops.createEvent({
            title: String(input.title), date: String(input.date), time: timeLabel,
            note: [input.location, `invite sent to ${input.attendeeEmail}`].filter(Boolean).join(" · "),
          }).catch(() => null);
          result = { sent: true, invited: input.attendeeEmail, when: whenLabel, location: input.location || null, from_mailbox: inv.from, on_board: !!mirror };
        } catch (e: any) {
          // Never fake success — surface the real reason.
          result = { ok: false, error: `Could not send the invite: ${String(e?.message || e).slice(0, 200)}` };
        }
        break;
      }
      case "update_event": { await reconcileEventDate(ctx, input); await attachMeetingLink(ctx, input); result = await ops.updateEvent(input); break; }
      case "delete_event": result = await ops.deleteEvent(input.id); break;
      case "complete_event": {
        // Wall 2: complete_event was added 2026-06-15 (KT #288) precisely for
        // the "Sara done / Toana done" case. That tool's bug is the same shape
        // as complete_task on Sasa: model picks a calendar event whose title
        // carries a different first name from the one Jensen just named.
        const erow: any[] = await sbSelect("events", `id=eq.${enc(String(input.id))}&select=title&limit=1`).catch(() => []);
        const title = String((erow?.[0]?.title) || "");
        const disc = await discriminatorMismatch({ party: ctx?.party }, title);
        if (!disc.ok) {
          await emitDiscriminatorRefusal("complete_event", String(input.id), title, disc.expected, disc.got, ctx?.party);
          return { ok: false, error: `I cannot mark "${title}" as completed from your message about ${disc.got}. Those name different people. Tell me which meeting you meant.` };
        }
        result = await ops.completeEvent({ id: input.id, note: input.note });
        break;
      }
      // finance
      case "finance_summary": result = await financeSummary(input); break;
      case "list_finance": result = await ops.listFinance(input); break;
      case "record_finance": result = await ops.recordFinance(input); break;
      case "update_finance": result = await ops.updateFinance(input); break;
      case "delete_finance": result = await ops.deleteFinance(input.id); break;
      case "vat_report": result = await vatReport(input); break;
      case "ct_estimate": result = await ctEstimate(input); break;
      // documents
      case "search_documents": { result = await searchDocsWithClaude(input.query, 8); break; }
      case "send_filed_document": { result = await sendFiledDocument(String(input.query || ""), ctx?.party); break; }
      case "list_documents": result = await ops.listDocs(input); break;
      case "file_document": result = await ops.fileDocument(input); break;
      case "delete_document": result = await ops.deleteDoc(input.id); break;
      // generation
      case "generate_document": result = { type: input.type, draft: await askClaude({ system: GEN_SYS(input.type), messages: [{ role: "user", content: input.brief }], model: SONNET, maxTokens: 2200 }) }; break;
      case "generate_legal": { const bp = await ops.getBlueprint(); result = { type: input.type, draft: await askClaude({ system: LEGAL_SYS(input.type, bp), messages: [{ role: "user", content: input.brief }], model: SONNET, maxTokens: 2400 }) }; break; }
      case "set_legal_blueprint": result = await ops.setBlueprint(input.text); break;
      // contacts
      case "list_contacts": result = await ops.listContacts(); break;
      case "find_contact": result = await ops.findContact(input.query); break;
      case "add_contact": result = await ops.addContact(input); break;
      case "update_contact": result = await ops.updateContact(input); break;
      case "delete_contact": result = await ops.deleteContact(input.id); break;
      // entity intelligence
      case "entity_dashboard": {
        let entityId = input.entityId;
        if (!entityId && input.name) {
          const found = await ops.findEntity(input.name).catch(() => [] as any[]);
          entityId = (found as any[])?.[0]?.id || null;
        }
        if (!entityId) { result = { error: "entity not found" }; break; }
        const [tasks, events, finance, notes, contacts] = await Promise.all([
          ops.listTasks({ entityId }).catch(() => []),
          ops.queryCalendar({ entityId }).catch(() => []),
          ops.listFinance({ entityId }).catch(() => []),
          ops.listNotes({}).then((all) => (all as any[]).filter((n) => n.entity_id === entityId)).catch(() => []),
          ops.listContacts().then((all) => (all as any[]).filter((c) => c.entity_id === entityId)).catch(() => []),
        ]);
        result = { entityId, tasks, events, finance, notes, contacts };
        break;
      }
      // notes
      case "list_notes": result = await ops.listNotes(input); break;
      case "add_note": result = await ops.addNote(input); break;
      case "delete_note": result = await ops.deleteNote(input.id); break;
      // mail
      case "list_inbox": {
        const ms = await aggregateInbox(Math.min(input.limit || 10, 20));
        result = ms.slice(0, input.limit || 10).map((m: any) => ({ id: m.id, from: m.from, email: m.fromEmail, subject: m.subject, date: m.date, snippet: m.snippet, mailbox: m.accountEmail, unread: !m.seen }));
        break;
      }
      case "search_email": {
        const q = ((input.sender || "") + " " + (input.subject || "")).trim().toLowerCase();
        const limit = Math.min(input.limit || 5, 20);
        // 1) Search the triage cache for matching sender/subject.
        const triageCache = await kvGet<Record<string, any>>("mailtriage", {}).catch(() => ({}));
        const fromCache = Object.values(triageCache as any).filter((t: any) => {
          const tFrom = ((t.fromEmail || "") + " " + (t.from || "") + " " + (t.subject || "")).toLowerCase();
          return q.split(/\s+/).some((w: string) => w.length > 2 && tFrom.includes(w));
        }).slice(0, limit);
        // 2) Search chat_messages for assistant messages that surfaced emails from this sender.
        const chatRows = await sbSelect<any>(
          "chat_messages",
          `party=eq.jensen&role=eq.assistant&content=ilike.*I noticed a new email*&select=content,ts&order=ts.desc&limit=20`
        ).catch(() => []);
        const fromChat = chatRows
          .filter((r: any) => {
            const c = ((r.content || "")).toLowerCase();
            return q.split(/\s+/).some((w: string) => w.length > 2 && c.includes(w));
          })
          .slice(0, limit)
          .map((r: any) => ({
            snippet: r.content.slice(0, 300),
            ts: r.ts,
          }));
        result = { cache: fromCache, chat: fromChat };
        if (!fromCache.length && !fromChat.length) result = { note: "No prior emails found matching that sender or subject." };
        break;
      }
      case "read_email": {
        const f: any = await readUnified(input.id);
        result = { id: f.id, from: f.from, email: f.fromEmail, subject: f.subject, date: f.date, mailbox: f.accountEmail, text: (f.text || "").slice(0, 4000) };
        break;
      }
      case "reply_email": {
        const f: any = await readUnified(input.id);
        const subject = /^re:/i.test(f.subject || "") ? f.subject : `Re: ${f.subject || ""}`;
        await sendUnified(unpackId(input.id).accountId, f.fromEmail, subject, input.body);
        result = { sent: true, to: f.fromEmail, subject, from_mailbox: f.accountEmail };
        // Post-send: record this thread so subsequent mail triage can flag replies.
        try {
          const { kvGet, kvSet } = await import("@/lib/db");
          const pending = await kvGet<Record<string, { to: string; subject: string; sentAt: number }>>("lr_sent_pending", {});
          const threadKey = `${f.fromEmail}::${(f.subject || "").replace(/^(Re|Fwd):\s*/i, "").trim().toLowerCase().slice(0, 80)}`;
          pending[threadKey] = { to: f.fromEmail, subject: f.subject || "", sentAt: Date.now() };
          const entries = Object.entries(pending);
          if (entries.length > 200) {
            entries.sort((a, b) => b[1].sentAt - a[1].sentAt);
            await kvSet("lr_sent_pending", Object.fromEntries(entries.slice(0, 200)));
          } else {
            await kvSet("lr_sent_pending", pending);
          }
        } catch {}
        break;
      }
      case "draft_reply": {
        const ctx = await enrichDraftContext(input.to, "").catch(() => "");
        const ctxBlock = ctx ? `${ctx}\n\n` : "";
        result = { drafted: true, sent: false, to: input.to, subject: input.subject, body: await askClaude({ system: `You are Rencontre drafting an email reply for Jensen. ${ctxBlock}${NO_DASHES} Output only the email body.`, messages: [{ role: "user", content: input.intent }], maxTokens: 800 }), note: "Draft only, not sent." }; break;
      }
      // memory
      case "remember_fact": await rememberFact(input.fact, { subject: input.subject, source: "concierge" }); result = { remembered: input.fact }; break;
      case "remember_preference": await rememberDirective(input.instruction); result = { saved: input.instruction, note: "I will always honor this from now on." }; break;
      case "query_memory": result = { facts: await queryMemory(input.about) }; break;
      case "list_memory": result = await listMemory(); break;
      case "forget_memory": await forgetMemory(input.id); result = { forgotten: input.id }; break;
      // admin only (the loop only exposes this tool to Taona)
      case "read_owner_chats": result = await ops.readOwnerChats(input.limit || 40); break;
      // voice call
      case "call_owner": { const to = (process.env.OWNER_WHATSAPP || "").split(",")[0]?.trim(); if (!to) { result = { ok: false, error: "no owner number set" }; break; } result = await callOwner(to, input.message); break; }
      // brief
      case "morning_brief": {
        const today = dubaiToday();
        const [q1, q2, events, fin] = await Promise.all([
          ops.listTasks({ quadrant: 1, done: false }), ops.listTasks({ quadrant: 2, done: false }),
          ops.queryCalendar({ from: today, to: today }), financeSummary({}),
        ]);
        result = { now: dubaiNow(), doFirst: q1, protect: q2, today: events, finance: { net: fin.net, currency: "AED" } };
        break;
      }
      // settings
      case "get_settings": result = { prefs: await ops.getPrefs(), goals: await ops.getGoals(), hasLegalBlueprint: !!(await ops.getBlueprint()) }; break;
      case "update_prefs": { const cur = await ops.getPrefs(); result = await ops.setPrefs({ ...cur, ...input }); break; }
      case "set_goals": result = await ops.setGoals(input.goals); break;
      // store
      case "store_summary": { const summary = await ordersContext(); result = summary ? { connected: true, summary } : { connected: false, note: "Shopify store not reachable or not configured." }; break; }
      // sanad (UAE legal brain via Jensen-side API)
      case "sanad_draft_contract": { result = await ops.sanadStartDraft(input); break; }
      case "sanad_review_contract": { result = await ops.sanadReview(input); break; }
      default: return { ok: false, error: `unknown tool ${name}` };
    }
    return { ok: true, result };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}
