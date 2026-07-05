// Zanii proof-of-action for Jensen. Every action tool emits a signed,
// hash-chained receipt to ledger.zanii.agency under Jensen's own agent DID
// (owner->agent delegation, scope *). The ledger stores only a hash; plaintext
// stays in the bot's own DB.
//
// Fire-and-forget + no-op when ZANII_* env is absent, so it can never block or
// break a delivery. waitUntil keeps the receipt alive past the serverless
// response (Vercel freezes the fn otherwise). Observe-only: records truth,
// does not yet gate the bot's "done" claim (that is @zanii/runtime).

import { ZaniiAgent } from "@zanii/sdk";
import { waitUntil } from "@vercel/functions";

let agent: ZaniiAgent | null = null;
let tried = false;

function get(): ZaniiAgent | null {
  if (tried) return agent;
  tried = true;
  const did = process.env.ZANII_AGENT_DID;
  const priv = process.env.ZANII_AGENT_PRIVATE_KEY;
  const apiKey = process.env.ZANII_API_KEY;
  if (!did || !priv || !apiKey) return null; // unconfigured -> silent no-op
  try {
    agent = new ZaniiAgent({
      serverUrl: process.env.ZANII_LEDGER_URL || "https://ledger.zanii.agency",
      agentDid: did,
      agentPrivateKey: Uint8Array.from(Buffer.from(priv, "base64")),
      delegation: process.env.ZANII_DELEGATION ? JSON.parse(process.env.ZANII_DELEGATION) : [],
      apiKey,
    });
  } catch (e: any) {
    console.log(`[zanii] init failed: ${e?.message || e}`);
    agent = null;
  }
  return agent;
}

// Generic: record ANY action tool under its own `target`. The one door every
// doer funnels through. Fire-and-forget, no-op when unconfigured, never throws.
export async function recordAction(target: string, payload: Record<string, unknown>): Promise<string | null> {
  const z = get();
  if (!z) return null;
  const work = (async () => {
    try {
      const { hash } = await z.record({ target, payload });
      await z.flush();
      return hash;
    } catch (e: any) {
      console.log(`[zanii] recordAction(${target}) failed: ${e?.message || e}`);
      return null;
    }
  })();
  // Vercel freezes the fn after the HTTP response, killing a bare fire-and-forget
  // before its ledger POST lands. waitUntil keeps the invocation alive. Guarded
  // for non-Vercel contexts (local/cron) where waitUntil is a no-op/throws.
  try { waitUntil(work); } catch { /* not in a Vercel request context */ }
  return work;
}

// WhatsApp send. `wamid` is Meta's message id (the external referee); null when
// rejected or unparsable. Thin wrapper over recordAction.
export async function recordSend(a: {
  to: string;
  content: string;
  wamid: string | null;
  ok: boolean;
  channel?: string;
}): Promise<string | null> {
  return recordAction("whatsapp.send", {
    to: a.to,
    content: a.content,
    wamid: a.wamid,
    ok: a.ok,
    channel: a.channel || "cloud",
  });
}
