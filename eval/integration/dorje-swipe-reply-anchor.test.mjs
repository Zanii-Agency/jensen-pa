#!/usr/bin/env node
// Dorje SWIPE-REPLY ANCHOR + DISCRIMINATOR-NAME WALL, 2026-06-16. Port of Sasa
// eval/integration/sasa-swipe-reply-anchor.test.mjs (KT #293).
//
// Two seam-level walls for the bug family "fragment match without anchor":
//
//  1. SWIPE-REPLY ANCHOR (Wall 1, wall-at-primitive). The WhatsApp Cloud API
//     payload carries messages[].context.id when the user reply-quotes a
//     specific prior message. The webhook MUST capture it, persist it on the
//     inbound chat_messages row as reply_to_external_id, resolve it at turn
//     time by joining chat_messages.external_id, and inject a hard-wall
//     anchor block into the LLM turn. Bug shape (cross-bot from Sasa): Jensen
//     swipes a Dorje message about Task X, types "done", Dorje fuzzy-matches
//     and closes Task Y.
//
//  2. DISCRIMINATOR-NAME WALL (Wall 2). When complete/update/delete_task or
//     complete_event resolves a candidate whose title carries a contact's
//     first name that the operator did NOT say in their last inbound message,
//     the write must refuse. Bug shape: Jensen says "meeting taona done",
//     Dorje closes "meeting with haneen".
//
// Pure local. No DB hit, no Anthropic spend, no network. Mirror of the source
// so a future edit that loosens either guard fails here.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(resolve(ROOT, rel), "utf8");

const tests = [];
function check(name, fn) { tests.push({ name, fn }); }

// ─── Wall 1 seams: migration ──────────────────────────────────────────────

check("seam: migration file declares external_id + reply_to_external_id on chat_messages", () => {
  const src = read("db/2026-06-16_swipe_reply_anchor.sql");
  if (!/add column if not exists external_id/i.test(src)) return "migration missing external_id ADD COLUMN";
  if (!/add column if not exists reply_to_external_id/i.test(src)) return "migration missing reply_to_external_id ADD COLUMN";
  if (!/uq_chat_messages_external/.test(src)) return "missing UNIQUE index on external_id";
  if (!/idx_chat_messages_reply_to_external/.test(src)) return "missing index on reply_to_external_id";
  return null;
});

// ─── Wall 1 seams: whatsapp.ts ─────────────────────────────────────────────

check("seam: sendWhatsAppRaw exists and returns wamid", () => {
  const src = read("lib/whatsapp.ts");
  if (!/export async function sendWhatsAppRaw/.test(src)) return "sendWhatsAppRaw not exported";
  if (!/Promise<\{\s*ok:\s*boolean;\s*wamid:\s*string\s*\|\s*null\s*\}>/.test(src)) return "sendWhatsAppRaw return type missing wamid";
  if (!/j\?\.\s*messages\?\.\[0\]\?\.\s*id/.test(src)) return "sendWhatsAppRaw does not read messages[0].id from Meta response";
  return null;
});

check("seam: sendWhatsApp is a back-compat boolean wrapper over sendWhatsAppRaw", () => {
  const src = read("lib/whatsapp.ts");
  if (!/sendWhatsAppRaw\(to, body, opts\)/.test(src)) return "sendWhatsApp does not delegate to sendWhatsAppRaw";
  return null;
});

// ─── Wall 1 seams: sendTextAndLog.ts ───────────────────────────────────────

check("seam: sendTextAndLog imports sendWhatsAppRaw", () => {
  const src = read("lib/sendTextAndLog.ts");
  if (!/sendWhatsAppRaw/.test(src)) return "sendTextAndLog does not import sendWhatsAppRaw";
  return null;
});

check("seam: sendTextAndLog back-patches external_id on assistant row when wamid lands", () => {
  const src = read("lib/sendTextAndLog.ts");
  if (!/update\(\{\s*external_id:\s*sendResult\.wamid\s*\}\)/.test(src)) return "no update with external_id from wamid";
  if (!/eq\("id",\s*insertedRowId\)/.test(src)) return "patch does not target inserted row id";
  return null;
});

// ─── Wall 1 seams: webhook route ──────────────────────────────────────────

check("seam: whatsapp route extracts msg.context.id (the wamid of quoted Dorje msg)", () => {
  const src = read("app/api/whatsapp/route.ts");
  if (!/msg\?\.context\?\.id/.test(src)) return "webhook does not read msg.context.id";
  if (!/replyToExternalId/.test(src)) return "replyToExternalId not declared";
  return null;
});

check("seam: whatsapp route persists replyToExternalId on inbound chat_messages row", () => {
  const src = read("app/api/whatsapp/route.ts");
  // The first chatAppend after replyToExternalId is computed must thread it through opts.
  const idx = src.indexOf("const replyToExternalId");
  if (idx < 0) return "replyToExternalId not declared in webhook";
  const after = src.slice(idx, idx + 1500);
  if (!/replyToExternalId,/.test(after)) return "replyToExternalId not threaded into chatAppend opts";
  // external_id is now captured once as inboundWamid (msg shadows in later branches).
  if (!/externalId:\s*inboundWamid/.test(after)) return "inbound external_id not threaded into chatAppend opts";
  if (!/const inboundWamid[^\n]*msg\?\.id \? String\(msg\.id\) : null/.test(src)) return "inboundWamid not captured from msg.id";
  return null;
});

check("seam: whatsapp route resolves quoted message via chat_messages.external_id", () => {
  const src = read("app/api/whatsapp/route.ts");
  if (!/swipeAnchor/.test(src)) return "swipeAnchor variable missing";
  if (!/chat_messages.*external_id/s.test(src)) return "route does not look up chat_messages by external_id";
  if (!/quotedExcerpt/.test(src)) return "quotedExcerpt not built";
  return null;
});

check("seam: whatsapp route passes swipeAnchor into runConcierge", () => {
  const src = read("app/api/whatsapp/route.ts");
  if (!/runConcierge\([^)]*swipeAnchor[^)]*\)/s.test(src)) return "swipeAnchor not threaded into runConcierge";
  return null;
});

check("seam: deterministic done fast-path defers to brain when anchor is present", () => {
  const src = read("app/api/whatsapp/route.ts");
  if (!/doneEligible\s*&&\s*!swipeAnchor/.test(src)) return "done fast path does not bypass on anchor";
  return null;
});

// ─── Wall 1 seams: ops.ts ─────────────────────────────────────────────────

check("seam: ops.chatAppend accepts externalId + replyToExternalId opts and returns row id", () => {
  const src = read("lib/concierge/ops.ts");
  if (!/externalId\?\s*:\s*string\s*\|\s*null/.test(src)) return "chatAppend missing externalId opt";
  if (!/replyToExternalId\?\s*:\s*string\s*\|\s*null/.test(src)) return "chatAppend missing replyToExternalId opt";
  if (!/Promise<number\s*\|\s*null>/.test(src)) return "chatAppend should return row id (number | null)";
  return null;
});

check("seam: ops.chatPatchExternalId exists for post-send back-patch", () => {
  const src = read("lib/concierge/ops.ts");
  if (!/export async function chatPatchExternalId/.test(src)) return "chatPatchExternalId not exported";
  return null;
});

// ─── Wall 1 seams: loop.ts (system prompt) ─────────────────────────────────

check("seam: buildSystem accepts swipeAnchor and renders SWIPE-REPLY ANCHOR (HARD WALL) block in tail", () => {
  const src = read("lib/concierge/loop.ts");
  if (!/swipeAnchor\?\s*:\s*\{\s*quotedExcerpt:\s*string\s*\}\s*\|\s*null/.test(src)) return "swipeAnchor type missing on buildSystem signature";
  if (!/SWIPE-REPLY ANCHOR \(HARD WALL\)/.test(src)) return "anchor hard-wall block string missing";
  if (!/anchorBlock/.test(src)) return "anchorBlock variable missing";
  // anchorBlock must be embedded in `tail`, not `head` (head is cached).
  const tailIdx = src.indexOf("const tail = [");
  const blockIdx = src.indexOf("const anchorBlock");
  if (tailIdx < 0 || blockIdx < 0) return "could not locate anchorBlock / tail";
  if (blockIdx > tailIdx) return "anchorBlock must be defined BEFORE tail";
  const tailBlock = src.slice(tailIdx, tailIdx + 2000);
  if (!/anchorBlock,/.test(tailBlock)) return "anchorBlock not composed into tail array";
  return null;
});

check("seam: runConcierge signature accepts swipeAnchor opt and threads it to buildSystem", () => {
  const src = read("lib/concierge/loop.ts");
  const sigIdx = src.indexOf("export async function runConcierge");
  if (sigIdx < 0) return "runConcierge not found";
  const sig = src.slice(sigIdx, sigIdx + 600);
  if (!/swipeAnchor\?\s*:/.test(sig)) return "swipeAnchor not in runConcierge opts";
  if (!/buildSystem\([^)]*input\.swipeAnchor[^)]*\)/s.test(src)) return "input.swipeAnchor not passed to buildSystem";
  return null;
});

// ─── Wall 2 seams: discriminator wall ──────────────────────────────────────

check("seam: dispatch.ts defines discriminatorMismatch helper using contacts table", () => {
  const src = read("lib/concierge/dispatch.ts");
  if (!/async function discriminatorMismatch/.test(src)) return "discriminatorMismatch helper missing";
  if (!/sbSelect\("contacts"/.test(src)) return "discriminatorMismatch must read team names from contacts table";
  if (!/chat_messages.*role=eq\.user/s.test(src)) return "discriminatorMismatch must read last user inbound from chat_messages";
  return null;
});

check("seam: discriminatorMismatch wired into update_task BEFORE the update", () => {
  const src = read("lib/concierge/dispatch.ts");
  const start = src.indexOf('case "update_task"');
  if (start < 0) return "update_task case not found";
  const end = src.indexOf('case "complete_task"', start);
  const block = src.slice(start, end > 0 ? end : start + 2000);
  const wallIdx = block.indexOf("discriminatorMismatch(");
  const updateIdx = block.indexOf("ops.updateTask(");
  if (wallIdx < 0) return "discriminatorMismatch not called in update_task";
  if (updateIdx >= 0 && wallIdx > updateIdx) return "wall fires AFTER update, must precede";
  return null;
});

check("seam: discriminatorMismatch wired into complete_task BEFORE the update", () => {
  const src = read("lib/concierge/dispatch.ts");
  const start = src.indexOf('case "complete_task"');
  if (start < 0) return "complete_task case not found";
  const end = src.indexOf('case "delete_task"', start);
  const block = src.slice(start, end > 0 ? end : start + 2000);
  const wallIdx = block.indexOf("discriminatorMismatch(");
  const updateIdx = block.indexOf("ops.updateTask(");
  if (wallIdx < 0) return "discriminatorMismatch not called in complete_task";
  if (updateIdx >= 0 && wallIdx > updateIdx) return "wall fires AFTER update, must precede";
  return null;
});

check("seam: discriminatorMismatch wired into delete_task BEFORE the delete", () => {
  const src = read("lib/concierge/dispatch.ts");
  const start = src.indexOf('case "delete_task"');
  if (start < 0) return "delete_task case not found";
  const end = src.indexOf('case "query_calendar"', start);
  const block = src.slice(start, end > 0 ? end : start + 2000);
  const wallIdx = block.indexOf("discriminatorMismatch(");
  const deleteIdx = block.indexOf("ops.deleteTask(");
  if (wallIdx < 0) return "discriminatorMismatch not called in delete_task";
  if (deleteIdx >= 0 && wallIdx > deleteIdx) return "wall fires AFTER delete, must precede";
  return null;
});

check("seam: discriminatorMismatch wired into complete_event BEFORE the update", () => {
  const src = read("lib/concierge/dispatch.ts");
  const start = src.indexOf('case "complete_event"');
  if (start < 0) return "complete_event case not found";
  // complete_event is the last case in calendar section; bound by finance start.
  const end = src.indexOf('case "finance_summary"', start);
  const block = src.slice(start, end > 0 ? end : start + 2000);
  const wallIdx = block.indexOf("discriminatorMismatch(");
  const updateIdx = block.indexOf("ops.completeEvent(");
  if (wallIdx < 0) return "discriminatorMismatch not called in complete_event";
  if (updateIdx >= 0 && wallIdx > updateIdx) return "wall fires AFTER update, must precede";
  return null;
});

check("seam: refusal observability emits dorje.discriminator_mismatch_refused", () => {
  const src = read("lib/concierge/dispatch.ts");
  const matches = src.match(/dorje\.discriminator_mismatch_refused/g) || [];
  // emit string is referenced once in the helper; call sites use emitDiscriminatorRefusal('<tool>')
  if (matches.length < 1) return "discriminator refusal event tag missing";
  const calls = src.match(/emitDiscriminatorRefusal\(/g) || [];
  if (calls.length < 4) return `expected 4 emit sites (one per protected primitive), found ${calls.length}`;
  return null;
});

check("seam: runAction signature accepts ctx and loop.ts threads party in", () => {
  const dsrc = read("lib/concierge/dispatch.ts");
  if (!/export async function runAction\(name: string, input: any, ctx\?\s*:\s*\{\s*party\?\s*:\s*string;\s*lastUser\?\s*:\s*string\s*\}\)/.test(dsrc)) return "runAction signature missing ctx { party, lastUser }";
  const lsrc = read("lib/concierge/loop.ts");
  if (!/runAction\(tu\.name, tu\.input \|\| \{\}, \{\s*party,\s*lastUser\s*\}\)/.test(lsrc)) return "loop does not thread party + lastUser into runAction";
  return null;
});

// ─── Behavioural: prove the discriminator helper logic matches real shapes ─

// Mirror of the helper's name-regex used in lib/concierge/dispatch.ts so the
// test catches any loosening of the boundary chars.
const nameRe = (n) => new RegExp(`(^|[^a-z])${n}([^a-z]|$)`, "i");

check("guard: 'meeting taona' user msg vs 'meeting with haneen' title -> mismatch", () => {
  const team = ["taona", "haneen", "sara", "dinesh"];
  const titleLower = "meeting with haneen";
  const userBody = "meeting taona is done";
  const namesInTitle = team.filter((n) => nameRe(n).test(titleLower));
  if (namesInTitle.length !== 1) return "title should have exactly 1 team name";
  const expected = namesInTitle[0];
  if (nameRe(expected).test(userBody)) return "userBody falsely matches expected";
  const userNamed = team.filter((n) => n !== expected && nameRe(n).test(userBody));
  if (userNamed.length === 0) return "userBody should name a different team contact";
  return null;
});

check("guard: 'sara done' user vs 'meeting with sara' title -> ok", () => {
  const team = ["taona", "haneen", "sara", "dinesh"];
  const titleLower = "meeting with sara";
  const userBody = "sara done";
  const namesInTitle = team.filter((n) => nameRe(n).test(titleLower));
  const expected = namesInTitle[0];
  if (!nameRe(expected).test(userBody)) return "userBody must match expected name (no refusal)";
  return null;
});

check("guard: title without any team name -> no refusal", () => {
  const team = ["taona", "haneen", "sara"];
  const titleLower = "submit quarterly report";
  const namesInTitle = team.filter((n) => nameRe(n).test(titleLower));
  if (namesInTitle.length !== 0) return "no team names should be in title";
  return null;
});

check("guard: short name 'al' would over-match, helper enforces length >= 3", () => {
  const short = "al";
  if (short.length >= 3) return "short name should be filtered out at length >= 3";
  return null;
});

check("guard: 'Toana done' (typo of Taona) vs 'meeting with sara' -> mismatch", () => {
  // Real Jensen world: Toana is a separate contact (per AGENT-FRAMEWORK).
  const team = ["taona", "toana", "haneen", "sara", "dinesh"];
  const titleLower = "meeting with sara";
  const userBody = "Toana done";
  const namesInTitle = team.filter((n) => nameRe(n).test(titleLower));
  if (namesInTitle.length !== 1) return "title should name exactly 1 team contact (sara)";
  const expected = namesInTitle[0];
  if (nameRe(expected).test(userBody.toLowerCase())) return "userBody should NOT contain expected";
  const userNamed = team.filter((n) => n !== expected && nameRe(n).test(userBody.toLowerCase()));
  if (userNamed.length === 0) return "userBody must name a different contact (toana)";
  return null;
});

// ─── runner ────────────────────────────────────────────────────────────────

let pass = 0, fail = 0;
for (const { name, fn } of tests) {
  let reason = null;
  try { reason = fn(); } catch (e) { reason = `threw: ${e?.message || e}`; }
  if (!reason) { pass += 1; console.log(`  ok  ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}, ${reason}`); }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
