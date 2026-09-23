// Live end-to-end check of the confirm layer against the REAL kv table.
//   set -a && . ./.env.prod && set +a && npx tsx scripts/_test-confirm-layer-live.mts
//
// Uses the scratch party "selftest". Nothing here can reach Jensen or execute a
// tool: it only exercises the hold / claim / cancel records. Every row it writes
// is deleted at the end. Exits non-zero on any failure.
import { proposePending, findOpenHold, claimByTap, claimOnPortal, holdStatus, recentlyExecutedSame, markExecuted, cancelPending } from "../lib/concierge/pending-actions";
import { sbSelect, sbUpdate, sbDelete } from "../lib/concierge/rest";

const P = "selftest";
const scratch = "key=like." + encodeURIComponent(`pending_action:${P}:*`);
let failed = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) failed++; };
const hold = (tool: string, args: any, inbound: string, channel: "whatsapp" | "portal") =>
  proposePending({ party: P, tool, args, echo: `test ${tool}`, proposedText: "stop the reminders", proposedInboundId: inbound, channel });
const expire = async (id: string) => {
  const rows = await sbSelect<{ key: string; value: any }>("kv", `select=key,value&${scratch}&limit=50`);
  const row = rows.find((r) => r.value.id === id)!;
  await sbUpdate("kv", `key=eq.${encodeURIComponent(row.key)}`, { value: { ...row.value, expires_at: new Date(Date.now() - 1000).toISOString() }, updated_at: Date.now() });
};

try {
  // --- WhatsApp: only a tap on the action's own button runs it ---
  const w = await hold("delete_event", { ids: ["w1", "w2"] }, "wamid.W1", "whatsapp");
  ok(w?.status === "pending" && w?.channel === "whatsapp", "a WhatsApp hold is pending and bound to WhatsApp");
  ok((await findOpenHold(P, "whatsapp"))?.id === w!.id, "the open WhatsApp hold is findable (to re-send its buttons)");
  ok((await findOpenHold(P, "portal")) === null, "it is invisible to the portal");
  ok((await claimByTap(w!.id, "someone-else", "wamid.TAP0")) === null, "a tap from another party cannot claim it");
  const taps = await Promise.all([claimByTap(w!.id, P, "wamid.TAP1"), claimByTap(w!.id, P, "wamid.TAP2")]);
  ok(taps.filter(Boolean).length === 1, "a double tap executes exactly once");
  ok((await holdStatus(w!.id))?.status === "confirmed", "while it runs, a later tap reads 'still working' from the record");
  ok(!!(await recentlyExecutedSame(P, "delete_event", { ids: ["w1", "w2"] })), "an in-flight action blocks re-holding the same one (no duplicate send)");
  await markExecuted(w!.id, { ok: true, result: { deleted: ["w1", "w2"] } });
  ok((await holdStatus(w!.id))?.status === "executed", "after it runs, a later tap reads 'already done'");

  const failedSend = await hold("send_email", { to: "a@b.c", subject: "s", body: "b" }, "wamid.F1", "whatsapp");
  await claimByTap(failedSend!.id, P, "wamid.FTAP");
  await markExecuted(failedSend!.id, { ok: false, error: "SMTP timeout" });
  ok((await recentlyExecutedSame(P, "send_email", { to: "a@b.c", subject: "s", body: "b" })) === null, "a FAILED send does not count as sent, so he can retry");

  const late = await hold("call_owner", { message: "late" }, "wamid.L1", "whatsapp");
  await expire(late!.id);
  ok((await claimByTap(late!.id, P, "wamid.LTAP")) === null, "a tap on an EXPIRED button runs nothing");

  const x1 = await hold("delete_note", { id: "n1" }, "wamid.X1", "whatsapp");
  const x2 = await hold("delete_contact", { id: "c1" }, "wamid.X2", "whatsapp");
  ok((await claimByTap(x1!.id, P, "wamid.XTAP")) === null, "a newer hold replaces the older one; the old button runs nothing");
  ok((await findOpenHold(P, "whatsapp"))?.id === x2!.id, "only the newest hold is live");

  const same1 = await hold("delete_event", { ids: ["s"] }, "wamid.S1", "whatsapp");
  const same2 = await hold("delete_event", { ids: ["s"] }, "wamid.S2", "whatsapp");
  ok(same1?.id === same2?.id, "asking for the identical action twice holds ONE thing, not two");
  await cancelPending(same2!.id);
  ok((await claimByTap(same2!.id, P, "wamid.STAP")) === null, "a cancelled hold's button runs nothing");

  // --- Portal: his own later bare yes, only for a portal hold ---
  const p = await hold("delete_task", { id: "t1" }, "portal:P1", "portal");
  ok((await claimOnPortal(p!.id, P, "portal:P1")) === null, "the proposing portal message cannot confirm itself");
  ok((await claimByTap(p!.id, P, "wamid.PTAP")) === null, "a WhatsApp tap cannot claim a portal hold");
  ok((await claimOnPortal(p!.id, "someone-else", "portal:P2")) === null, "another party cannot claim it");
  const pr = await Promise.all([claimOnPortal(p!.id, P, "portal:P2"), claimOnPortal(p!.id, P, "portal:P3")]);
  ok(pr.filter(Boolean).length === 1, "two racing portal confirmations: exactly one executes");
  const wOnPortal = await hold("delete_task", { id: "t2" }, "wamid.WP", "whatsapp");
  ok((await claimOnPortal(wOnPortal!.id, P, "portal:P4")) === null, "typing yes on the portal cannot confirm a WhatsApp hold");
} finally {
  await sbDelete("kv", scratch);
  const left = await sbSelect("kv", `select=key&${scratch}`);
  ok(left.length === 0, `scratch rows cleaned up (leftovers: ${left.length})`);
}
console.log(failed ? `\n${failed} FAILED` : "\nconfirm layer: all live checks pass");
process.exit(failed ? 1 : 0);
