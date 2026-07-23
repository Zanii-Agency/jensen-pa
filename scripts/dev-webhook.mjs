// Law 10 signed-inbound proof harness. POSTs a Meta-shaped WhatsApp webhook to
// the LIVE route, signed with WHATSAPP_APP_SECRET, FROM the developer number so
// the chokepoint's dev branch reroutes any reply to the dev phone and never
// persists / never touches Jensen. Unlike dev-ping.mjs (outbound only), this
// exercises the real inbound path end-to-end: signature -> coalescer -> brain.
//
// Because the route handler is synchronous (awaits coalesce + brain, then
// returns 200), the HTTP response time is a faithful proxy for turn latency.
// That is how we live-prove the adaptive-settle latency win.
//
// Usage:
//   node scripts/dev-webhook.mjs "message text" [--url https://...] [--wamid id]
// Loads .env.prod (falls back to .env.local).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import crypto from "node:crypto";

function loadEnv(file) {
  try {
    for (const line of readFileSync(resolve(process.cwd(), file), "utf8").split("\n")) {
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim().replace(/^"|"$/g, "");
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch { /* file optional */ }
}
loadEnv(".env.prod");
loadEnv(".env.local");

const args = process.argv.slice(2);
const getFlag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const text = args.filter((a) => !a.startsWith("--") && args[args.indexOf(a) - 1]?.startsWith("--") !== true)[0]
  || `Reminder smoke ${new Date().toISOString()}`;

const secret = process.env.WHATSAPP_APP_SECRET;
const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
const base = (getFlag("url", process.env.JENSEN_PUBLIC_URL) || "").replace(/\/$/, "");
if (!secret || !phoneId || !base) {
  console.error("need WHATSAPP_APP_SECRET, WHATSAPP_PHONE_NUMBER_ID, JENSEN_PUBLIC_URL (or --url)");
  process.exit(2);
}

// Developer number from OWNER_PROFILES (Law 10): reply reroutes to dev phone.
let dev = "971501168462";
try {
  const profiles = JSON.parse(process.env.OWNER_PROFILES || "{}");
  for (const [digits, sender] of Object.entries(profiles)) {
    if (sender && sender.role === "developer") { dev = digits; break; }
  }
} catch { /* default */ }

const wamid = getFlag("wamid", `wamid.PROOF${Date.now()}`);
const payload = {
  object: "whatsapp_business_account",
  entry: [{
    id: "PROOF",
    changes: [{
      field: "messages",
      value: {
        messaging_product: "whatsapp",
        metadata: { display_phone_number: phoneId, phone_number_id: phoneId },
        contacts: [{ profile: { name: "Dev Proof" }, wa_id: dev }],
        messages: [{ from: dev, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }],
      },
    }],
  }],
};
const raw = JSON.stringify(payload);
const sig = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");

const t0 = Date.now();
const res = await fetch(`${base}/api/whatsapp`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-hub-signature-256": sig },
  body: raw,
});
const ms = Date.now() - t0;
const body = await res.text();
console.log(JSON.stringify({ url: `${base}/api/whatsapp`, status: res.status, ms, wamid, body: body.slice(0, 300) }, null, 2));
if (!res.ok) process.exit(1);
