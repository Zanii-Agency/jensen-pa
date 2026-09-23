// Dispatch a tool call to a real handler. Returns a compact JSON-able result the
// model reads back. Errors are surfaced (never a fake success).

import * as ops from "./ops";
import { proposePending } from "./pending-actions";
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

// Zanii proof-of-action: every tool EXCEPT pure reads emits a receipt under its
// own name (target = the tool). Deny-list (not allow-list) so new action tools
// are covered by default; only reads/queries/computations are excluded.
const ZANII_READS = new Set([
  "list_contacts", "list_documents", "list_entities", "list_finance", "list_inbox",
  "list_memory", "list_notes", "list_tasks", "query_calendar", "query_memory",
  "find_contact", "find_entity", "read_email", "read_owner_chats", "search_documents",
  "search_email", "get_settings", "entity_dashboard", "finance_summary", "morning_brief",
  "vat_report", "ct_estimate",
]);

// PARTY WALL ON PERSISTENT WRITES (Law 9 single-tenant + Law 10 test-mode).
// Jensen's board / brief / portal render every row of these tables verbatim, so a
// task/event/etc. created in a Taona (admin/dev/test) turn leaks into the client's
// world. On 2026-07-22 three of Taona's own dev tasks ("Evaluate Agent-Reach",
// "Vibe-Trading", "Trading ledger") were sitting in Jensen's board this way. The
// codebase already walls Taona out of Jensen's auto-captured memory (loop.ts:
// captureSalience runs for party==="jensen" only); this extends the SAME wall to
// tool writes, which had no such guard. A non-jensen turn gets a simulated result
// (dev sees what would have happened) and NOTHING persists to Jensen's tenant.
// Real changes to Jensen's data go through Jensen's own authenticated portal.
const TENANT_WRITES = new Set<string>([
  "create_entity", "update_entity", "delete_entity",
  "create_task", "send_task_to_peer", "update_task", "complete_task", "delete_task", "accept_meeting_tasks",
  "create_event", "set_reminder", "update_event", "delete_event", "complete_event",
  "record_finance", "update_finance", "delete_finance",
  "file_document", "delete_document",
  "set_legal_blueprint",
  "add_contact", "update_contact", "delete_contact",
  "add_note", "delete_note",
  "remember_fact", "remember_preference", "forget_memory",
  "update_prefs", "set_goals",
]);
// True when this write must be walled off: a real persistent write to Jensen's
// tenant requested by anyone other than Jensen himself.
// Outward sends that a test turn must never really make. Before 2026-09-23 these
// were missing from the wall, so a developer typing "yes" during a test could send
// a real email from Jensen's mailbox or ring his phone (a Law 10 breach, the same
// class as the 2026-09-09 zanii.ai incident).
export const OUTWARD_SENDS = new Set<string>(["send_email", "reply_email", "send_meeting_invite", "call_owner", "sanad_draft_contract"]);
export function skipTenantWriteForDev(name: string, party?: string): boolean {
  return !!party && party !== "jensen" && (TENANT_WRITES.has(name) || OUTWARD_SENDS.has(name));
}
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
function jensenDiscriminatorAdapters(ctx: { party?: string; lastUser?: string }) {
  return {
    getActiveTeamFirstNames: async (): Promise<string[]> => {
      const contacts: any[] = await sbSelect("contacts", "select=name").catch(() => []);
      return contacts
        .map((r) => String(r?.name || "").trim().split(/\s+/)[0])
        .filter((s: string) => !!s);
    },
    getLastUserInbound: async (): Promise<string | null> => {
      // The message that asked for the action. On a confirmed execution this is the
      // held proposal's text, NOT the bare "yes" (which names nobody and so let
      // the wrong-person check pass; review 2, finding 3).
      if (ctx.lastUser && ctx.lastUser.trim()) return ctx.lastUser;
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
  ctx: { party?: string; lastUser?: string },
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

// Deterministic reply classification, used ONLY for the fast path that skips the
// model. It is deliberately tiny: the WHOLE final line must be an exact bare
// yes or an exact bare no. Everything else returns null and goes to the model,
// which reads meaning in context far better than a word list.
//
// Why so strict (adversarial review 2026-09-23): the previous parser matched a
// yes-WORD anywhere in the line, so it CONFIRMED "Don't do it" ("do it"), "not
// sure" ("sure"), "Is that right?" ("right"), "ok thanks", "I'm fine", "do not
// confirm" -- while "stop them", Jensen's actual request, read as a no. Whether
// "stop them" means yes depends on what was asked, which no regex can know.
const BARE_YES = new Set([
  "yes", "yeah", "yep", "yup", "ya", "ok", "okay", "k", "sure", "confirm", "confirmed",
  "go ahead", "do it", "go for it", "please do", "yes please", "approved", "correct",
  "absolutely", "100", "100%", "fine", "yes go ahead", "yes do it", "ok go ahead", "sure go ahead",
  "yes confirm", "ok do it", "👍",
]);
const BARE_NO = new Set([
  "no", "nope", "nah", "no thanks", "dont", "don't", "do not", "no dont", "no don't",
  "not now", "not yet", "wait", "hold on", "leave it", "leave them", "keep it", "keep them",
  "never mind", "nevermind", "no leave it", "no keep it", "no keep them",
]);
function finalLine(text: string): string {
  // A coalesced burst joins lines with "\n"; the owner's FINAL line governs.
  const lines = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  return (lines[lines.length - 1] || "")
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[.!?,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
export function classifyReply(text: string): "yes" | "no" | null {
  const t = finalLine(text);
  if (!t) return null;
  if (BARE_YES.has(t)) return "yes";
  if (BARE_NO.has(t)) return "no";
  return null;
}
// Kept for callers/tests: true ONLY for an exact bare affirmation.
export function isConfirmation(text: string): boolean {
  return classifyReply(text) === "yes";
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

// ADR-0002 Phase 1. A destructive call is HELD, never run inline.
//
// History: the gate used to let a destructive call through when the owner's LAST
// message matched a yes-word. On 16 Sep Jensen asked four times to stop a
// reminder series; every attempt was refused (and "stop"/"no need" read as him
// declining), and the model told him the reminders were "wiped". They never were.
//
// Now the gate writes the question ITSELF from the real rows, holds the action
// with exactly those rows, and returns that text for the model to relay verbatim.
// So what Jensen confirms and what executes cannot drift apart (review blocker B).
// Execution happens only through executePending, reached from the deterministic
// fast path in loop.ts or the confirm_pending_action tool, both of which require
// the proposal to have been offered to THIS inbound (see pending-actions.ts).
//
// FAILS CLOSED: if the action cannot be held, it is refused. There is no longer
// any path where a destructive tool runs because of words in the last message.
async function destructiveGate(
  name: string,
  input: any,
  ctx?: { party?: string; lastUser?: string; inboundId?: string | null; confirmedPendingId?: string | null; channel?: string },
): Promise<{ ok: boolean; error?: string; held?: { id: string; echo: string } } | null> {
  if (!DESTRUCTIVE.has(name)) return null;
  if (ctx?.confirmedPendingId) return null; // set only by executePending, never reachable from model input

  // The portal has no confirmation buttons, and five review rounds showed that a
  // TYPED "yes" cannot be safely tied to the action it answers (on the portal an
  // old pending delete ran on a "yes" meant for a newer question). So deletes and
  // sends are WhatsApp-only, where he confirms with a tap on the action itself.
  // Jensen sent 0 portal messages in the 60 days to 2026-09-23.
  if (ctx?.channel === "portal") {
    return { ok: false, error: `NOT DONE: on the portal I cannot confirm deletes or sends. Tell Jensen to ask me on WhatsApp, where he confirms with one tap. Nothing happened.` };
  }

  const d = await describeProposal(name, input, ctx);
  if (d.nothing) return { ok: false, error: `NOTHING TO DO: ${d.nothing}` };

  // A send that already went out in the last few minutes is never re-held: a
  // double-tap "yes" must not send the same email twice (review 2, finding 7).
  if (OUTWARD_SENDS.has(name)) {
    const { recentlyExecutedSame } = await import("./pending-actions");
    const done = await recentlyExecutedSame(ctx?.party || "jensen", name, d.args);
    if (done?.status === "executed") return { ok: false, error: `ALREADY SENT a few minutes ago. Do not send it again; tell Jensen it already went out.` };
    if (done?.status === "confirmed") {
      const ageMs = Date.now() - new Date(done.confirmed_at || done.created_at).getTime();
      return {
        ok: false,
        error: ageMs < 2 * 60_000
          ? `STILL SENDING: that exact send is going out right now. Tell Jensen it is being sent; do not send it again.`
          : `UNKNOWN: I could not confirm whether that exact send went out. Tell Jensen to check before asking me to send it again. Do not send it again now.`,
      };
    }
  }

  const pending = await proposePending({
    party: ctx?.party || "jensen",
    tool: name,
    args: d.args,
    echo: d.echo,
    proposedText: ctx?.lastUser || "",
    proposedInboundId: ctx?.inboundId ?? null,
    channel: "whatsapp",
  });
  if (!pending) {
    return {
      ok: false,
      error:
        `NOT DONE and NOT HELD: I could not set '${name}' up for confirmation just now. ` +
        `Tell Jensen plainly it did not happen and to ask again in a moment. Never say it is done.`,
    };
  }
  return {
    ok: false,
    held: { id: pending.id, echo: pending.echo },
    error:
      `HELD, NOTHING HAS HAPPENED YET. The system shows Jensen this exact question itself ` +
      `(with Yes / No buttons on WhatsApp), so do not repeat or rephrase it: "${pending.echo}" ` +
      `Keep your own reply to one short line or less. Do not say it is done, cleared, removed, ` +
      `cancelled or sent.`,
  };
}

// The question Jensen confirms, written by CODE from the real rows, plus the exact
// args that will execute. Rows that no longer exist are dropped from both, so the
// count he reads is the count that runs.
type Proposal = { echo: string; args: any; nothing?: string };
const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, "'").slice(0, 80)}"`;
function whenOf(date?: string, time?: string): string {
  if (!date) return time || "";
  const d = new Date(`${date}T00:00:00Z`);
  const day = isNaN(d.getTime()) ? date : d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  return time ? `${day} ${String(time).slice(0, 5)}` : day;
}
// He confirms exactly what goes out, so the body is shown in FULL; anything too
// long to show is refused rather than cut (review 4: a truncated body with a
// "remaining characters" note was still being approved unseen).
const MAX_CONFIRMABLE_BODY = 3000;
function fullBody(b: unknown): string {
  return String(b ?? "").trim();
}
function idList(input: any): string[] {
  const raw = Array.isArray(input?.ids) && input.ids.length
    ? input.ids
    : typeof input?.ids === "string" && input.ids.trim()
      ? input.ids.split(/[,\s]+/)
      : [input?.id];
  return [...new Set(raw.map((x: unknown) => String(x ?? "").trim()).filter(Boolean))] as string[];
}
async function oneRow(table: string, id: unknown, cols: string): Promise<any | null> {
  if (id === undefined || id === null || id === "") return null;
  const rows = await sbSelect<any>(table, `select=${cols}&id=eq.${enc(String(id))}&limit=1`);
  return rows?.[0] ?? null;
}
export async function describeProposal(name: string, input: any, ctx?: { party?: string; lastUser?: string }): Promise<Proposal> {
  const gone = (what: string) => ({ echo: "", args: {}, nothing: `that ${what} no longer exists. Re-check before asking Jensen anything.` });
  switch (name) {
    case "delete_event": {
      const ids = idList(input);
      if (!ids.length) return gone("event");
      const rows = await sbSelect<any>("events", `select=id,title,date,time&id=in.(${ids.map(enc).join(",")})`);
      if (!rows.length) return gone("event");
      // Every row he is about to lose is listed; none is hidden behind "and N more"
      // (review 2, finding 8). Same titles are grouped so a reminder series stays short.
      if (rows.length > 25) return { echo: "", args: {}, nothing: `that is ${rows.length} events, too many to confirm safely in one go. Ask Jensen to narrow it by date or name.` };
      rows.sort((a: any, b: any) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
      const args = { ids: rows.map((r: any) => r.id) };
      if (rows.length === 1) return { args, echo: `That removes ${q(rows[0].title)} (${whenOf(rows[0].date, rows[0].time)}) from your calendar. Confirm?` };
      const groups = new Map<string, any[]>();
      for (const r of rows) groups.set(r.title, [...(groups.get(r.title) || []), r]);
      const lines = [...groups.entries()].map(([title, rs]) => `${title}: ${rs.map((r) => whenOf(r.date, r.time)).join(", ")}`);
      return { args, echo: `That removes ${rows.length} from your calendar:\n${lines.join("\n")}\nConfirm?` };
    }
    case "delete_task": {
      const r = await oneRow("tasks", input?.id, "id,title"); if (!r) return gone("task");
      // The wrong-person wall runs when the action is PROPOSED, against the message
      // that asked for it, not only at execution (review 2, finding 3).
      const disc = await discriminatorMismatch({ party: ctx?.party, lastUser: ctx?.lastUser }, String(r.title || ""));
      if (!disc.ok) return { echo: "", args: {}, nothing: `the task ${q(r.title)} is about ${disc.expected}, but Jensen named ${disc.got}. Ask him which one he meant.` };
      return { args: { id: r.id }, echo: `That deletes the task ${q(r.title)}. Confirm?` };
    }
    case "delete_entity": {
      const r = await oneRow("entities", input?.id, "id,name,kind"); if (!r) return gone("entry");
      return { args: { id: r.id }, echo: `That deletes the ${r.kind || "entry"} ${q(r.name)}. Confirm?` };
    }
    case "delete_contact": {
      const r = await oneRow("contacts", input?.id, "id,name"); if (!r) return gone("contact");
      return { args: { id: r.id }, echo: `That deletes the contact ${q(r.name)}. Confirm?` };
    }
    case "delete_note": {
      const r = await oneRow("notes", input?.id, "id,title,body"); if (!r) return gone("note");
      return { args: { id: r.id }, echo: `That deletes the note ${q(r.title || r.body)}. Confirm?` };
    }
    case "delete_document": {
      const r = await oneRow("docs", input?.id, "id,title,file_name"); if (!r) return gone("document");
      return { args: { id: r.id }, echo: `That deletes the document ${q(r.title || r.file_name)}. Confirm?` };
    }
    case "delete_finance": {
      const r = await oneRow("finance", input?.id, "id,label,amount,date,kind"); if (!r) return gone("entry");
      return { args: { id: r.id }, echo: `That deletes the ${r.kind || "finance"} entry ${q(r.label)} (AED ${r.amount}, ${whenOf(r.date)}). Confirm?` };
    }
    case "forget_memory": {
      const r = await oneRow("brain_facts", input?.id, "id,fact"); if (!r) return gone("memory");
      return { args: { id: r.id }, echo: `That forgets: ${q(r.fact)}. Confirm?` };
    }
    case "send_email":
      if (fullBody(input?.body).length > MAX_CONFIRMABLE_BODY) return { echo: "", args: {}, nothing: `that email is ${fullBody(input?.body).length} characters, too long for Jensen to read and approve on WhatsApp. Ask him to shorten it.` };
      // The body he confirms IS the body that sends (review 2, finding 5).
      return { args: input, echo: `That sends this email to ${input?.to}, subject ${q(input?.subject)}:\n\n${fullBody(input?.body)}\n\nSend it?` };
    case "reply_email": {
      if (fullBody(input?.body).length > MAX_CONFIRMABLE_BODY) return { echo: "", args: {}, nothing: `that reply is ${fullBody(input?.body).length} characters, too long for Jensen to read and approve on WhatsApp. Ask him to shorten it.` };
      let to = "";
      try { const f: any = await readUnified(input?.id); to = f?.fromEmail || ""; }
      catch { return { echo: "", args: {}, nothing: "I could not open that email just now. Tell Jensen and try again in a moment; do not say it is gone." }; }
      return { args: input, echo: `That sends this reply to ${to || "the sender"}:\n\n${fullBody(input?.body)}\n\nSend it?` };
    }
    case "send_meeting_invite":
      return { args: input, echo: `That sends ${input?.attendeeName || input?.attendeeEmail} a calendar invite for ${q(input?.title)} on ${whenOf(input?.date, input?.time)} Dubai time. Confirm?` };
    case "call_owner":
      return { args: input, echo: `That rings your phone and says: ${q(input?.message)}. Confirm?` };
    default:
      return { args: input, echo: `That runs ${name.replace(/_/g, " ")}. Confirm?` };
  }
}

// The only way a held action executes. Callers must already hold a CLAIMED
// proposal (claimPending succeeded for this inbound). Runs the stored tool with
// the stored args, re-running the name-mismatch wall against the message that
// ASKED for it (not the bare "yes"), writes a durable audit row, and returns what
// actually happened in words a human reads.
export async function executePending(
  claimed: { id: string; tool: string; args: any; proposed_text: string; echo: string },
  ctx: { party: string; inboundId?: string | null },
): Promise<{ ok: boolean; executedTool: string; outcome: string; result?: any }> {
  // Re-read the rows NOW and rebuild the question. If it no longer matches what he
  // was shown (he moved the meeting, a row was deleted, a name changed), the tap
  // would act on something he did not see, so it does nothing (review 5, #2).
  const now = await describeProposal(claimed.tool, claimed.args, { party: ctx.party, lastUser: claimed.proposed_text }).catch(() => null);
  if (!now || now.nothing || now.echo !== claimed.echo) {
    const { markExecuted } = await import("./pending-actions");
    await markExecuted(claimed.id, { ok: false, error: "changed since shown" });
    return { ok: false, executedTool: claimed.tool, outcome: "That has changed since I asked, so I didn't do it. Ask me again." };
  }
  const r = await runAction(claimed.tool, claimed.args, {
    party: ctx.party,
    lastUser: claimed.proposed_text,
    inboundId: ctx.inboundId,
    confirmedPendingId: claimed.id,
  });
  const outcome = describeOutcome(claimed.tool, r);
  const ok = r.ok && !r.result?.simulated;
  const { markExecuted } = await import("./pending-actions");
  await markExecuted(claimed.id, { ok: r.ok, result: r.result, error: r.error });
  if (ctx.party === "jensen") try {
    const { admin } = await import("@/lib/db");
    await admin().from("chat_messages").insert({
      role: "system",
      channel: "audit",
      party: ctx.party,
      ts: Date.now(),
      content: `confirmed_action: ${claimed.tool} ok=${r.ok} | asked: ${claimed.echo.slice(0, 200)} | outcome: ${outcome}`.slice(0, 500),
    });
  } catch { /* the kv record still holds the outcome */ }
  return { ok, executedTool: claimed.tool, outcome, result: r.result };
}

// What a human reads after a confirmation, derived from what ACTUALLY happened.
// Never "Done" for a failure, never a count that was proposed rather than deleted.
export function describeOutcome(tool: string, r: { ok: boolean; result?: any; error?: string }): string {
  if (!r.ok) {
    // Never show him a raw error, and never promise "nothing changed" for a send:
    // a timeout can happen after the mail already left (review 2, note 9).
    return OUTWARD_SENDS.has(tool)
      ? "I could not confirm that went out. Check before I try again."
      : "That did not go through, so nothing changed.";
  }
  if (r.result?.simulated) return "Test turn: nothing was actually changed.";
  if (tool === "delete_event") {
    const n = Array.isArray(r.result?.deleted) ? r.result.deleted.length : 0;
    if (n === 0) return "Those were already gone, so there was nothing to remove.";
    return n === 1 ? "Done. Removed from your calendar." : `Done. Removed all ${n} from your calendar.`;
  }
  if (tool === "delete_task") return "Done. Off your board.";
  if (tool === "delete_contact") return "Done. Contact removed.";
  if (tool === "delete_note") return "Done. Note removed.";
  if (tool === "delete_document") return "Done. Document removed.";
  if (tool === "delete_finance") return "Done. Entry removed.";
  if (tool === "delete_entity") return "Done. Removed.";
  if (tool === "forget_memory") return "Done. Forgotten.";
  if (tool === "send_email" || tool === "reply_email") return `Sent to ${r.result?.to || "them"}.`;
  if (tool === "send_meeting_invite") return "Invite sent.";
  if (tool === "call_owner") return "Calling you now.";
  return "Done.";
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

export async function runAction(
  name: string,
  rawInput: any,
  ctx?: { party?: string; lastUser?: string; inboundId?: string | null; priorRuns?: number; confirmedPendingId?: string | null; channel?: string },
): Promise<{ ok: boolean; result?: Result; error?: string; held?: { id: string; echo: string } }> {
  try {
    // Confirmation state travels ONLY in ctx, which code builds. Any confirm-ish
    // field on the model's own tool input is discarded here, so an instruction
    // smuggled in through an email or document can never mark an action approved
    // (review blocker C: the old gate honoured input._confirmed).
    const input = stripConfirmFlags(rawInput);

    const gated = await destructiveGate(name, input, ctx);
    if (gated) return gated;
    // Party wall: a non-Jensen (admin/dev/test) turn never persists to Jensen's
    // tenant. Return a simulated result so the model can tell the operator what it
    // WOULD have done, without polluting the client's board / brief / portal.
    if (skipTenantWriteForDev(name, ctx?.party)) {
      return { ok: true, result: { simulated: true, tool: name, persisted: false, note: OUTWARD_SENDS.has(name) ? "Dev/admin turn: nothing was sent (Law 10: test traffic never reaches a real person)." : "Dev/admin turn: not written to Jensen's tenant (single-tenant wall). Change Jensen's real data through his own portal." } };
    }
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
      case "send_task_to_peer": {
        // ADR-0015 cross-bot delegate. Record on Jensen's board (the id is the
        // correlation key for status-backs), then push ONLY the allowlisted fields
        // to Taona's bot. Honest: if the bridge is off or unreachable, we say so
        // and never claim it reached Taona (the honesty rail surfaces the summary).
        const { peerSyncEnabled, toPeerPayload, sendTaskToPeer } = await import("@/lib/peer-sync");
        const created: any = await ops.createTask({ title: String(input.title || ""), due: input.due, quadrant: 3 });
        const correlationId = created?.id;
        if (!peerSyncEnabled() || !correlationId) {
          return { ok: false, error: `Saved *${input.title}* to your board. Sending tasks to Taona is not switched on yet, so it did not go to him.` };
        }
        const r = await sendTaskToPeer(toPeerPayload({ title: String(input.title || ""), due: input.due ?? null, status: "open", correlationId }));
        if (r.skipped) return { ok: false, error: `Saved *${input.title}* to your board. The link to Taona's bot is not configured yet, so it did not go to him.` };
        if (!r.ok) return { ok: false, error: `Saved *${input.title}* to your board, but I could not reach Taona's bot just now, so I have not sent it to him. I will not say it reached him.` };
        result = { ok: true, sent_to: "Taona", title: String(input.title || ""), correlation_id: correlationId } as any;
        break;
      }
      case "update_task": {
        // Wall 2: look up the resolved title BEFORE writing so we can refuse
        // when the operator's last inbound names a different team contact.
        const trow: any[] = await sbSelect("tasks", `id=eq.${enc(String(input.id))}&select=title&limit=1`).catch(() => []);
        const title = String((trow?.[0]?.title) || "");
        const disc = await discriminatorMismatch({ party: ctx?.party, lastUser: ctx?.lastUser }, title);
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
        const disc = await discriminatorMismatch({ party: ctx?.party, lastUser: ctx?.lastUser }, title);
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
        const disc = await discriminatorMismatch({ party: ctx?.party, lastUser: ctx?.lastUser }, title);
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
      // A reminder IS a timed calendar event: that is what the reminder cron pings.
      // Routed through create_event so it gets the same weekday backstop, dev wall
      // and receipt. (16 Sep: "remind me in two weeks" became a task, which is never
      // pushed, while the bot told him "Reminder set for 5 October".)
      // Cancel ONLY. The model may retire a held action when he says "don't send it" /
      // "cancel that" in any words; it can never confirm one (review 4, finding 5).
      case "cancel_held_action": {
        const { findOpenHold, cancelPending } = await import("./pending-actions");
        const open = await findOpenHold(ctx?.party || "jensen", ctx?.channel === "portal" ? "portal" : "whatsapp");
        if (!open) {
          // Nothing was waiting. If something just RAN, say so: never let "cancelled,
          // it won't go out" stand for a send that already went (review 5, #5).
          const { lastExecuted } = await import("./pending-actions");
          const last = await lastExecuted(ctx?.party || "jensen");
          result = {
            ok: false,
            error: last
              ? `Nothing was waiting to cancel. The last one already ran: ${last.echo.split("\n")[0].slice(0, 120)} Tell Jensen plainly it was already done; do not say it was cancelled.`
              : "Nothing was waiting to cancel. Tell Jensen there was nothing pending; do not say anything was cancelled.",
          };
          break;
        }
        await cancelPending(open.id);
        result = { cancelled: true, what: open.echo.split("\n")[0].slice(0, 160) };
        break;
      }
      case "set_reminder": {
        const ev: any = {
          title: String(input.what || input.title || "").trim(),
          date: input.date,
          time: input.time || "09:00",
          note: "Reminder",
          recurrence: input.recurrence || undefined,          // "every Monday" must repeat, not ping once
          recurrenceUntil: input.recurrenceUntil || undefined,
        };
        await reconcileEventDate(ctx, ev);
        // The reminder cron pings 5 minutes ahead and only looks forward, so a
        // reminder less than ~6 minutes out (or already past) would never ping.
        const [hh, mm] = String(ev.time).split(":").map(Number);
        const nowDubai = new Date(Date.now() + 4 * 3_600_000);
        const minsNow = nowDubai.getUTCHours() * 60 + nowDubai.getUTCMinutes();
        const tooSoon = ev.date === dubaiToday() && (hh * 60 + (mm || 0)) < minsNow + 6;
        if (tooSoon && ev.recurrence) {
          // "Every Monday", said on a Monday after 09:00: start from the NEXT one.
          const d = new Date(`${ev.date}T00:00:00Z`);
          if (ev.recurrence === "weekly") d.setUTCDate(d.getUTCDate() + 7);
          else if (ev.recurrence === "monthly") d.setUTCMonth(d.getUTCMonth() + 1);
          else if (ev.recurrence === "yearly") d.setUTCFullYear(d.getUTCFullYear() + 1);
          ev.date = d.toISOString().slice(0, 10);
        } else if (tooSoon) {
          result = { ok: false, error: `${ev.time} today is too soon or already passed for a reminder to ping. Ask Jensen what time he wants it.` };
          break;
        }
        result = await ops.createEvent(ev); break;
      }
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
      case "delete_event": result = await ops.deleteEvent(input.ids?.length ? input.ids : input.id); break;
      case "complete_event": {
        // Wall 2: complete_event was added 2026-06-15 (KT #288) precisely for
        // the "Sara done / Toana done" case. That tool's bug is the same shape
        // as complete_task on Sasa: model picks a calendar event whose title
        // carries a different first name from the one Jensen just named.
        const erow: any[] = await sbSelect("events", `id=eq.${enc(String(input.id))}&select=title&limit=1`).catch(() => []);
        const title = String((erow?.[0]?.title) || "");
        const disc = await discriminatorMismatch({ party: ctx?.party, lastUser: ctx?.lastUser }, title);
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
    // One door: every non-read tool emits its Zanii receipt here, by tool name.
    // Payload is hashed (only a fingerprint hits the ledger). ok is earned from
    // the tool's own result. Fire-and-forget (waitUntil keeps it alive on Vercel).
    if (!ZANII_READS.has(name)) {
      const actionOk = result?.ok !== false && result?.sent !== false;
      // Dynamic import keeps the ESM-only @zanii/sdk out of dispatch's static
      // graph (the eval loader flips to strict-ESM and breaks extensionless
      // imports otherwise). Fire-and-forget; waitUntil inside keeps it alive.
      import("../zanii").then(({ recordAction }) => recordAction(name, { input: input ?? {}, ok: actionOk })).catch(() => {});
    }
    // A handler that caught its own failure returns {ok:false,...}. That used to be
    // wrapped as ok:true, so a failed email read as success to the loop and the
    // honesty rail, and a confirmation could report "Sent." (review blocker E).
    if (result && typeof result === "object" && (result as any).ok === false) {
      return { ok: false, error: String((result as any).error || (result as any).summary || JSON.stringify(result)).slice(0, 500) };
    }
    return { ok: true, result };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

function stripConfirmFlags(input: any): any {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input ?? {};
  const { confirm, _confirmed, confirmed, ...rest } = input as Record<string, unknown>;
  return rest;
}

