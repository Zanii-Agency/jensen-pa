// Live end-to-end check of the confirm layer against the REAL kv table.
//   set -a && . ./.env.prod && set +a && npx tsx scripts/_test-confirm-layer-live.mts
//
// Uses the scratch party "selftest". The router only ever looks up "jensen" and
// "taona", so nothing here can reach Jensen or execute anything. Every row it
// writes is deleted at the end. Exits non-zero on any failure.
import { proposePending, offerPending, claimPending, claimByTap, holdStatus, markExecuted, cancelPending } from "../lib/concierge/pending-actions";
import { sbUpdate } from "../lib/concierge/rest";
import { sbSelect, sbDelete } from "../lib/concierge/rest";

const P = "selftest";
const scratch = "key=like." + encodeURIComponent(`pending_action:${P}:*`);
let failed = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) failed++; };
// The portal cases exercise the text path (offerPending / claimPending); the tap
// cases exercise WhatsApp, where only a button tap can run a held action.
const hold = (tool: string, args: any, inbound: string, channel = "portal") =>
  proposePending({ party: P, tool, args, echo: `test ${tool}`, proposedText: "stop the reminders", proposedInboundId: inbound, channel });

try {
  // --- the happy path: asked in X, answered in Y ---
  const a = await hold("delete_event", { ids: ["e1", "e2", "e3", "e4"] }, "wamid.X");
  ok(!!a && a.status === "pending" && a.offered_to === null, "holding writes a pending, unoffered action");
  ok((await offerPending(P, "wamid.X")) === null, "the turn that proposed it cannot be offered it (no self-confirm)");
  ok((await claimPending(a!.id, "wamid.X")) === null, "the proposing message cannot claim it");
  const offered = await offerPending(P, "wamid.Y");
  ok(offered?.id === a!.id && offered?.offered_to === "wamid.Y", "the NEXT message is offered the question");
  ok((await offerPending(P, "wamid.Y"))?.id === a!.id, "offering is idempotent for the same message (webhook retry)");
  ok((await claimPending(a!.id, "wamid.OTHER")) === null, "a message it was NOT offered to cannot claim it");
  const race = await Promise.all([claimPending(a!.id, "wamid.Y"), claimPending(a!.id, "wamid.Y")]);
  ok(race.filter(Boolean).length === 1, "two racing claims from the offered message: exactly one executes");
  await markExecuted(a!.id, { ok: true, result: { deleted: ["e1", "e2", "e3", "e4"] } });
  ok((await offerPending(P, "wamid.Z")) === null, "once executed it can never be offered again");

  // --- review blocker A: a stale proposal must not fire on a later casual yes ---
  const sara = await hold("delete_task", { id: "sara-follow-up" }, "wamid.A1");
  ok((await offerPending(P, "wamid.A2"))?.id === sara!.id, "'add dinner with Marc' is the one reply: question offered to it");
  // ...the model answers Marc's request instead and never confirms. Bot asks "want it on your board?"
  ok((await offerPending(P, "wamid.A3")) === null, "the NEXT message ('yes' to the board question) is NOT offered the stale delete");
  ok((await claimPending(sara!.id, "wamid.A3")) === null, "and cannot claim it: Sara's task survives");

  // --- one question in flight ---
  const q1 = await hold("delete_note", { id: "n1" }, "wamid.B1");
  const q2 = await hold("delete_contact", { id: "c1" }, "wamid.B2");
  ok((await offerPending(P, "wamid.B3"))?.id === q2!.id, "a newer proposal replaces the older one");
  ok((await claimPending(q1!.id, "wamid.B3")) === null, "the replaced proposal can no longer be confirmed");

  // --- no retires it ---
  const c = await hold("call_owner", { message: "hi" }, "wamid.C1");
  await offerPending(P, "wamid.C2");
  await cancelPending(c!.id);
  ok((await claimPending(c!.id, "wamid.C2")) === null, "a declined proposal cannot be confirmed afterwards");

  // --- identical re-ask does not stack ---
  const d1 = await hold("delete_event", { ids: ["x"] }, "wamid.D1");
  const d2 = await hold("delete_event", { ids: ["x"] }, "wamid.D2");
  ok(d1?.id === d2?.id, "asking for the identical action twice holds ONE thing, not two");
  // --- WhatsApp: only a tap on the action's own button runs it ---
  const w = await hold("delete_event", { ids: ["w1", "w2"] }, "wamid.W1", "whatsapp");
  ok(w?.channel === "whatsapp", "a WhatsApp hold is bound to WhatsApp");
  ok((await claimByTap(w!.id, "someone-else", "wamid.TAP0")) === null, "a tap from another party cannot claim it");
  const portalHold = await hold("delete_note", { id: "pn" }, "wamid.PN", "portal");
  ok((await claimByTap(portalHold!.id, P, "wamid.TAPP")) === null, "a WhatsApp tap cannot claim a PORTAL hold");
  const taps = await Promise.all([claimByTap(w!.id, P, "wamid.TAP1"), claimByTap(w!.id, P, "wamid.TAP2")]);
  ok(taps.filter(Boolean).length === 1, "a double tap executes exactly once");
  await markExecuted(w!.id, { ok: true, result: { deleted: ["w1", "w2"] } });
  ok((await holdStatus(w!.id))?.status === "executed", "a later tap on the same button reads 'already done' from the record");
  const old = await hold("call_owner", { message: "late" }, "wamid.OLD", "whatsapp");
  const rows = await sbSelect<{ key: string; value: any }>("kv", `select=key,value&key=like.${encodeURIComponent(`pending_action:${P}:*`)}&limit=50`);
  const row = rows.find((r) => r.value.id === old!.id)!;
  await sbUpdate("kv", `key=eq.${encodeURIComponent(row.key)}`, { value: { ...row.value, expires_at: new Date(Date.now() - 1000).toISOString() }, updated_at: Date.now() });
  ok((await claimByTap(old!.id, P, "wamid.TAPLATE")) === null, "a tap on an EXPIRED button runs nothing");
} finally {
  await sbDelete("kv", scratch);
  const left = await sbSelect("kv", `select=key&${scratch}`);
  ok(left.length === 0, `scratch rows cleaned up (leftovers: ${left.length})`);
}
console.log(failed ? `\n${failed} FAILED` : "\nconfirm layer: all live checks pass");
process.exit(failed ? 1 : 0);
