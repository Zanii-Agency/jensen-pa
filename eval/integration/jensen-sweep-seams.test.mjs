#!/usr/bin/env node
// Jensen sweep seam-eval. Pure static-code assertions on the architectural
// promises this sweep depends on. No Anthropic spend, no DB hit, no network.
// Modelled after nisria-techops eval/integration/seam-9-message-battery.test.mjs.
//
// Each check returns { name, ok, reason }. The runner prints a table and exits
// non-zero on any failure. This is the eval that gates Phase 3 — write failing
// tests first (HOW-TO-SWEEP step 3, KT #126), only commit fixes when this
// passes. Then promote to prod-harness for behavioural verification.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(resolve(ROOT, rel), "utf8");

const tests = [];
function check(name, fn) { tests.push({ name, fn }); }

// ============================================================================
// LOCKDOWN SEAMS (Phase 0 surface)
// ============================================================================

check("seam.01 middleware.ts has MAINTENANCE_MODE gate", () => {
  const src = read("middleware.ts");
  if (!/MAINTENANCE_MODE/.test(src)) return "no MAINTENANCE_MODE reference";
  if (!/MAINTENANCE_ADMIN_TOKEN/.test(src)) return "no MAINTENANCE_ADMIN_TOKEN reference";
  if (!/maintenance_admin/.test(src)) return "no maintenance_admin cookie";
  if (!/\/maintenance/.test(src)) return "no /maintenance redirect target";
  return null;
});

check("seam.02 middleware.ts URL grant ?admin=<token> sets cookie", () => {
  const src = read("middleware.ts");
  if (!/searchParams\.get\(['"]admin['"]\)/.test(src)) return "no ?admin search-param read";
  if (!/res\.cookies\.set\(["']maintenance_admin["']/.test(src)) return "URL grant does not set cookie";
  return null;
});

check("seam.03 /login is walled during maintenance (not in pre-maintenance public)", () => {
  const src = read("middleware.ts");
  // AUTH_PUBLIC must be defined AND must be consulted AFTER the maintenance gate
  const maintIdx = src.indexOf("MAINTENANCE_MODE");
  const authPublicIdx = src.indexOf("AUTH_PUBLIC");
  if (authPublicIdx === -1) return "AUTH_PUBLIC constant missing";
  if (maintIdx === -1) return "MAINTENANCE_MODE missing";
  // AUTH_PUBLIC must be used after the maintenance block — meaning the bypass
  // happens AFTER the maintenance gate, so /login still hits maintenance first.
  const authPublicUse = src.lastIndexOf("AUTH_PUBLIC.some");
  if (authPublicUse < maintIdx) return "AUTH_PUBLIC bypass runs before MAINTENANCE gate (login leaks)";
  return null;
});

check("seam.04 lib/whatsapp.ts:sendWhatsApp has JENSEN_MODE chokepoint", () => {
  const src = read("lib/whatsapp.ts");
  if (!/JENSEN_MODE/.test(src)) return "no JENSEN_MODE reference";
  if (!/TRAINING/.test(src)) return "no TRAINING value reference";
  if (!/MAINTENANCE_ALLOWLIST/.test(src)) return "no allowlist reference";
  if (!/force/.test(src)) return "no force-bypass parameter (one-shot notice would loop)";
  // The gate must run BEFORE the actual fetch
  const gateIdx = src.indexOf("JENSEN_MODE");
  const fetchIdx = src.indexOf("graph.facebook.com");
  if (gateIdx === -1 || fetchIdx === -1) return "structure unexpected";
  if (gateIdx > fetchIdx) return "gate runs AFTER fetch (would send and then check)";
  return null;
});

check("seam.05 WA route POST has shouldProcess BEFORE maintenance BEFORE isOwner", () => {
  const src = read("app/api/whatsapp/route.ts");
  const shouldProcessIdx = src.indexOf("shouldProcess(");
  const maintIdx = src.indexOf('JENSEN_MODE === "TRAINING"');
  const ownerIdx = src.indexOf("if (!isOwner(");
  if (shouldProcessIdx === -1) return "shouldProcess dedup call not present at top of POST";
  if (maintIdx === -1) return "no JENSEN_MODE check in WA route";
  if (ownerIdx === -1) return "isOwner gate not present";
  // shouldProcess must come FIRST (immediately after EARLY SAVE)
  if (maintIdx < shouldProcessIdx) return "maintenance gate runs before shouldProcess (would notify on retries before dedup)";
  if (maintIdx > ownerIdx) return "maintenance gate runs after isOwner (would leak 'private line' notice)";
  // Assert seenByWamid callback exists (passes through to atomic wa_seen insert)
  const callbackBlock = src.slice(shouldProcessIdx, maintIdx);
  if (!/seenByWamid/.test(callbackBlock)) return "shouldProcess call lacks seenByWamid callback (dedup path missing)";
  if (!/logToChat/.test(callbackBlock)) return "shouldProcess call lacks logToChat callback (media-buffer chat logging missing)";
  return null;
});

check("seam.06 WA route silent-drops non-allowlisted in TRAINING (no notice to Jensen)", () => {
  const src = read("app/api/whatsapp/route.ts");
  // Per Taona directive (2026-06-09): Jensen must NOT receive a "training in progress"
  // notice. The TRAINING gate must silent-drop everyone not on MAINTENANCE_ALLOWLIST.
  const idx = src.indexOf('JENSEN_MODE === "TRAINING"');
  if (idx === -1) return "TRAINING gate block not found";
  // Slice only the TRAINING if-block. ~345 chars to the outer close, +60 buffer
  // for the comment before the next sendWhatsApp call (so we never read it).
  const block = src.slice(idx, idx + 400);
  if (/sendWhatsApp\(/.test(block)) return "TRAINING gate still calls sendWhatsApp (would leak to Jensen)";
  if (/maintenance_notice_/.test(block)) return "TRAINING gate still references old per-day notice key";
  if (!/return NextResponse\.json\(\{\s*ok:\s*true\s*\}\)/.test(block)) return "TRAINING gate does not early-return ok";
  return null;
});

// ============================================================================
// DEDUP SEAMS — FM-02 (the "Memorae's worst bug" comment must remain)
// ============================================================================

check("seam.07 ops.createTask soft-dedupes on title + done=false", () => {
  const src = read("lib/concierge/ops.ts");
  const createTaskBlock = src.slice(src.indexOf("export async function createTask"));
  if (!/title=eq\./.test(createTaskBlock.slice(0, 1500))) return "no title equality filter in createTask";
  if (!/done=is\.false/.test(createTaskBlock.slice(0, 1500))) return "no done=false filter in createTask dedup";
  if (!/deduped:\s*true/.test(createTaskBlock.slice(0, 1500))) return "createTask does not return deduped:true";
  return null;
});

check("seam.08 ops.createEvent soft-dedupes on normalized-title + date", () => {
  const src = read("lib/concierge/ops.ts");
  const block = src.slice(src.indexOf("export async function createEvent"));
  // Updated 2026-06-13: dedup now uses normalizeEventTitleKey to collapse the
  // 'X at <location>' vs 'X' (with note) variants seen in the Karafotias
  // regression. Old shape (title=eq exact) is no longer accepted.
  if (!/normalizeEventTitleKey/.test(block.slice(0, 1500))) return "createEvent dedup does not use normalizeEventTitleKey";
  if (!/date=eq\./.test(block.slice(0, 1500))) return "no date eq in createEvent dedup";
  if (!/deduped:\s*true/.test(block.slice(0, 1500))) return "createEvent does not return deduped:true";
  return null;
});

// ============================================================================
// BRAIN SEAMS
// ============================================================================

check("seam.09 brain.recall uses RRF fusion across vector + lexical arms", () => {
  const src = read("lib/concierge/brain.ts");
  if (!/rrf/.test(src)) return "no rrf helper used in brain.ts";
  if (!/match_brain_facts/.test(src)) return "no pgvector RPC call for facts";
  if (!/ilike/.test(src)) return "no ILIKE lexical arm for facts (RRF needs both arms)";
  if (!/match_doc_chunks/.test(src)) return "no pgvector RPC for docs";
  return null;
});

check("seam.10 brain.captureSalience exported AND wired into runConcierge", () => {
  const brainSrc = read("lib/concierge/brain.ts");
  if (!/export async function captureSalience/.test(brainSrc)) return "captureSalience not exported";
  const loopSrc = read("lib/concierge/loop.ts");
  if (!/captureSalience/.test(loopSrc)) return "captureSalience not referenced in loop.ts";
  return null;
});

check("seam.11 standing directives injected into system prompt", () => {
  const src = read("lib/concierge/loop.ts");
  if (!/listDirectives/.test(src)) return "loop does not load directives";
  if (!/STANDING INSTRUCTIONS/.test(src)) return "directives marker absent from system prompt";
  return null;
});

// ============================================================================
// VERIFIER SEAM — FM-01, FM-06 (anti-fake-done)
// ============================================================================

check("seam.12 honesty rail replaces fail-open verify; lie-engine patterns gone", () => {
  const railSrc = read("lib/concierge/honest-reply.ts");
  if (!/export async function honestReply/.test(railSrc)) return "honestReply not exported";
  const loopSrc = read("lib/concierge/loop.ts");
  if (!/honestReply\(/.test(loopSrc)) return "honestReply not called in loop";
  // Prevention, not detection: the old lie-engine must be gone.
  if (/reply\s*=\s*"Done\."/.test(loopSrc)) return "empty reply still becomes \"Done.\"";
  if (/Honest note/.test(loopSrc)) return "still appends a contradicting honest note after a claim";
  return null;
});

check("seam.13b day_log wall: date-bounded activity tool wired end-to-end", () => {
  if (!/export async function dayLog/.test(read("lib/concierge/ops.ts"))) return "ops.dayLog not exported";
  if (!/name: "day_log"/.test(read("lib/concierge/tools.ts"))) return "day_log tool not defined";
  if (!/case "day_log":\s*result = await ops\.dayLog/.test(read("lib/concierge/dispatch.ts"))) return "day_log not dispatched";
  const loopSrc = read("lib/concierge/loop.ts");
  if (!/DAY ACTIVITY/.test(loopSrc)) return "DAY ACTIVITY rule missing from system prompt";
  if (!/day_log/.test(loopSrc)) return "system prompt does not point day questions at day_log";
  return null;
});

check("seam.32 fail-closed reply: brain errors never go silent", () => {
  const src = read("app/api/whatsapp/route.ts");
  if (!/catch \(brainErr/.test(src)) return "no fail-closed catch around runConcierge";
  if (!/reply_failed:/.test(src)) return "brain failure not logged to audit channel";
  if (!/I hit a snag/.test(src)) return "no honest fallback message sent to the user on failure";
  return null;
});

check("seam.33 chatAppend idempotent on external_id (no double-save)", () => {
  const ops = read("lib/concierge/ops.ts");
  const fn = ops.slice(ops.indexOf("export async function chatAppend"));
  if (!/external_id=eq\.\$\{enc\(opts\.externalId\)\}/.test(fn)) return "chatAppend does not dedupe on external_id";
  if (!/earlyText, "whatsapp", party, \{ externalId/.test(read("app/api/whatsapp/route.ts"))) return "early-save does not pass the WhatsApp id";
  return null;
});

check("seam.34 reminder surfaces the meeting link at reminder time", () => {
  const src = read("app/api/cron/reminders/route.ts");
  if (!/ev\.meeting_url/.test(src)) return "reminder body does not include the meeting link";
  return null;
});

check("seam.35 meeting link: saved onto event; future scheduled, ad-hoc/now joined immediately, dispatch awaited", () => {
  const src = read("app/api/whatsapp/route.ts");
  if (!/meeting_url: anyLink/.test(src)) return "meeting link not saved onto the event";
  if (!/scheduledAt: future \?/.test(src)) return "future calendar match is not scheduled at meeting time";
  if (!/const d = await dispatchMeetingBot/.test(src)) return "dispatch is not awaited (serverless can SIGTERM a fire-and-forget dispatch before it lands)";
  if (!/sending Digital Jensen into/i.test(src)) return "no immediate-join path for ad-hoc / now meetings";
  if (!/could not reach my note-taker/.test(src)) return "ack does not honestly report a dispatch failure";
  if (!/reminder so you can/.test(src)) return "future-scheduled ack does not promise the link in the reminder";
  return null;
});

check("seam.36 complete_event writes a constraint-allowed outcome", () => {
  const src = read("lib/concierge/ops.ts");
  const fn = src.slice(src.indexOf("export async function completeEvent"));
  if (/outcome: "completed"/.test(fn)) return "completeEvent writes 'completed' which the CHECK constraint rejects";
  if (!/outcome: "(happened|empty|awaiting_human_verdict|resolved_by_email)"/.test(fn)) return "completeEvent does not write an allowed outcome";
  return null;
});

check("seam.37 draft-only doc tools are not completion tools", () => {
  const src = read("lib/concierge/tools.ts");
  const i = src.indexOf("COMPLETION_TOOLS = new Set");
  const set = src.slice(i, i + 700);
  if (/"generate_document"/.test(set)) return "generate_document still in COMPLETION_TOOLS (can back a fake 'filed')";
  if (/"generate_legal"/.test(set)) return "generate_legal still in COMPLETION_TOOLS";
  return null;
});

check("seam.38 sanad marks delivered only on a real send", () => {
  const src = read("app/api/cron/sanad-deliver/route.ts");
  if (!/status: msgId \? "delivered" : "processing"/.test(src)) return "sanad-deliver records delivered even when the send failed";
  return null;
});

check("seam.39 reminder latches before sending (no duplicate spam)", () => {
  const src = read("app/api/cron/reminders/route.ts");
  if (!/if \(!latched\) continue/.test(src)) return "reminder sends before latching reminded_at (can spam every tick on latch failure)";
  return null;
});

check("seam.40 briefs never claim 'clean board' on a read error", () => {
  if (!/readFailed/.test(read("app/api/cron/daily/route.ts"))) return "daily brief does not guard against query failure";
  if (!/readFailed/.test(read("app/api/cron/evening/route.ts"))) return "evening brief does not guard against query failure";
  return null;
});

check("seam.41 meeting-link ack reads the row back before saying 'Saved' (no PATCH-flag trust)", () => {
  const src = read("app/api/whatsapp/route.ts");
  // Phase 1: saved must be derived from a READ-BACK of the row, not the PATCH ok
  // flag (which lied "saved in notes"). The strengthened invariant.
  if (!/const patchedOk = await fetch/.test(src)) return "PATCH ok flag not captured (F4: idempotent/failed write could falsely claim saved)";
  if (!/saved = patchedOk &&/.test(src)) return "saved does not require the PATCH to have succeeded this turn";
  if (!/meeting_url === anyLink/.test(src)) return "saved is not derived from a read-back equality on the stored link";
  if (!/saved\s*\?/.test(src)) return "ack does not branch on whether the save succeeded";
  return null;
});

check("seam.42 aggregateInbox throws when ALL mail accounts fail", () => {
  if (!/errors === accounts\.length/.test(read("lib/mail-provider.ts"))) return "aggregateInbox cannot tell all-failed from empty (false 'inbox clear' risk)";
  return null;
});

check("seam.43 every inbound save carries the WhatsApp id (converges to one row)", () => {
  const src = read("app/api/whatsapp/route.ts");
  const calls = src.match(/chatAppend\("user"[^;]*/g) || [];
  // All inbound user-saves must pass externalId so chatAppend's idempotency
  // dedupes them. The one allowed exception is the shouldProcess buffer-flush
  // callback (saves a DIFFERENT buffered message, no clean wamid).
  const missing = calls.filter((c) => !/externalId/.test(c));
  if (missing.length > 1) return `${missing.length} inbound saves missing externalId (will duplicate)`;
  return null;
});

check("seam.44 complete_event is a completion tool (its success must not be rewritten)", () => {
  const src = read("lib/concierge/tools.ts");
  const i = src.indexOf("COMPLETION_TOOLS = new Set");
  const set = src.slice(i, i + 760);
  if (!/"complete_event"/.test(set)) return "complete_event missing from COMPLETION_TOOLS: the honesty rail would rewrite 'marked done' into a lie";
  return null;
});

check("seam.45 media-buffer flush dedups against the early-save (no phantom double)", () => {
  const src = read("app/api/whatsapp/route.ts");
  const i = src.indexOf("logToChat: async");
  const cb = src.slice(i, i + 1100);
  if (!/content=eq\.\$\{enc\(t\)\}/.test(cb)) return "logToChat flush does not check for an existing identical row";
  if (!/< 120000/.test(cb)) return "no recency window on the flush dedup";
  return null;
});

check("seam.13 honesty rail uses COMPLETION_TOOLS set, not heuristic", () => {
  const src = read("lib/concierge/honest-reply.ts");
  if (!/COMPLETION_TOOLS/.test(src)) return "honesty rail doesn't reference COMPLETION_TOOLS";
  const toolsSrc = read("lib/concierge/tools.ts");
  if (!/COMPLETION_TOOLS/.test(toolsSrc)) return "COMPLETION_TOOLS not exported from tools.ts";
  return null;
});

// ============================================================================
// DISPATCH SEAM — every TOOL has a runner
// ============================================================================

check("seam.14 every named tool in tools.ts has a dispatch case in dispatch.ts", () => {
  const toolsSrc = read("lib/concierge/tools.ts");
  const dispatchSrc = read("lib/concierge/dispatch.ts");
  const toolNames = [...toolsSrc.matchAll(/name:\s*"([a-z_]+)"/g)].map((m) => m[1]);
  if (!toolNames.length) return "no tool names parsed from tools.ts";
  const missing = toolNames.filter((n) => !new RegExp(`["'\\s]${n}["'\\s]`).test(dispatchSrc));
  if (missing.length) return `tools missing dispatch case: ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? "…" : ""}`;
  return null;
});

// ============================================================================
// PERSONA SEAM — FM-08 (warm answer), tone tree
// ============================================================================

check("seam.15 system prompt establishes Rencontre persona in first person", () => {
  const src = read("lib/concierge/loop.ts");
  if (!/Rencontre/.test(src)) return "persona name 'Rencontre' missing";
  if (!/first person/i.test(src)) return "first person discipline missing";
  if (!/Jensen/.test(src)) return "user name Jensen missing from prompt";
  return null;
});

check("seam.16 NO_DASHES discipline appended (JENSEN-DOCTRINE Law 5)", () => {
  const anthropicSrc = read("lib/anthropic.ts");
  if (!/NO_DASHES/.test(anthropicSrc)) return "NO_DASHES constant missing";
  const loopSrc = read("lib/concierge/loop.ts");
  if (!/NO_DASHES/.test(loopSrc)) return "NO_DASHES not referenced in system prompt";
  return null;
});

// ============================================================================
// TASK LIST ORDERING — FM-05 (drift between user-pasted list and rendered)
// ============================================================================

check("seam.17 listTasks order is deterministic (created_at descending)", () => {
  const src = read("lib/concierge/ops.ts");
  const block = src.slice(src.indexOf("export async function listTasks"));
  if (!/order=/.test(block.slice(0, 600))) return "listTasks has no order clause (output drifts between calls)";
  return null;
});

check("seam.18 WA route has deterministic DONE-resolution before runConcierge", () => {
  const src = read("app/api/whatsapp/route.ts");
  if (!/DETERMINISTIC DONE-RESOLUTION/.test(src)) return "no DONE-resolution comment marker";
  // The regex match for bare 'done' must run BEFORE the runConcierge call
  const doneIdx = src.indexOf("done|done\\.|did it|yes done");
  const conciergeIdx = src.indexOf("runConcierge({");
  // Both indexes must exist and DONE must come first (it shortcircuits)
  if (doneIdx === -1) return "no bare-done regex";
  // There are multiple runConcierge calls (media path uses one); find the LAST plain-text one
  const plainTextConcierge = src.lastIndexOf("runConcierge({ messages: [...history, { role: \"user\", content: turnInput }]");
  if (plainTextConcierge === -1) return "could not locate plain-text runConcierge dispatch";
  if (doneIdx > plainTextConcierge) return "DONE-resolution runs AFTER runConcierge (would never short-circuit)";
  return null;
});

check("seam.19 system prompt injects RECENT OPEN TASKS with ids", () => {
  const src = read("lib/concierge/loop.ts");
  if (!/RECENT OPEN TASKS/.test(src)) return "no RECENT OPEN TASKS section in system prompt";
  if (!/listTasks\(\{ done: false \}\)/.test(src)) return "open tasks not loaded with done:false filter";
  return null;
});

check("seam.20 system prompt uses peer-counsel framing (persona tree)", () => {
  const src = read("lib/concierge/loop.ts");
  if (!/strategic counsel|trusted partner/i.test(src)) return "persona not peer-counsel (still concierge-butler framing)";
  if (!/Upaya/.test(src)) return "Upaya Festival context missing from persona";
  if (!/Mauritian|Vatel/.test(src)) return "Jensen's background context missing";
  return null;
});

check("seam.21bis WA route persists inbound to chat_messages BEFORE runConcierge (NO-CHAT-LOST)", () => {
  const src = read("app/api/whatsapp/route.ts");
  if (!/NO-CHAT-LOST/.test(src)) return "no NO-CHAT-LOST marker";
  // The chatAppend for inbound must run BEFORE runConcierge in plain-text path
  const inboundChat = src.indexOf('chatAppend("user", text');
  const conciergeIdx = src.indexOf('runConcierge({ messages: [...history, { role: "user", content: turnInput }]');
  if (inboundChat === -1) return "no pre-brain chatAppend for inbound text";
  if (conciergeIdx === -1) return "could not locate plain-text runConcierge";
  if (inboundChat > conciergeIdx) return "inbound persistence runs AFTER runConcierge (would lose message on brain error)";
  return null;
});

check("seam.21ter onboarding prompt is probing + capture-everything (Taona directive)", () => {
  const src = read("lib/concierge/loop.ts");
  if (!/DRAW HIM OUT/.test(src)) return "no DRAW HIM OUT instruction";
  if (!/CAPTURE-EVERYTHING/.test(src)) return "no CAPTURE-EVERYTHING discipline";
  if (!/WHAT YOU ARE PROBING FOR/.test(src)) return "no probing checklist";
  if (!/never re-ask/i.test(src)) return "no anti-re-ask discipline";
  return null;
});

check("seam.21quater captureSalience accepts onboarding option for liberal capture", () => {
  const src = read("lib/concierge/brain.ts");
  if (!/SALIENCE_ONBOARDING_SYS/.test(src)) return "no onboarding-specific salience prompt";
  if (!/onboarding_fact/.test(src)) return "onboarding kind label missing on rememberFact call";
  if (!/opts\?: \{ onboarding/.test(src)) return "captureSalience signature missing onboarding option";
  const loopSrc = read("lib/concierge/loop.ts");
  if (!/captureSalience\(lastUser, reply, \{ onboarding \}\)/.test(loopSrc)) return "loop does not pass onboarding flag to captureSalience";
  return null;
});

check("seam.21 DONE-resolution route is owner-only post-unlock, sweep-permitted in TRAINING", () => {
  const src = read("app/api/whatsapp/route.ts");
  const doneIdx = src.indexOf("DETERMINISTIC DONE-RESOLUTION");
  if (doneIdx === -1) return "DONE-resolution marker missing";
  const conditional = src.slice(doneIdx, doneIdx + 1000);
  if (!/sender\.role === ["']owner["']/.test(conditional)) {
    return "DONE-resolution does not gate on owner tier — admin 'Done' would corrupt Jensen's board post-unlock";
  }
  if (!/JENSEN_MODE === ["']TRAINING["']/.test(conditional)) {
    return "no JENSEN_MODE=TRAINING override — harness from Taona's admin number cannot exercise this path";
  }
  return null;
});

// ============================================================================
// DOCTRINE LAW 8 SEAM — destructive-tool confirmation gate
// ============================================================================

check("seam.22 dispatch.ts has destructiveGate intercepting before switch", () => {
  const src = read("lib/concierge/dispatch.ts");
  if (!/destructiveGate\(/.test(src)) return "destructiveGate function not present";
  if (!/const DESTRUCTIVE = new Set\(/.test(src)) return "DESTRUCTIVE set not defined";
  // Gate must be called BEFORE the switch in runAction
  const gateCallIdx = src.indexOf("destructiveGate(name");
  const switchIdx = src.indexOf("switch (name)");
  if (gateCallIdx === -1) return "destructiveGate not called in runAction";
  if (switchIdx === -1) return "switch(name) not found in runAction";
  if (gateCallIdx > switchIdx) return "destructiveGate called AFTER switch (action would execute before refusal)";
  return null;
});

check("seam.23 DESTRUCTIVE set covers all delete_*, reply_email, call_owner, forget_memory", () => {
  const src = read("lib/concierge/dispatch.ts");
  const required = ["delete_entity", "delete_task", "delete_event", "delete_finance",
                    "delete_document", "delete_contact", "delete_note", "forget_memory",
                    "reply_email", "call_owner"];
  const destSet = src.match(/const DESTRUCTIVE = new Set\(\[([\s\S]*?)\]\)/);
  if (!destSet) return "DESTRUCTIVE set not parseable";
  const block = destSet[1];
  const missing = required.filter((name) => !new RegExp(`["']${name}["']`).test(block));
  if (missing.length) return `DESTRUCTIVE set missing: ${missing.join(", ")}`;
  return null;
});

check("seam.24 dispatch destructiveGate honors confirm:true bypass", () => {
  const src = read("lib/concierge/dispatch.ts");
  const fnMatch = src.match(/function destructiveGate\([^)]*\)[\s\S]*?\n\}/);
  if (!fnMatch) return "destructiveGate function body not parseable";
  const body = fnMatch[0];
  if (!/input\?\.confirm\s*===\s*true/.test(body)) return "no confirm:true bypass — model can never execute confirmed deletes";
  return null;
});

check("seam.25 outbound chokepoint strips em/en dashes (Law 5 hard enforcement)", () => {
  const src = read("lib/whatsapp.ts");
  if (!/export function stripDashes/.test(src)) return "stripDashes not exported";
  if (!/replace\(\/.*[—–].*\//.test(src)) return "stripDashes does not actually strip em-/en-dashes";
  if (!/stripDashes\(body\)/.test(src)) return "sendWhatsApp does not call stripDashes on outbound body";
  const loopSrc = read("lib/concierge/loop.ts");
  if (!/stripDashes\(reply\)/.test(loopSrc)) return "concierge loop does not strip reply before persist (DB will diverge from delivery)";
  return null;
});

// ============================================================================
// OPERATOR MIRROR SEAM — silent live-tail to MIRROR_TO
// ============================================================================

check("seam.26 mirrorToOperator exists with loop-guard + delegates through sendWhatsApp", () => {
  const src = read("lib/whatsapp.ts");
  if (!/async function mirrorToOperator/.test(src)) return "mirrorToOperator not defined";
  const fn = src.slice(src.indexOf("async function mirrorToOperator"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 2);
  if (!/MIRROR_TO/.test(body)) return "no MIRROR_TO env reference";
  if (!/fromDigits === op \|\| toDigits === op/.test(body)) return "no loop guard on operator number";
  if (!/sendWhatsApp\(op,/.test(body)) return "mirror does not delegate through sendWhatsApp (would bypass chokepoints)";
  if (!/force:\s*true/.test(body)) return "mirror does not pass force:true (would be silently swallowed by TRAINING gate)";
  return null;
});

check("seam.27 sendWhatsApp fires mirror after successful outbound", () => {
  const src = read("lib/whatsapp.ts");
  // 2026-06-16 KT #293: chokepoint body moved into sendWhatsAppRaw so it can
  // return Meta's wamid (for Wall 1 swipe-reply anchor). sendWhatsApp now
  // delegates and discards wamid for back-compat. Look in the Raw function.
  const fn = src.slice(src.indexOf("export async function sendWhatsAppRaw"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 2);
  if (!/mirrorToOperator\(/.test(body)) return "sendWhatsAppRaw does not call mirrorToOperator";
  // mirror call must come AFTER the graph fetch (otherwise we mirror unsent text)
  const fetchIdx = body.indexOf("graph.facebook.com");
  const mirrorIdx = body.indexOf("mirrorToOperator");
  if (mirrorIdx < fetchIdx) return "mirror call runs BEFORE the actual outbound fetch";
  return null;
});

check("seam.28 WA route mirrors only the principal's (owner's) inbound", () => {
  const src = read("app/api/whatsapp/route.ts");
  if (!/mirrorInbound\(/.test(src)) return "WA route does not call mirrorInbound";
  // Gate must mirror ONLY the served principal (owner = Jensen) so the operator's
  // own messages are never echoed back to himself. whoIs maps Taona to role
  // "developer" (not "admin"), so the old !== "admin" guard mirrored his messages.
  if (!/sender\.role === ["']owner["']/.test(src)) return "mirror not gated to owner inbound (would echo operator's own messages)";
  return null;
});

// ============================================================================
// FLEET MONITOR SEAMS
// ============================================================================

check("seam.29 monitor cron route exists with authed gate", () => {
  const src = read("app/api/cron/monitor/route.ts");
  if (!/authed/.test(src)) return "monitor route missing authed function";
  if (!/CRON_SECRET/.test(src)) return "monitor route does not check CRON_SECRET";
  if (!/health_checks/.test(src)) return "monitor route does not reference health_checks table";
  if (!/sendTextAndLog/.test(src)) return "monitor route does not alert via sendTextAndLog";
  if (!/degraded|down/.test(src)) return "monitor route does not detect degraded/down state";
  return null;
});

check("seam.30 monitor registered in vercel.json cron schedule", () => {
  const src = read("vercel.json");
  if (!/monitor/.test(src)) return "monitor route not listed in vercel.json crons";
  if (!/"schedule": "\* \* \* \* \*"/.test(src.replace(/\\n/g, ""))) {
    const monitorEntry = src.match(/monitor[\s\S]{0,80}\* \* \* \* \*/);
    if (!monitorEntry) return "monitor cron not on every-minute schedule";
  }
  return null;
});

check("seam.31 health_checks migration exists with correct schema", () => {
  const src = read("db/2026-06-18_health_checks.sql");
  if (!/create table if not exists health_checks/.test(src)) return "health_checks table not created";
  if (!/bot text/.test(src)) return "bot column missing";
  if (!/status text/.test(src)) return "status column missing";
  if (!/checked_at/.test(src)) return "checked_at column missing";
  return null;
});

check("seam.46 Class A leakage wall: brand bans (zanii/sanad) present; Taona moved to scoped dev_persona_leak (KT #340)", () => {
  const src = read("lib/bot/guards-config.ts");
  const i = src.indexOf("forbiddenBrands:");
  const set = src.slice(i, i + 1100);
  for (const b of ["'zanii'", "'sanad'"]) {
    if (!set.includes(b)) return `${b} not in forbiddenBrands (would leak to the client)`;
  }
  // 'Taona' must NOT be a bare forbidden brand anymore (it dropped Jensen's own board)
  if (/^\s*'Taona',/m.test(set)) return "'Taona' is still a bare forbidden brand (drops Jensen's own 'contract for Taona' board)";
  // but the dev/persona leak protection must remain, as a scoped drop pattern
  if (!/label:\s*'dev_persona_leak'[^}]*mode:\s*'drop'/.test(src)) return "dev_persona_leak pattern missing or not in drop mode (Jun-18 leak would reopen)";
  return null;
});

check("seam.47 Class A leakage wall: credential + infra + test patterns drop the reply", () => {
  const src = read("lib/bot/guards-config.ts");
  const need = ["plaintext_credential", "login_credential", "infra_api_token", "infra_system_logs", "infra_code_bug", "test_artifact_only", "test_recant"];
  for (const label of need) {
    const re = new RegExp(`label:\\s*'${label}'[^}]*mode:\\s*'drop'|mode:\\s*'drop'[^}]*label:\\s*'${label}'`);
    if (!re.test(src)) return `${label} missing or not in drop mode`;
  }
  return null;
});

check("seam.48 persona rule: address Jensen in 2nd person, never narrate the engine room", () => {
  const src = read("lib/concierge/loop.ts");
  if (!/SPEAK TO JENSEN, NEVER ABOUT HIM/.test(src)) return "persona-address rule missing from system head";
  if (!/never name the developer or operator/.test(src)) return "no-infra-narration clause missing";
  return null;
});

check("seam.49 persona rule: peer not intake clerk, close own loops, no hollow all-clear, no over-apology", () => {
  const src = read("lib/concierge/loop.ts");
  if (!/BE THE PEER, NOT THE INTAKE CLERK/.test(src)) return "peer-not-clerk rule missing";
  if (!/CLOSE YOUR OWN LOOPS/.test(src)) return "close-your-loops clause missing";
  if (!/hollow all-clear|NEVER a hollow all-clear/.test(src)) return "no-hollow-all-clear clause missing";
  if (!/FIX QUIETLY/.test(src)) return "no-over-apology clause missing";
  return null;
});

check("seam.50 daily brief tags stale Q1 items so high-priority work cannot rot silently", () => {
  const src = read("app/api/cron/daily/route.ts");
  if (!/open \$\{days\}d/.test(src)) return "no staleness age-tag on Q1 items";
  if (!/days >= 2/.test(src)) return "staleness threshold not applied";
  return null;
});

check("seam.51 draft-grounding guard: ungrounded money/headcount/percent -> needsSteer (no guess), not a fabricated draft", () => {
  const src = read("lib/draft-grounding.ts");
  if (!/export function groundDraft/.test(src)) return "groundDraft not exported";
  if (!/needsSteer/.test(src)) return "guard does not return a needsSteer signal";
  if (/HOLDING_REPLY/.test(src)) return "guard still substitutes a holding reply instead of asking for steer";
  for (const label of ["money", "headcount", "percent"]) {
    if (!new RegExp(`label:\\s*"${label}`).test(src)) return `no ${label} risk pattern`;
  }
  if (!/digitTokens|srcDigits/.test(src)) return "no source-grounding check (would downgrade everything or nothing)";
  return null;
});

check("seam.52 mail-triage: confident->draft, not-sure->needsSteer (asks Jensen), never a guessed draft", () => {
  const src = read("lib/mail-triage.ts");
  if (!/from "\.\/draft-grounding"/.test(src)) return "mail-triage does not import the grounding guard";
  if (!/groundDraft\(/.test(src)) return "groundDraft backstop never applied";
  if (!/needsSteer/.test(src) || !/steerGap/.test(src)) return "triage does not propagate the needsSteer / steerGap state";
  if (!/GROUNDING RULE/.test(src)) return "the triage prompt lost the grounding rule";
  if (!/NOT SURE/.test(src) || !/needs =/.test(src)) return "prompt does not instruct the ask-when-not-sure (needs) branch";
  // when not sure the draft must be emptied, never a guessed/holding draft
  if (!/draft = "";/.test(src)) return "not-sure path does not clear the draft (would surface a guess)";
  return null;
});

check("seam.53 needsSteer ask carries NO send affordance (can never be fired at the sender)", () => {
  const src = read("lib/mail-sweep.ts");
  if (!/function buildSteerAsk/.test(src)) return "no buildSteerAsk bubble for ungrounded emails";
  // brace-match the buildSteerAsk body and assert it has no 'My draft reply' /
  // 'yes to send' affordance that the MAIL PROPOSAL CONFIRM flow would bind to.
  const i = src.search(/function buildSteerAsk/);
  const open = src.indexOf("{", i);
  let j = open + 1, depth = 1;
  while (j < src.length && depth > 0) { const c = src[j]; if (c === "{") depth++; else if (c === "}") depth--; j++; }
  const bodyText = src.slice(open, j);
  if (/My draft reply/.test(bodyText)) return "steer ask contains 'My draft reply' (a yes would send it to the client)";
  if (/yes' to send|to send as is/.test(bodyText)) return "steer ask offers a send confirmation (would fire at the client)";
  // ungrounded items (draft "") must still be surfaced, not filtered out
  if (!/\|\|\s*m\.needsSteer/.test(src)) return "needsReply filter drops needsSteer items (Jensen never sees the ask)";
  // the propose paths must branch to buildSteerAsk for needsSteer
  if (!/m\.needsSteer \? buildSteerAsk\(m\) : buildDraft\(m\)/.test(src)) return "propose path does not use buildSteerAsk for needsSteer";
  return null;
});

check("seam.54 claim-by-claim verifier exists, is fail-open, and flips ungrounded confident drafts to needsSteer", () => {
  const v = read("lib/draft-verify.ts");
  if (!/export async function verifyDraftsGrounded/.test(v)) return "verifyDraftsGrounded not exported";
  if (!/return \{\};\s*\/\/ FAIL-OPEN|catch\s*\{\s*return \{\};/.test(v.replace(/\n/g, " "))) return "verifier is not fail-open on error";
  if (!/grounded:\s*o\.grounded !== false/.test(v)) return "verifier does not default-grounded a malformed entry (per-item fail-open)";
  const t = read("lib/mail-triage.ts");
  if (!/from "\.\/draft-verify"/.test(t)) return "mail-triage does not import the verifier";
  if (!/verifyDraftsGrounded\(/.test(t)) return "verifier is never run on the drafts";
  // it must only verify CONFIDENT drafts, and a failed verdict flips to needsSteer
  if (!/!t\.needsSteer && \(t\.draft \|\| ""\)\.trim\(\)\.length > 0/.test(t)) return "verifier not scoped to confident drafts";
  if (!/if \(v && !v\.grounded\)/.test(t)) return "ungrounded verdict does not flip the draft to needsSteer";
  return null;
});

check("seam.55 the tricky-logic protocol is wired into the doctrine (always loaded), not just a doc", () => {
  const c = read("CLAUDE.md");
  if (!/tricky-logic protocol/i.test(c)) return "CLAUDE.md does not reference the tricky-logic protocol";
  if (!/TRICKY-LOGIC-PROTOCOL\.md/.test(c)) return "no pointer to the full protocol file";
  if (!/Test the OUTPUT a human sees|the OUTPUT a human sees/i.test(c)) return "the output-not-mechanism rule is not stated in the doctrine";
  if (!/echo .* when confident|ASK .* when not/i.test(c)) return "the echo-when-confident / ask-when-not product rule is missing";
  return null;
});

check("seam.56 morning brief is LOGGED (sendTextAndLog), not sent via the raw unlogged path", () => {
  const src = read("app/api/cron/daily/route.ts");
  if (!/from "@\/lib\/sendTextAndLog"/.test(src)) return "daily cron does not import sendTextAndLog";
  if (!/sendTextAndLog\(n, brief\.text/.test(src)) return "brief still sent via raw sendWhatsApp (invisible to the bot's memory)";
  return null;
});

check("seam.57 honesty rail exempts a recap/summary read (does not eat it into 'I have not done that yet')", () => {
  const src = read("lib/concierge/honest-reply.ts");
  if (!/READ_ASK/.test(src)) return "no READ_ASK exemption for summary/recap requests";
  if (!/if \(READ_ASK\.test\(userAsk\)\) return text;/.test(src)) return "READ_ASK is not applied before the claim-rewrite";
  if (!/honestReply\(reply: string, runs: ToolRun\[\], userAsk/.test(src)) return "honestReply does not accept the userAsk argument";
  const loop = read("lib/concierge/loop.ts");
  if (!/honestReply\(reply, runs, lastUser\)/.test(loop)) return "loop does not pass the user's request into the rail";
  return null;
});

check("seam.59 brand wall does not drop a real client contact: 'Stephen' removed (collides with 'Stephen Sutherland'), dev/brand bans kept", () => {
  const src = read("lib/bot/guards-config.ts");
  const i = src.indexOf("forbiddenBrands:");
  const set = src.slice(i, i + 1100);
  // the bare 'Stephen' entry must be gone from the active list (a comment mention is fine)
  if (/^\s*'Stephen',/m.test(set)) return "'Stephen' is still an active forbidden brand (drops replies about the real contact Stephen Sutherland)";
  // 'Taona' also removed as a bare brand (KT #340 — collided with Jensen's own board)
  if (/^\s*'Taona',/m.test(set)) return "'Taona' is still an active bare forbidden brand (drops Jensen's own board)";
  // but the genuine brand protections must remain
  for (const b of ["'zanii'", "'sanad'", "'Sasa'"]) {
    if (!set.includes(b)) return `${b} was wrongly removed from forbiddenBrands`;
  }
  return null;
});

check("seam.61 dev_persona_leak: passes Jensen's own board (Taona task) but drops the Jun-18 persona leak (KT #340)", () => {
  const src = read("lib/bot/guards-config.ts");
  const m = src.match(/label:\s*'dev_persona_leak',\s*mode:\s*'drop',\s*pattern:\s*(\/.*?\/[a-z]*)\s*}/);
  if (!m) return "dev_persona_leak pattern not found in guards-config";
  let re;
  try { const b = m[1]; const ls = b.lastIndexOf("/"); re = new RegExp(b.slice(1, ls), b.slice(ls + 1)); }
  catch (e) { return "could not compile dev_persona_leak regex: " + (e?.message || e); }
  const MUST_PASS = [
    "Here is your full board, Jensen.\n\nQ1, Urgent + Important\n• Dorje contract for Taona\n• Review contract for Upaya",
    "Meeting with Taona at 13:00",
    "Dorje contract for Taona",
    "1pm meeting with Taona today",
  ];
  const MUST_DROP = [
    "Taona caught it, recharged them, and added a guard.",
    "the API tokens were drained, Taona topped them up",
    "Taona the developer fixed the bug overnight.",
  ];
  for (const s of MUST_PASS) if (re.test(s)) return "FALSE-DROP on Jensen's own data: " + JSON.stringify(s.slice(0, 40));
  for (const s of MUST_DROP) if (!re.test(s)) return "persona LEAK not caught: " + JSON.stringify(s.slice(0, 40));
  return null;
});

check("seam.62 persona role-disclosure: 'X built/runs me' + 'my developer' + 'Taona built this' drop, board passes (KT #340)", () => {
  const src = read("lib/bot/guards-config.ts");
  const compile = (label) => {
    const m = src.match(new RegExp("label:\\s*'" + label + "',\\s*mode:\\s*'drop',\\s*pattern:\\s*(\\/.*?\\/[a-z]*)\\s*}"));
    if (!m) return null;
    const b = m[1], ls = b.lastIndexOf("/");
    try { return new RegExp(b.slice(1, ls), b.slice(ls + 1)); } catch { return null; }
  };
  const dev = compile("dev_persona_leak"), self = compile("persona_self_disclosure");
  if (!dev) return "dev_persona_leak pattern missing";
  if (!self) return "persona_self_disclosure pattern missing";
  const hit = (s) => dev.test(s) || self.test(s);
  const PASS = [
    "Here is your full board, Jensen.\n• Dorje contract for Taona\n• Review contract for Upaya",
    "I set up the meeting with Steve for you",
    "Your developer event is on Friday",
    "Meeting with Taona at 13:00",
  ];
  const DROP = [
    "Taona built this for you",
    "Taona built me",
    "my developer set it up",
    "Taona runs this bot",
    "the developer who built me handles that",
  ];
  for (const s of PASS) if (hit(s)) return "FALSE-DROP on legit text: " + JSON.stringify(s.slice(0, 40));
  for (const s of DROP) if (!hit(s)) return "persona role-disclosure LEAK not caught: " + JSON.stringify(s.slice(0, 40));
  return null;
});

check("seam.63 emailed meeting links reach the event row (meetingUrl threads inbox->route->addEmailEvent->addEvent) (KT #342)", () => {
  // addEvent must actually WRITE meeting_url (it silently omitted it before)
  const db = read("lib/db.ts");
  const ins = db.slice(db.indexOf("export async function addEvent"), db.indexOf("export async function addEvent") + 1200);
  if (!/meetingUrl\?:\s*string/.test(ins)) return "addEvent does not accept meetingUrl";
  if (!/meeting_url:\s*e\.meetingUrl/.test(ins)) return "addEvent insert still omits meeting_url (emailed invites land link-less)";
  // addEmailEvent must accept + forward it
  const sync = read("lib/calendar-sync.ts");
  if (!/meetingUrl\?:\s*string/.test(sync)) return "addEmailEvent does not accept meetingUrl";
  if (!/meetingUrl:\s*ev\.meetingUrl/.test(sync)) return "addEmailEvent does not forward meetingUrl to addEvent";
  // the accept route must parse + forward it (http(s) validated)
  const route = read("app/api/calendar/add/route.ts");
  if (!/b\.meetingUrl/.test(route) || !/https\?:/.test(route)) return "calendar/add route does not parse/validate meetingUrl";
  if (!/addEmailEvent\([^)]*meetingUrl/.test(route.replace(/\n/g, " "))) return "calendar/add route does not forward meetingUrl";
  // the inbox accept must send it
  const inbox = read("app/inbox/page.tsx");
  if (!/meetingUrl/.test(inbox)) return "inbox does not send meetingUrl on accept";
  if (!/m\.event\.meetingUrl/.test(inbox)) return "inbox does not use the triage-detected meetingUrl";
  return null;
});

check("seam.64 CHARACTERIZATION: monitor still logs a health_checks row per bot every run + returns {ok,checks} (must not regress)", () => {
  const src = read("app/api/cron/monitor/route.ts");
  if (!/\.from\(["']health_checks["']\)\s*\.insert\(/.test(src)) return "monitor no longer inserts health_checks rows";
  for (const col of ["bot:", "http_status:", "latency_ms:"]) {
    if (!src.includes(col)) return `health_checks insert missing ${col}`;
  }
  if (!/ok: true, checks/.test(src)) return "monitor no longer returns {ok:true, checks}";
  return null;
});

check("seam.65 monitor pages devPhone ONLY on real DOWN via the wall-EXEMPT primitive (a 'DOWN: sasa' body must not be scrubbed), kv-cooldown, never owners()/Jensen (FM-19/27/28, BUG-001)", () => {
  const src = read("app/api/cron/monitor/route.ts");
  if (!/devPhone\(\)/.test(src)) return "alert does not route to devPhone()";
  if (/for \(const owner of (to|owners)\b/.test(src)) return "alert still loops owners() (leaks to Jensen)";
  // sendTextAndLog runs an UNCONDITIONAL line-34 sanitize that scrubs a 'DOWN: sasa'
  // body to the reaskPhrase before the recipient is known — the alert must NOT use it.
  if (/sendTextAndLog\(/.test(src)) return "alert still uses sendTextAndLog (its line-34 sanitize mangles 'DOWN: sasa' to the reaskPhrase)";
  if (!/sendWhatsAppRaw\(\s*dev\b/.test(src)) return "alert not sent via sendWhatsAppRaw(dev) — the wall-exempt-for-developer primitive";
  if (!/monitor_last_alert/.test(src)) return "cooldown not keyed on kv monitor_last_alert (FM-27)";
  if (!/status === "down"/.test(src)) return "paging not gated on status==='down' (still pages quiet-night degraded)";
  if (!/http\.status >= 500/.test(src)) return "down-detection does not treat 5xx as down (FM-28)";
  // WHY the bypass primitive is load-bearing: the alert body carries the real bot name
  // "sasa", which IS a forbidden brand — via the wrapper it would be dropped to the reaskPhrase.
  const guards = read("lib/bot/guards-config.ts");
  if (!/['"]Sasa['"]/.test(guards)) return "'Sasa' is no longer a forbiddenBrand (the bypass-required assumption changed)";
  if (!/name:\s*"sasa"/.test(src)) return "monitor BOTS no longer includes a bot named 'sasa' (the forbidden-brand-in-alert-body case)";
  return null;
});

check("seam.66 CHARACTERIZATION: reminder cron still fires due events at T-5 + latches reminded_at BEFORE send (must not regress)", () => {
  const src = read("app/api/cron/reminders/route.ts");
  if (!/reminded_at=is\.null/.test(src)) return "cron no longer selects on reminded_at=is.null";
  if (!/delta >= LEAD_MIN - WINDOW && delta <= LEAD_MIN \+ WINDOW/.test(src)) return "cron no longer uses the [4,6]-min lead window";
  if (!/\/\^Reminder:\/i\.test\(ev\.title\)/.test(src)) return "cron no longer skips legacy 'Reminder:' rows";
  const latchIdx = src.indexOf("reminded_at: Date.now()");
  const sendIdx = src.indexOf("sendTextAndLog(num, body");
  if (latchIdx < 0 || sendIdx < 0 || latchIdx > sendIdx) return "cron no longer latches reminded_at BEFORE send (at-most-once broken)";
  return null;
});

check("seam.67 reminder cron does NOT fire for completed events (outcome filter) — FM-23 / FM-09 reborn", () => {
  const src = read("app/api/cron/reminders/route.ts");
  if (!/outcome=is\.null/.test(src)) return "cron select missing outcome=is.null — fires reminders for events Jensen already marked done";
  return null;
});

check("seam.68 isOwner FAILS CLOSED when OWNER_WHATSAPP is empty (deny all, never allow-all) — FM-18 single-tenant breach", () => {
  const src = read("lib/whatsapp.ts");
  const i = src.indexOf("export function isOwner");
  const body = src.slice(i, i + 400);
  if (/if \(!raw\) return true/.test(body)) return "isOwner still ALLOWS ALL on empty OWNER_WHATSAPP (any number drives Jensen's concierge — Law 9 breach)";
  if (!/if \(!raw\) return false/.test(body)) return "isOwner does not fail-closed (deny all) on empty OWNER_WHATSAPP";
  if (!/includes\(fromDigits\)/.test(body)) return "isOwner membership check regressed (the configured-owners gate broke)";
  return null;
});

check("seam.69 send_meeting_invite: real .ics REQUEST over the mailbox's own SMTP, confirm-gated, board-mirrored (Outlook invite without MS Graph)", () => {
  const tools = read("lib/concierge/tools.ts");
  if (!/name:\s*"send_meeting_invite"/.test(tools)) return "send_meeting_invite tool missing";
  const td = tools.slice(tools.indexOf("send_meeting_invite"), tools.indexOf("send_meeting_invite") + 1400);
  if (!/confirm:\s*bool/.test(td)) return "send_meeting_invite has no confirm arg (Law 8)";
  const disp = read("lib/concierge/dispatch.ts");
  const dset = disp.slice(disp.indexOf("DESTRUCTIVE"), disp.indexOf("DESTRUCTIVE") + 500);
  if (!/"send_meeting_invite"/.test(dset)) return "send_meeting_invite not in the DESTRUCTIVE confirm set";
  if (!/case "send_meeting_invite"/.test(disp)) return "no dispatch case for send_meeting_invite";
  if (!/sendMeetingInviteEmail\(/.test(disp)) return "dispatch does not call sendMeetingInviteEmail";
  const mp = read("lib/mail-provider.ts");
  if (!/export async function sendMeetingInviteEmail/.test(mp)) return "sendMeetingInviteEmail missing";
  if (!/icalEvent:\s*\{\s*method:\s*"REQUEST"/.test(mp)) return "invite not sent as an iCal REQUEST (recipient gets no accept/decline)";
  const ics = read("lib/ics.ts");
  if (!/METHOD:\$\{opts\.method/.test(ics)) return "ics builder does not emit METHOD";
  if (!/ORGANIZER/.test(ics) || !/ATTENDEE/.test(ics)) return "ics builder missing ORGANIZER/ATTENDEE";
  // send_email: the missing "compose + send a brand-NEW email" capability (Jensen hit this live)
  if (!/name:\s*"send_email"/.test(tools)) return "send_email tool missing (bot can't compose a new outbound email)";
  if (!/case "send_email"/.test(disp)) return "no dispatch case for send_email";
  if (!/sendNewEmail\(/.test(disp)) return "dispatch does not call sendNewEmail";
  if (!/export async function sendNewEmail/.test(mp)) return "sendNewEmail missing in mail-provider";
  // teach-the-bot: the prompt must say it CAN send invites AND new emails (no more 'not wired in')
  const loop = read("lib/concierge/loop.ts");
  if (!/MEETING INVITE/.test(loop)) return "system prompt does not tell the bot it can send a real meeting invite";
  if (!/compose and SEND a brand-new email/i.test(loop)) return "system prompt does not tell the bot it can send a brand-new email (it will keep refusing)";
  return null;
});

check("seam.70 doc intake degrades when embeddings are down — files the doc keyword-only, never fails the upload (web + whatsapp) (BUG-003 / KT #348)", () => {
  const ing = read("app/api/ingest-file/route.ts");
  if (!/embedDegraded = true/.test(ing)) return "ingest-file (web) does not catch embed failure — a 401 aborts the whole upload (the live 'could not file' bug)";
  if (!/title, text, chunks, kind, embedDegraded/.test(ing)) return "ingest-file does not still return the doc after a degraded embed";
  const wa = read("app/api/whatsapp/route.ts");
  if (!/keyword only/.test(wa)) return "whatsapp doc intake does not degrade to keyword-only on embed failure";
  // scanned / image-only PDF (e.g. passport scan): OCR fallback via Claude document block
  const an = read("lib/anthropic.ts");
  if (!/export async function readPdf/.test(an)) return "readPdf (scanned-PDF OCR) missing";
  if (!/type: "document"/.test(an)) return "readPdf does not use Claude's document block for PDF OCR";
  if (!/readPdf\(/.test(ing)) return "ingest-file (web) has no scanned-PDF OCR fallback";
  if (!/readPdf\(dl\.base64\)/.test(wa)) return "whatsapp has no scanned-PDF OCR fallback";
  return null;
});

check("seam.71 doc search is Claude-powered (no OpenAI embeddings) — reads the index + content, picks matches (KT #348)", () => {
  const ds = read("lib/docs-server.ts");
  if (!/export async function searchDocsWithClaude/.test(ds)) return "searchDocsWithClaude missing";
  if (!/askClaude\(/.test(ds.slice(ds.indexOf("searchDocsWithClaude")))) return "searchDocsWithClaude does not use Claude";
  const disp = read("lib/concierge/dispatch.ts");
  if (!/case "search_documents": \{ result = await searchDocsWithClaude/.test(disp)) return "search_documents not wired to the Claude search";
  if (/case "search_documents":[^}]*\brecall\(/.test(disp)) return "search_documents still calls recall() (the dead OpenAI embed-query path)";
  return null;
});

check("seam.72 recall() keyword-searches the docs TABLE (title or content) so content-only docs (no chunks, embed down) still ground the brain — FM-42 / KT #349", () => {
  const br = read("lib/concierge/brain.ts");
  const rc = br.slice(br.indexOf("export async function recall"));
  if (!/sbSelect<any>\("docs",\s*`or=\(title\.ilike/.test(rc)) return "recall does not keyword-search the docs table by title";
  if (!/content\.ilike/.test(rc)) return "recall docs-table fallback does not search content";
  if (!/rrf<any>\(\[docVecNorm, docKw, docTbl\]/.test(rc)) return "docTbl not fused into the doc ranking";
  return null;
});

check("seam.73 sanad ingest delivers a contract PDF ONLY to Jensen — recipient is the resolved owner number, an arbitrary send_to_wa is refused (Law 9 single-tenant / Law 3 PII)", () => {
  const src = read("app/api/ingest/sanad/route.ts");
  if (!/function jensenWa\(/.test(src)) return "no jensenWa() owner resolver";
  if (/sendWhatsAppDocument\(\s*body\.send_to_wa/.test(src)) return "still delivers to the raw request number (not locked to Jensen)";
  if (!/sendWhatsAppDocument\(\s*jensen,/.test(src)) return "does not deliver to the resolved Jensen number";
  if (!/recipient_not_jensen/.test(src)) return "no refusal path when the caller asks for a non-Jensen recipient";
  return null;
});

check("seam.74 sanad_draft_contract is confirm-gated (in DESTRUCTIVE) — a contract PDF cannot be enqueued + delivered without a confirm (ADR-0002 Phase 0 / Class C1)", () => {
  const src = read("lib/concierge/dispatch.ts");
  const start = src.indexOf("const DESTRUCTIVE");
  const set = src.slice(start, src.indexOf("]);", start));
  if (!/"sanad_draft_contract"/.test(set)) return "sanad_draft_contract is NOT in the DESTRUCTIVE set — it can ship a legal PDF ungated";
  return null;
});

check("seam.75 recall dedups doc grounding PER DOC (title key + content fallback), not by content-prefix — distinct docs sharing a letterhead head are not collision-dropped and one doc cannot eat multiple grounding slots (Class C5 / KT #206558)", () => {
  const br = read("lib/concierge/brain.ts");
  const rc = br.slice(br.indexOf("export async function recall"));
  if (/\(\[docVecNorm, docKw, docTbl\], \(r\) => \(r\.content/.test(rc)) return "recall still dedups doc results on content-prefix only (collision + chunk-dup bug)";
  if (!/document" \? "T:"/.test(rc)) return "recall dedup key is not the per-doc title key with content fallback";
  return null;
});

check("seam.77 WhatsApp media intake ALWAYS files + vaults the file (no drop-on-unreadable) — a scanned passport whose OCR fails is stored + retrievable, never dropped with a false 'saved' (KT #206561)", () => {
  const src = read("app/api/whatsapp/route.ts");
  if (/if \(!text\.trim\(\)\) \{ await sendWhatsApp\(from, "I saved your file but couldn't read/.test(src)) return "still early-returns + DROPS the doc on unreadable text (the passport-loss bug)";
  if (!/uploadReceipt\(dl\.buf/.test(src)) return "does not vault the original file bytes to storage";
  if (!/dataUrl: storagePath/.test(src)) return "addDoc does not persist the storage path";
  return null;
});

check("seam.78 send_filed_document returns the ACTUAL vaulted file (data_url -> storage -> sendWhatsAppDocument), honest on miss (KT #206561)", () => {
  const t = read("lib/concierge/tools.ts");
  if (!/"send_filed_document"/.test(t)) return "send_filed_document tool not registered";
  const d = read("lib/concierge/dispatch.ts");
  if (!/case "send_filed_document"/.test(d)) return "no dispatch case for send_filed_document";
  if (!/data_url=not\.is\.null/.test(d)) return "send-back does not require vaulted bytes (would claim-send a file it doesn't have)";
  if (!/sendWhatsAppDocument\(/.test(d)) return "send-back does not actually deliver the file";
  return null;
});

check("seam.79 deterministic identity file-send-back — 'send me my passport' routes to sendFiledDocument WITHOUT relying on the model to call its own tool (KT #206561 / FM-11 principle / Class C1)", () => {
  const src = read("app/api/whatsapp/route.ts");
  if (!/function matchIdentityFileRequest/.test(src)) return "no deterministic identity-file matcher";
  if (!/matchIdentityFileRequest\(cleaned\)/.test(src)) return "matcher not invoked in the owner text path";
  if (!/await sendFiledDocument\(idDoc, inboundParty/.test(src)) return "match does not call sendFiledDocument deterministically";
  return null;
});

check("seam.80 send_filed_document does NOT silently send the newest on a multi-match (wrong-record) — disambiguates by title; only the identity route passes autoLatest (failure-surface iter 1)", () => {
  const d = read("lib/concierge/dispatch.ts");
  const fn = d.slice(d.indexOf("export async function sendFiledDocument"));
  if (!/distinctTitles\.length > 1 && !opts\?\.autoLatest/.test(fn)) return "no multi-match disambiguation guard (would send the WRONG private doc)";
  if (!/ambiguous: true/.test(fn)) return "ambiguous result not surfaced to the brain";
  const route = read("app/api/whatsapp/route.ts");
  if (!/sendFiledDocument\(idDoc, inboundParty, \{ autoLatest: true \}\)/.test(route)) return "identity route does not pass autoLatest (would nag on passport re-uploads)";
  return null;
});

check("seam.81 a meeting mention lands on the CALENDAR (create_event), never gated behind an un-sendable invite — a meeting must not vanish (failure-surface iter 2, transcript: 'A2 farm at sohum')", () => {
  const src = read("lib/concierge/loop.ts");
  if (!/PUTTING A MEETING ON THE CALENDAR/.test(src)) return "no calendar-routing rule";
  if (!/create_event RIGHT AWAY/.test(src)) return "rule does not force immediate create_event";
  if (!/ONLY when he gives an attendee EMAIL/.test(src)) return "send_meeting_invite not scoped to email-present (would block the calendar add)";
  return null;
});

check("seam.82 deterministic weekday backstop — create/update_event corrects a model-mis-dated weekday; no-ops when no weekday named (failure-surface iter 6 / date-math)", () => {
  const d = read("lib/concierge/dispatch.ts");
  if (!/function reconcileWeekday/.test(d)) return "no reconcileWeekday helper";
  if (!/case "create_event": \{ await reconcileEventDate\(ctx, input\)/.test(d)) return "create_event not backstopped";
  if (!/case "update_event": \{ await reconcileEventDate\(ctx, input\)/.test(d)) return "update_event not backstopped";
  if (!/if \(!m\) return date/.test(d)) return "backstop does not no-op when no weekday is named (would over-correct)";
  return null;
});

check("seam.60 a blank-subject email still surfaces (not silently dropped at thread-coalescing)", () => {
  const src = read("lib/mail-sweep.ts");
  if (/if \(!key\) continue;/.test(src)) return "blank-subject emails are still dropped (if (!key) continue)";
  if (!/__nosubj_\$\{m\.id\}/.test(src)) return "no per-email fallback key for blank subjects";
  return null;
});

check("seam.58 send wall is recipient-aware: skips the developer; a client-facing DROP routes the diagnostic to dev + gives Jensen a graceful line (never the cryptic reaskPhrase)", () => {
  const src = read("lib/whatsapp.ts");
  if (!/const toDev = whoIs\(to\)\.role === "developer"/.test(src)) return "wall is not recipient-aware (a dev-routed reply still hits the client wall and over-fires)";
  if (!/if \(!toDev\)/.test(src)) return "wall not gated to non-dev (client) recipients only";
  if (!/guarded\.dropped/.test(src)) return "drop vs strip not distinguished";
  if (!/sendWhatsAppRaw\(dev,/.test(src)) return "on a drop the diagnostic is not routed to the developer";
  if (!/Let me get back to you on that in a moment/.test(src)) return "Jensen does not get a graceful line on a drop (would still get the cryptic reaskPhrase)";
  return null;
});

// ============================================================================
// REPORT
// ============================================================================

let pass = 0, fail = 0;
const results = [];
for (const t of tests) {
  let reason = null;
  try { reason = t.fn(); } catch (e) { reason = `threw: ${e?.message || e}`; }
  if (reason === null) { pass++; results.push({ name: t.name, ok: true }); }
  else { fail++; results.push({ name: t.name, ok: false, reason }); }
}

const W = Math.max(...results.map((r) => r.name.length)) + 2;
console.log("");
console.log("Jensen sweep seam eval — " + new Date().toISOString());
console.log("=".repeat(W + 14));
for (const r of results) {
  const mark = r.ok ? "✓ PASS" : "✗ FAIL";
  console.log(`${mark}  ${r.name.padEnd(W)} ${r.ok ? "" : "  → " + r.reason}`);
}
console.log("=".repeat(W + 14));
console.log(`${pass}/${tests.length} pass${fail ? `, ${fail} fail` : ""}`);
process.exit(fail ? 1 : 0);
