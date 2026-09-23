// Live end-to-end check of the confirm layer against the REAL kv table.
//   set -a && . ./.env.prod && set +a && npx tsx scripts/_test-confirm-layer-live.mts
//
// Uses the scratch party "selftest". The confirm-router only ever looks up
// "jensen" / "taona", so nothing here can reach Jensen or execute anything.
// Every row it writes is deleted at the end. Exits non-zero on any failure.
import { proposePending, findOpenPending, confirmAndClaim, markExecuted, cancelPending } from "../lib/concierge/pending-actions";
import { sbSelect, sbDelete } from "../lib/concierge/rest";

const P = "selftest";
const scratch = "key=like." + encodeURIComponent(`pending_action:${P}:*`);
let failed = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) failed++; };

try {
  const a = await proposePending({ party: P, tool: "delete_event", args: { ids: ["e1", "e2", "e3", "e4"] }, proposedInboundId: "wamid.PROPOSE" });
  ok(!!a && a.status === "pending", "propose writes a pending action");
  const dup = await proposePending({ party: P, tool: "delete_event", args: { ids: ["e1", "e2", "e3", "e4"] }, proposedInboundId: "wamid.PROPOSE2" });
  ok(dup?.id === a?.id, "an identical proposal does not create a second thing to confirm");
  ok((await findOpenPending(P))?.id === a?.id, "the router can find the open proposal");
  ok((await confirmAndClaim(a!.id, "wamid.PROPOSE")) === null, "self-confirm refused: the proposing message cannot confirm itself");
  const both = await Promise.all([confirmAndClaim(a!.id, "wamid.YES"), confirmAndClaim(a!.id, "wamid.YES2")]);
  ok(both.filter(Boolean).length === 1, "two racing confirmations: exactly one executes");
  await markExecuted(a!.id, { ok: true, result: { deleted: 4 } });
  ok((await findOpenPending(P)) === null, "once executed it is closed; a later yes cannot re-run it");
  const b = await proposePending({ party: P, tool: "delete_task", args: { id: "t9" }, proposedInboundId: "wamid.P3" });
  await cancelPending(b!.id);
  ok((await findOpenPending(P)) === null, "a declined proposal is retired");
  ok((await confirmAndClaim(b!.id, "wamid.LATEYES")) === null, "a stale yes after a no cannot resurrect it");
} finally {
  await sbDelete("kv", scratch);
  const left = await sbSelect("kv", `select=key&${scratch}`);
  ok(left.length === 0, `scratch rows cleaned up (leftovers: ${left.length})`);
}
console.log(failed ? `\n${failed} FAILED` : "\nconfirm layer: all live checks pass");
process.exit(failed ? 1 : 0);
