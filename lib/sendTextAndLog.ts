// JENSEN-DOCTRINE Law 2 (send-chokepoint) chokepoint. Every outbound bot-sent
// message routes through here: log to chat_messages BEFORE the Meta send so the
// brain's transcript and the wire never diverge. Mirrors the Sasa pattern.
// sendWhatsApp already enforces Law 5 (dash strip) + TRAINING gate + operator
// mirror; this wrapper adds the persistence half of the doctrine.
//
// 2026-06-12: Architecture 2 pre-send gate. Shared @sinanagency/bot-guards
// sanitizeReply runs with JENSEN_BOT_GUARDS_CONFIG before delivery. Catches
// cross-bot brand leaks (Sasa / Nisria / Stephen / Cape Town Halaal mentions
// — Jensen must NEVER reference those). On catch, body is replaced with
// reaskPhrase and the catch is logged for engineering review. The wall is
// in code; the rules are in lib/bot/guards-config.ts.

import { sendWhatsApp, sendWhatsAppRaw, sendWhatsAppInteractive, sendWhatsAppTemplate, devPhone } from "@/lib/whatsapp";
import { admin } from "@/lib/db";
import { sanitizeReply } from "@/lib/bot-guards/index.js";
import { JENSEN_BOT_GUARDS_CONFIG } from "@/lib/bot/guards-config";
import { mirrorToChatwoot } from "@/lib/chatwoot-mirror";
import { deliveryFailedAudit } from "@/lib/concierge/wa-delivery.mjs";

// Law 10 (test-mode) branch: opts.dev === true reroutes the message to the
// developer phone and SKIPS chat_messages + audit inserts. Test traffic never
// pollutes Jensen's transcript or lands on Jensen's WhatsApp. Guards still run
// so dev sees the same sanitised output the prod path would have produced.
export async function sendTextAndLog(
  to: string,
  body: string,
  opts?: { force?: boolean; party?: string; dev?: boolean }
): Promise<{ ok: boolean; dropped?: boolean }> {
  // v0.2 (2026-06-12): the PRIMITIVE sendWhatsApp now enforces the wall for
  // every caller. This wrapper still runs sanitizeReply FIRST so that the
  // chat_messages transcript records exactly what ships (never diverging from
  // the wire on a catch) and so the audit row carries the party. The second
  // pass inside sendWhatsApp is a no-op on the already-clean body.
  const sanitized = sanitizeReply(body, JENSEN_BOT_GUARDS_CONFIG);
  const sendBody = sanitized.body;
  if (opts?.dev) {
    const target = devPhone();
    if (!target) return { ok: false };
    const ok = await sendWhatsApp(target, `[DEV] ${sendBody}`, { force: true });
    return { ok };
  }
  // Wall 1 of "fragment match without anchor" (2026-06-16, KT #293): send via
  // the raw helper so we capture Meta's wamid, then back-patch chat_messages
  // .external_id on the assistant row. Persistence order is unchanged (still
  // write BEFORE the send, Law 2 send-chokepoint) so a Meta failure cannot
  // race-orphan the transcript. The patch is best-effort: if it fails the
  // outbound transcript still exists, only the swipe-anchor lookup degrades.
  const ins = await admin().from("chat_messages").insert({
    role: "assistant",
    content: sendBody,
    channel: "whatsapp",
    party: opts?.party ?? "jensen",
    ts: Date.now(),
  }).select("id").single();
  const insertedRowId: number | null = (ins?.data as any)?.id ?? null;
  // A killed scheduled message (brief, reminder, mail alert) must reach SOMEONE.
  // Before 2026-09-23 this path logged an audit row and nothing else, so six
  // morning briefs died silently. Page the developer with the original, the same
  // as the reply path in whatsapp.ts. Skipped for dev sends (they ARE the developer).
  if (sanitized.dropped) {
    const dev = devPhone();
    if (dev) {
      sendWhatsAppRaw(dev, `[Dorje wall] blocked a scheduled message to the client (caught: ${sanitized.caught.map((c) => `${c.kind}:${c.pattern}`).join(",")}). Original: ${String(body).slice(0, 500)}`, { force: true }).catch(() => {});
    }
  }
  if (sanitized.caught.length) {
    try {
      await admin().from("chat_messages").insert({
        role: "system",
        content: `pre_send_caught: ${sanitized.caught.map((c) => `${c.kind}:${c.pattern}`).join(",")} | original=${String(sanitized.caught[0]?.original || "").slice(0, 400)}`,
        channel: "audit",
        party: opts?.party ?? "jensen",
        ts: Date.now(),
      });
    } catch {
      // best-effort log; never block delivery
    }
  }
  // Read-only Chatwoot mirror (Path B). Best-effort, never blocks delivery.
  // Fires AFTER chat_messages insert so the source of truth still holds even
  // if Chatwoot is down. Direction is "outgoing" because this is bot, Jensen.
  mirrorToChatwoot("outgoing", to, sendBody).catch(() => {});
  const sendResult = await sendWhatsAppRaw(to, sendBody, opts);
  if (sendResult.ok && sendResult.wamid && insertedRowId != null) {
    try {
      await admin().from("chat_messages").update({ external_id: sendResult.wamid }).eq("id", insertedRowId);
    } catch {
      // best-effort patch; the transcript still exists without the wamid join key.
    }
  }
  // dropped: the wall killed the body, so what reached him was the polite line,
  // not this message. A caller that needs him to have SEEN the text (a question
  // he is about to tap Yes on) must treat this as not delivered.
  return { ok: sendResult.ok, dropped: sanitized.dropped };
}

// The chokepoint for confirmation buttons (Law 2: every outbound is logged before
// it is sent). The transcript records the question AND the buttons, so the record
// shows exactly what he could tap. If the wall kills the body, no buttons go out:
// he gets the polite line and the developer gets the original, as for any drop.
export async function sendButtonsAndLog(
  to: string,
  body: string,
  buttons: { id: string; title: string }[],
  opts?: { party?: string },
): Promise<{ ok: boolean }> {
  const party = opts?.party ?? "jensen";
  const ins = await admin().from("chat_messages").insert({
    role: "assistant",
    content: `${body}\n[${buttons.map((b) => b.title).join("] [")}]`,
    channel: "whatsapp",
    party,
    ts: Date.now(),
  }).select("id").single();
  const rowId: number | null = (ins?.data as any)?.id ?? null;
  const r = await sendWhatsAppInteractive(to, body, buttons);
  if (!r.ok) {
    // The transcript must not claim he was shown buttons he never got (review 4,
    // finding 4): the row is marked, and the caller cancels the held action.
    if (rowId != null) {
      try { await admin().from("chat_messages").update({ content: `${body}\n[buttons NOT delivered]` }).eq("id", rowId); } catch { /* best effort */ }
    }
    if (r.dropped) {
      const dev = devPhone();
      if (dev) sendWhatsAppRaw(dev, `[Dorje wall] blocked a confirmation to the client. Original: ${String(body).slice(0, 500)}`, { force: true }).catch(() => {});
    }
    return { ok: false };
  }
  if (r.wamid && rowId != null) {
    try { await admin().from("chat_messages").update({ external_id: r.wamid }).eq("id", rowId); } catch { /* best effort */ }
  }
  return { ok: true };
}

// The chokepoint for approved templates: the only messages Meta delivers more than
// 24h after his last message (FM-21). `text` is the template body with its
// parameters filled in, i.e. exactly what he reads; that is what the transcript
// records. The wall runs on it like any other message: if it would drop, nothing
// is sent here and the caller falls back to sendTextAndLog, which pages the
// developer. Law 10: dev sends go to the developer phone and are not logged.
export async function sendTemplateAndLog(
  to: string,
  name: string,
  lang: string,
  params: string[],
  text: string,
  opts?: { force?: boolean; party?: string; dev?: boolean },
): Promise<{ ok: boolean; dropped?: boolean }> {
  if (sanitizeReply(text, JENSEN_BOT_GUARDS_CONFIG).dropped) return { ok: false, dropped: true };
  if (opts?.dev) {
    const target = devPhone();
    if (!target) return { ok: false };
    return { ok: !!(await sendWhatsAppTemplate(target, name, lang, params, { force: true })) };
  }
  const ins = await admin().from("chat_messages").insert({
    role: "assistant",
    content: text,
    channel: "whatsapp",
    party: opts?.party ?? "jensen",
    ts: Date.now(),
  }).select("id").single();
  const rowId: number | null = (ins?.data as any)?.id ?? null;
  mirrorToChatwoot("outgoing", to, text).catch(() => {});
  const wamid = await sendWhatsAppTemplate(to, name, lang, params, { force: opts?.force, mirror: text });
  if (rowId != null) {
    try {
      await admin().from("chat_messages")
        .update(wamid ? { external_id: wamid } : { content: `${text}\n[template NOT sent]` })
        .eq("id", rowId);
    } catch { /* best effort */ }
  }
  if (!wamid) {
    // Not silent: counted by /api/health/wall-drops, and the developer is paged.
    try {
      await admin().from("chat_messages").insert({
        role: "system", channel: "audit", party: opts?.party ?? "jensen", ts: Date.now(),
        content: deliveryFailedAudit({ wamid: "none", error: `template ${name} not sent` }, { content: text }),
      });
    } catch { /* best effort */ }
    const dev = devPhone();
    if (dev) sendWhatsAppRaw(dev, `[Dorje] template ${name} was not sent to the client. It said: ${text.slice(0, 300)}`, { force: true }).catch(() => {});
  }
  return { ok: !!wamid };
}
