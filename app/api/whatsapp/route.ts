import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { sendWhatsApp, isOwner, whoIs, mirrorInbound } from "@/lib/whatsapp";
import { sendTextAndLog } from "@/lib/sendTextAndLog";
import { runConcierge } from "@/lib/concierge/loop";
import { sendFiledDocument } from "@/lib/concierge/dispatch";
import { kvGet, kvSet, admin } from "@/lib/db";
import * as ops from "@/lib/concierge/ops";
import { classifyAndFile } from "@/lib/concierge/intake";
import { readImage, readPdf } from "@/lib/anthropic";
import { extractTextFromBuffer } from "@/lib/extract-text";
import { uploadReceipt } from "@/lib/storage";
import { embed, chunk } from "@/lib/openai";
import { transcribeAudio } from "@/lib/transcribe";
import { sbSelect, enc } from "@/lib/concierge/rest";
import { extractMeetingLink, extractAnyUrl, resolveEventByIdentity, dispatchMeetingBot, isCancelIntent, cancelActiveBot } from "@/lib/digital-u";
import { parkLink } from "@/lib/pending-links";
import { shouldProcess, mediaArrived } from "@/lib/brain-core/index.js";
import { coalesceTurn, finishTurn } from "@/lib/whatsapp-coalesce";
import { parseStatuses, shouldApplyStatus } from "@/lib/concierge/wa-delivery.mjs";

export const runtime = "nodejs";
export const maxDuration = 120;

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

// Deterministic "send me my <identity doc>" intent -> a canonical doc query, or
// null. Identity docs are single-instance per person, so a deterministic send
// carries no wrong-file risk (KT #206561). Requires a retrieve verb AND a
// specific identity-doc noun, so it never fires on ordinary chat.
function matchIdentityFileRequest(s: string): string | null {
  if (!/\b(send|pull\s*up|pull|get|grab|show|share|give|fetch|forward|retrieve)\b/i.test(s)) return null;
  if (/\bpassport\b/i.test(s)) return "passport";
  if (/\b(emirates\s*id|national\s*id|\beid\b)\b/i.test(s)) return "emirates id";
  if (/\bvisa\b/i.test(s)) return "visa";
  return null;
}

// Meta webhook verification handshake.
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  if (p.get("hub.mode") === "subscribe" && p.get("hub.verify_token") === process.env.WHATSAPP_VERIFY_TOKEN) {
    return new Response(p.get("hub.challenge") || "", { status: 200 });
  }
  return new Response("forbidden", { status: 403 });
}

// Best-effort dedupe so Meta retries don't double-process a message.
// v0.2 (2026-06-12): race proof. The old kv array (read, includes, write back)
// lost ids when two Meta retries landed concurrently: both read the same
// array, both missed, both processed, one write clobbered the other. Now the
// truth is a wa_seen table with wamid as PRIMARY KEY: the insert IS the check,
// atomically, in one round trip. A unique violation means a sibling owns it.
// Falls back to the old kv path only if the table does not exist yet (apply
// db/2026-06-12_wa_seen.sql), so this ships safely ahead of the migration.
async function seen(id: string): Promise<boolean> {
  try {
    const { error } = await admin().from("wa_seen").insert({ wamid: id });
    if (!error) return false;                                  // we own it: process
    const msg = String(error.message || "");
    if (/duplicate key|unique/i.test(msg) || (error as any).code === "23505") return true; // sibling owns it
    if (!/does not exist|relation .*wa_seen/i.test(msg) && (error as any).code !== "42P01") {
      // Unknown DB failure: fail open (process) rather than drop a message.
      return false;
    }
  } catch {
    // network blip: fall through to kv
  }
  try {
    const arr = await kvGet<string[]>("wa_seen", []);
    if (arr.includes(id)) return true;
    await kvSet("wa_seen", [...arr.slice(-199), id]);
    return false;
  } catch {
    return false;
  }
}

// Meta webhook signature (Architecture 2, 2026-06-12). Jensen was the only
// bot in the fleet accepting UNSIGNED POSTs: anyone who learned the URL could
// forge an inbound and drive a concierge that holds mail, calendar, and
// finance write tools. Mirrors Sasa's pattern: constant-time compare, and the
// gate only arms once WHATSAPP_APP_SECRET is set (early-setup escape hatch).
function verifyMetaSignature(raw: string, header: string | null): boolean {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return false;
  if (!header) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function downloadMedia(mediaId: string): Promise<{ buf: Buffer; mime: string; base64: string } | null> {
  try {
    const token = process.env.WHATSAPP_TOKEN;
    const meta = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
    if (!meta?.url) return null;
    const bin = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
    const buf = Buffer.from(await bin.arrayBuffer());
    return { buf, mime: meta.mime_type || "application/octet-stream", base64: buf.toString("base64") };
  } catch {
    return null;
  }
}

async function recentHistory(party: string): Promise<{ role: "user" | "assistant"; content: string }[]> {
  try {
    return await ops.chatRecent(party, 12);
  } catch {
    return [];
  }
}

export async function POST(req: NextRequest) {
  try {
    const raw = await req.text();
    if (!verifyMetaSignature(raw, req.headers.get("x-hub-signature-256"))) {
      return new NextResponse("bad signature", { status: 401 });
    }
    const body = JSON.parse(raw || "{}");
    // WABA payload diagnostic. Empirically Meta's webhook entry[0].id on THIS
    // account surfaces the system-user id, not the WABA id, so a fully-auto
    // template submission path is not possible from the webhook. We still
    // stash the most recent webhook payload (heavily truncated) and the seen
    // entry[0].id in kv so the operator has something to inspect when looking
    // up the real WABA_ID in Meta's dashboard.
    try { await captureWebhookDiagnostic(body); } catch {}

    // DELIVERY STATUS (KT #206576): Meta posts sent/delivered/read/failed updates
    // under value.statuses[], keyed by the message wamid we store on
    // chat_messages.external_id. Record the real lifecycle so delivery is a
    // column, not inferred from "Meta accepted it" (the Sotiris blind spot).
    // Monotonic (never downgrade), best-effort, and degrades cleanly if the
    // delivery_* columns are not migrated yet. Status webhooks carry no messages,
    // so handle and ack here before the inbound path.
    const statuses = parseStatuses(body?.entry?.[0]?.changes?.[0]?.value);
    if (statuses.length) {
      try {
        for (const s of statuses) {
          const { data } = await admin()
            .from("chat_messages")
            .select("id,delivery_status")
            .eq("external_id", s.wamid)
            .order("ts", { ascending: false })
            .limit(1);
          const row = Array.isArray(data) ? data[0] : null;
          if (!row || !shouldApplyStatus(row.delivery_status, s.status)) continue;
          await admin()
            .from("chat_messages")
            .update({ delivery_status: s.status, delivery_at: s.at ?? Date.now(), delivery_error: s.error })
            .eq("id", row.id);
        }
      } catch { /* best-effort; never block the 200 ack to Meta */ }
      return NextResponse.json({ ok: true, statuses: statuses.length });
    }

    const msg = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const from: string = msg?.from || "";
    if (!from || !msg?.id) return NextResponse.json({ ok: true });
    // Capture the WhatsApp message id once. Later branches shadow `msg` (e.g. the
    // media branch reuses `msg` as a reply string), so every inbound save passes
    // this stable id to chatAppend's idempotency to converge on one row.
    const inboundWamid: string | null = msg?.id ? String(msg.id) : null;

    // EARLY SAVE: persist every inbound message before any processing gate so
    // the message is never lost even if shouldProcess, runConcierge, or any
    // subsequent step fails or returns early. Covers text, voice, audio,
    // image, document, video, reaction, sticker, location, and contacts.
    // The type-specific handler below will call chatAppend again with the
    // full content (transcript, OCR, etc.); that is fine (idempotent append).
    const earlyText = (() => {
      if (msg.text?.body) return msg.text.body.trim();
      if (msg.voice) return "[voice note]";
      if (msg.audio) return "[audio]";
      if (msg.image) return msg.image.caption ? `[image] ${msg.image.caption}` : "[image]";
      if (msg.document) return msg.document.caption ? `[document] ${msg.document.caption}` : `[document: ${msg.document.filename || "file"}]`;
      if (msg.video) return msg.video.caption ? `[video] ${msg.video.caption}` : "[video]";
      if (msg.reaction) return `[reaction: ${msg.reaction.emoji || ""}]`;
      if (msg.sticker) return "[sticker]";
      if (msg.location) return `[location: ${msg.location.latitude},${msg.location.longitude}]`;
      if (msg.contacts?.length) return `[contact: ${msg.contacts[0].name?.formatted_name || "shared"}]`;
      return "";
    })();
    if (earlyText) {
      const sender = whoIs(from);
      const party = sender.role !== "owner" ? "taona" : "jensen";
      await ops.chatAppend("user", earlyText, "whatsapp", party, { externalId: inboundWamid }).catch(() => {});
    }

    // Brain-core webhook guard: concurrent dedup (2s lock per sender) + media-
    // pending buffer (wait for image webhook when text says "this"/"here").
    // Dedup via wa_seen table: insert is atomic, unique violation = already seen.
    // NOTE: shouldProcess calls seenByWamid FIRST. If it returns false (not seen),
    // the wamid MUST be persisted so subsequent retries are caught. That is why
    // seenByWamid does the insert+check, same as the old standalone seen().
    // textBody is the raw text for shouldProcess media-buffer matching.
    // Non-text types pass empty so "this"/"here" text is not confused with
    // "[voice note]" stub content.
    const textBody = msg.text?.body?.trim() || "";
    // hasMedia exempts an actual media webhook (image/document/video/voice/audio/
    // sticker) from the per-sender 2s lock: two DISTINCT images sent seconds apart
    // carry distinct wamids, so the wamid dedup already catches a true re-delivery,
    // and the lock would only drop the second real file (Stalia 2026-09-01: portal
    // screenshot then bank proof, second lost). Same media set as the early-save above.
    const hasMedia = Boolean(msg.image || msg.document || msg.video || msg.voice || msg.audio || msg.sticker);
    const guard = await shouldProcess("jensen", from, msg.id, textBody, {
      seenByWamid: async (id: string) => { const s = await seen(id); return s; },
      logToChat: async (sender: string, t: string) => {
        const party = whoIs(sender)?.role !== "owner" ? "taona" : "jensen";
        // The buffered text was already early-saved (with its wamid) when it first
        // arrived; flushing it here would create a second, id-less row (the
        // text-then-image "this" double-save). Skip if an identical row from this
        // party exists in the last 2 minutes. Fail safe: on any error or no match,
        // save it so a message is never lost.
        try {
          const recent = await sbSelect<any>("chat_messages", `party=eq.${enc(party)}&role=eq.user&content=eq.${enc(t)}&order=ts.desc&limit=1`);
          const ts0 = recent?.[0]?.ts;
          if (ts0 && Date.now() - Number(ts0) < 120000) return;
        } catch { /* fall through to save (never drop a message) */ }
        await ops.chatAppend("user", t, "whatsapp", party).catch(() => {});
      },
    }, { hasMedia });
    if (guard.action !== "process") return NextResponse.json({ ok: true });

    // MAINTENANCE GATE. While JENSEN_MODE=TRAINING:
    //   - allowlisted senders (Taona + Jensen, per ALLOWLIST env) pass through
    //     normally. Jensen lands in onboarding-listener mode inside runConcierge
    //     (withTools=false, captureSalience writes brain_facts) so the bot reads
    //     him, responds warmly, remembers — but does NOT log anything to the
    //     actionable portal (no tasks, events, finance rows).
    //   - random non-allowlisted senders: silent drop. No "private line" notice
    //     leaks during the training window. Per Taona directive 2026-06-09:
    //     no training/upgrade notice may reach Jensen; the listener experience
    //     IS the answer, with the onboarding system prompt reassuring him
    //     "by tomorrow we are live."
    if (process.env.JENSEN_MODE === "TRAINING") {
      const allow = (process.env.MAINTENANCE_ALLOWLIST || "")
        .split(",")
        .map((s) => s.replace(/[^0-9]/g, ""))
        .filter(Boolean);
      const fromDigits = from.replace(/[^0-9]/g, "");
      if (!allow.includes(fromDigits)) {
        return NextResponse.json({ ok: true });
      }
    }

    // owner gate: Jensen (and Taona) drive the concierge; anyone else is gently
    // redirected to Jensen's direct WhatsApp. Don't leak that this is a bot.
    if (!isOwner(from)) {
      await sendWhatsApp(
        from,
        "Thank you for reaching out. This line is private to Jensen. To reach him directly, please message https://wa.me/971528902032.",
      );
      return NextResponse.json({ ok: true });
    }

    const sender = whoIs(from);
    // OPERATOR MIRROR (silent, never shown to the sender). Forward Jensen's inbound
    // to Taona's number so he can live-tail conversations. Only the principal's
    // (owner's) inbound is mirrored; the operator's own messages are never echoed
    // back to himself. Media is summarised.
    if (sender.role === "owner") {
      const inboundSummary =
        msg.text?.body ||
        (msg.voice ? "[voice note]" :
         msg.audio ? "[audio]" :
         msg.image ? `[image]${msg.image.caption ? ": " + msg.image.caption : ""}` :
         msg.document ? `[document: ${msg.document.filename || "file"}]` :
         "[message]");
      mirrorInbound(inboundSummary, from).catch(() => {});
    }
    const history = await recentHistory(sender.role !== "owner" ? "taona" : "jensen");
    // Voice notes arrive as msg.voice (push-to-talk) or msg.audio (uploaded audio).
    // Treat both: transcribe and flow into the concierge as text.
    const audio = msg.voice || msg.audio || (msg.document?.mime_type?.startsWith("audio/") ? msg.document : null);
    const media = msg.image || msg.document || msg.video || null;
    const caption: string = msg.image?.caption || msg.document?.caption || "";

    // ---- audio: download, transcribe via Whisper, hand to concierge as text ----
    if (audio && !media?.mime_type?.startsWith("image/") && !audio.filename?.match(/\.(pdf|docx?|xlsx?|csv|txt)$/i)) {
      const dl = await downloadMedia(audio.id);
      if (!dl) { await sendWhatsApp(from, "I couldn't fetch that voice note. Try again."); return NextResponse.json({ ok: true }); }
      const transcript = await transcribeAudio(dl.buf, dl.mime);
      if (!transcript) { await sendWhatsApp(from, "I got your voice note but couldn't make out the words. Could you re-record or type it?"); return NextResponse.json({ ok: true }); }
      const party = sender.role !== "owner" ? "taona" : "jensen";
      // Persist with a [voice note] marker so chat history shows it came as audio.
      await ops.chatAppend("user", `[voice note] ${transcript}`, "whatsapp", party, { externalId: inboundWamid }).catch(() => {});
      const { reply } = await runConcierge({ messages: [...history, { role: "user", content: transcript }], channel: "whatsapp", sender });
      await sendWhatsApp(from, reply || "I'm here.");
      return NextResponse.json({ ok: true });
    }

    // ---- media: download, read, file into the portal via the brain ----
    if (media) {
      // Check brain-core for a buffered text message from the same sender.
      const pendingText = mediaArrived(from);
      let combinedCaption = caption;
      if (pendingText) {
        combinedCaption = caption ? `${pendingText}: ${caption}` : pendingText;
      }
      const dl = await downloadMedia(media.id);
      if (!dl) { await sendWhatsApp(from, "I couldn't fetch that file from WhatsApp. Try sending it again."); return NextResponse.json({ ok: true }); }
      // VAULT THE ORIGINAL BYTES FIRST so the file itself is retrievable later
      // ("send me my passport"). Best-effort: a storage hiccup must not lose the
      // doc record. KT #206561.
      let storagePath: string | null = null;
      try { storagePath = await uploadReceipt(dl.buf, media.filename || "whatsapp-upload", dl.mime); }
      catch (e) { console.error(`[intake] file-vault failed for ${media.filename}:`, e instanceof Error ? e.message : e); }
      let text = "";
      if (dl.mime.startsWith("image/")) text = await readImage(dl.base64, dl.mime);
      else text = (await extractTextFromBuffer(dl.buf, dl.mime, media.filename || "document")) || "";
      // Scanned / image-only PDF (no text layer, e.g. a passport scan): OCR via
      // Claude's document block so it is still read + filed (KT #348).
      if (!text.trim() && (dl.mime === "application/pdf" || /\.pdf$/i.test(media.filename || ""))) text = await readPdf(dl.base64);
      const unreadable = !text.trim();

      const id = uid();
      const title = (media.filename || combinedCaption || "WhatsApp upload").replace(/\.[a-z0-9]+$/i, "").slice(0, 80) || "WhatsApp upload";
      let chunks: { text: string; embedding: number[] }[] = [];
      try { const parts = chunk(text); const vecs = parts.length ? await embed(parts) : []; chunks = parts.map((t, i) => ({ text: t, embedding: vecs[i] })); } catch { /* no embedder: keyword only */ }
      // ALWAYS file the doc — even when unreadable. The OLD code returned here
      // ("I saved your file but couldn't read text") WITHOUT calling addDoc, so a
      // scanned passport whose OCR failed was DROPPED and "saved" was a lie. Now
      // the record + the vaulted bytes are always kept, so it is retrievable.
      await ops.addDoc({ id, title, fileName: media.filename || "whatsapp-upload", mime: dl.mime, kind: "document", text, chunks, dataUrl: storagePath ?? undefined, createdAt: Date.now() });

      // Intake runs out-of-band from the chat brain. During onboarding it
      // READS (chunks, embeds, remembers) but does NOT WRITE (no finance
      // row, no expense logged). Listen-only means listen-only.
      const prefs = await ops.getPrefs().catch(() => ({} as any));
      const ownerOnboarding = sender.role === "owner" && (prefs as any)?.onboarding !== false;
      const filed = await classifyAndFile({ id, title, text, dataUrl: storagePath ?? undefined }, { onboarding: ownerOnboarding });
      let msg: string;
      if (unreadable) {
        // Honest: the text could not be read, but the FILE is vaulted (if storage
        // succeeded) and retrievable. Never claim a clean read we did not get.
        msg = storagePath
          ? `I've vaulted *${title}* under *${filed.folder}*, restricted. I could not read its text, but I have the file itself and can send it back whenever you ask.`
          : `I received *${title}* but could not read it or store it cleanly. Please send it again, ideally as a clear PDF or photo, and I'll vault it.`;
      } else if (ownerOnboarding) {
        msg = `Got it. I've read *${title}* and it's in my memory.`;
        if (filed.summary) msg += ` ${filed.summary}`;
        if (filed.pending) {
          msg += ` Looks like an invoice for ${filed.pending.currency || "AED"} ${filed.pending.amount} from ${filed.pending.label}. I'm in listening mode right now so I am not logging it to your books yet; the moment you switch me on I'll file it properly.`;
        } else {
          msg += ` I'll bring it up when it's relevant.`;
        }
      } else {
        msg = `Filed *${title}* under *${filed.folder}*.`;
        if (filed.finance) msg += ` Logged an expense of AED ${filed.finance.amount} (${filed.finance.label}).`;
        msg += ` I've read it, so I can pull it up or send it whenever you need.`;
      }
      const party = sender.role !== "owner" ? "taona" : "jensen";
      await ops.chatAppend("user", `[sent a document: ${title}]`, "whatsapp", party, { externalId: inboundWamid }).catch(() => {});
      await ops.chatAppend("assistant", msg, "whatsapp", party).catch(() => {});
      await sendWhatsApp(from, msg);
      return NextResponse.json({ ok: true });
    }

    // ---- plain text: full concierge ----
    const text = (msg.text?.body || "").trim();
    if (!text) return NextResponse.json({ ok: true });

    // DETERMINISTIC CANCEL CHOKEPOINT. "stop" / "leave" / "cancel" / "get out"
    // when sent alone (or with the "digital jensen" prefix) kills the active
    // meeting-bot. Whatever was captured before the cancel still flows back
    // to /api/ingest, so Jensen gets partial notes + tasks for what the bot
    // caught. Same pattern as the link-detection below: deterministic verbs
    // deserve deterministic code (KT #127).
    if (isCancelIntent(text)) {
      const inboundParty = sender.role !== "owner" ? "taona" : "jensen";
      await ops.chatAppend("user", text, "whatsapp", inboundParty, { externalId: inboundWamid }).catch(() => {});
      const r = await cancelActiveBot();
      const ack = r.ok
        ? `Stopping. I am leaving ${r.title || "the meeting"} now. Anything I caught up to this point will land here with the notes and tasks in a moment.`
        : r.error === "no active bot to cancel"
          ? `There is no notetaker in a meeting right now, so nothing to stop. If you meant something else, send it again with a couple more words.`
          : `I tried to stop the notetaker and the service returned: ${r.error}. Try again or check on it directly.`;
      await sendTextAndLog(from, ack, { party: inboundParty, dev: sender.role === "developer" ? true : undefined });
      return NextResponse.json({ ok: true });
    }

    // MEETING-LINK CHOKEPOINT. When the inbound carries a Meet/Zoom/Teams link,
    // save it onto the matching upcoming event so the 5-minute reminder can hand
    // the link back to him at meeting time (the thing he actually wanted: the
    // Sotiris 2026-06-16 incident, where he asked for the link in the reminder
    // and instead got a bare cron line because the reminder never read meeting_url).
    //
    // We NEVER attempt to join right now. DigitalJensen (the note-taker) was
    // returning "unauthorized" at that time, and an immediate attempt surfaced
    // that failure straight to Jensen. Instead we PROMISE to join at the meeting
    // time and schedule the join best-effort (silent: it just starts working once
    // the note-taker auth is fixed). The link reaches him via the reminder either
    // way, independent of whether the join ever succeeds.
    // Phase 1 link/memory convergence (KT #206577 line, supersedes the fuzzy
    // matcher). Capture ANY url (not just joinable platforms — the Luma drop), and
    // resolve the target event by IDENTITY not any-word substring (the Sotiris->A2
    // Milk misroute). meetingLink stays the join gate (can only send a bot into a
    // real Meet/Zoom/Teams room); anyLink is what we SAVE.
    const meetingLink = extractMeetingLink(text);
    const anyLink = extractAnyUrl(text);
    if (anyLink) {
      const rest = text.replace(anyLink, "").trim();
      const JOIN_INTENT_RE = /\b(join|take notes|note ?taker|attend|cover)\b/i;
      const wantsJoin = JOIN_INTENT_RE.test(rest) && !!meetingLink; // only a joinable platform
      const inboundParty = sender.role !== "owner" ? "taona" : "jensen";
      const botName = sender.role !== "owner" ? "Digital Taona" : "Digital Jensen";
      await ops.chatAppend("user", text, "whatsapp", inboundParty, { externalId: inboundWamid }).catch(() => {});

      try {
        const today = new Date().toISOString().slice(0, 10);
        const events = await sbSelect<any>(
          "events",
          `date=gte.${enc(today)}&time=not.is.null&order=date.asc&limit=10&select=id,title,date,time`
        ).catch(() => []);
        // Identity match: a single event whose title shares a DISTINCTIVE token
        // with the message. Ambiguous or none -> null (we park + ask, never guess).
        const match = resolveEventByIdentity(rest, events as any[]);

        // Attach the link to the matched event, then READ IT BACK before claiming
        // saved (the old code trusted the PATCH ok flag and lied "saved in notes").
        let saved = false;
        if (match) {
          // patchedOk: this write succeeded; readBack: the row holds the link.
          // Require BOTH (skeptic F4) so an idempotent re-send or a silently failed
          // PATCH on an already-equal row can never claim a save this turn did.
          const patchedOk = await fetch(`${process.env.SUPABASE_URL}/rest/v1/events?id=eq.${enc(match.id)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", apikey: process.env.SUPABASE_SERVICE_KEY || "", Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY || ""}` },
            body: JSON.stringify({ meeting_url: anyLink }),
          }).then((r) => r.ok).catch(() => false);
          const check = await sbSelect<any>("events", `id=eq.${enc(match.id)}&select=meeting_url&limit=1`).catch(() => []);
          saved = patchedOk && (check as any[])?.[0]?.meeting_url === anyLink; // claim only a write that landed
        }

        if (wantsJoin) {
          // WHEN to join: only a clearly-future calendar match is scheduled (the
          // time comes from the calendar, never parsed from free text). Anything
          // else (no event, or the matched meeting is happening now / already
          // started) joins IMMEDIATELY, because an explicit "join + link" means
          // the call is live. We AWAIT the dispatch so (a) the serverless worker
          // is not SIGTERM'd before the request reaches the note-taker, and
          // (b) the ack reflects what actually happened, never a promised join
          // that never queued.
          const matchJoinAt = match
            ? new Date(`${match.date}T${String(match.time).padStart(5, "0")}:00+04:00`).getTime()
            : NaN;
          const future = !Number.isNaN(matchJoinAt) && matchJoinAt > Date.now() + 60000;
          const title = match ? match.title : "your meeting";
          const d = await dispatchMeetingBot({
            link: meetingLink,
            title,
            scheduledAt: future ? new Date(matchJoinAt - 30000).toISOString() : undefined,
            displayName: botName,
            phone: from,
          }).catch((e: any) => ({ ok: false, error: e?.message || String(e) }));

          // KT #362: a dispatch 200 means the join was QUEUED, not that the bot is
          // in the room (the engine joins after responding). So the immediate ack
          // claims only the dispatch, asks Jensen to admit the bot from the waiting
          // room (the usual no-join cause), and promises word either way. The
          // lifecycle pings then deliver "I am in now" / "admit me" at the real
          // moments. The scheduled ack is a future intent and stays as is.
          const ack = !d.ok
            ? `I could not reach my note-taker just now to set up the join. Send me the link again in a moment and I will retry.`
            : future
            ? `Saved. I will join *${title}* at ${match.time} on ${match.date} to take notes, and you will get the link in your reminder so you can hop in too.`
            : match
            ? `I am sending Digital Jensen into *${title}* now. If the meeting has a waiting room, please admit Digital Jensen so it can get in. Once it is in I will send you the summary and the action items when it wraps, and if it cannot get in I will tell you here.`
            : `I am sending Digital Jensen into the meeting now. If the meeting has a waiting room, please admit Digital Jensen so it can get in. Once it is in I will send you the summary and the action items when it wraps, and if it cannot get in I will tell you here.`;
          await sendTextAndLog(from, ack, { party: inboundParty, dev: sender.role === "developer" ? true : undefined });
          return NextResponse.json({ ok: true });
        }

        // Link but no explicit join intent: save it to the event for the
        // reminder, or fall through to the brain if there is no event.
        if (match) {
          const ack = saved
            ? `Saved your link to *${match.title}* at ${match.time} on ${match.date}. I will send it to you in the reminder so you can join when it is time.`
            : `I had trouble saving that link just now. Send it to me again in a moment and I will get it onto *${match.title}*.`;
          await sendTextAndLog(from, ack, { party: inboundParty, dev: sender.role === "developer" ? true : undefined });
          return NextResponse.json({ ok: true });
        }

        // No confident existing-event match. PARK the link as a safety net (incident
        // B: it may belong to a meeting created later; the brain's attachMeetingLink
        // claims it on identity), then fall through to the brain.
        // - Key on inboundParty (the role), NOT `from` (the phone): attachMeetingLink
        //   reads by ctx.party, so the keys MUST match or the park is orphaned (F1).
        // - Only park when there is a real meeting signal — a joinable platform link
        //   or an explicit join intent. A bare article URL must not pollute the
        //   buffer or hijack this path (F3); it falls straight through to the brain.
        if (meetingLink || JOIN_INTENT_RE.test(rest)) {
          await parkLink(inboundParty, anyLink, text);
        }
      } catch {}
      // Link with no join intent and no confident event match: parked above, now
      // let the brain handle it (create the meeting / respond). Fall through.
    }

    // Wall 1 of "fragment match without anchor" (2026-06-16, KT #293). When the
    // inbound was a WhatsApp swipe-to-reply on a prior Dorje message, Meta's
    // payload carries msg.context.id (the wamid of the quoted outbound). We
    // persist it on the inbound row and resolve it to the quoted excerpt before
    // runConcierge so the model is anchored to the right subject and cannot
    // fuzzy-match a different task or event.
    const replyToExternalId: string | null = msg?.context?.id ? String(msg.context.id) : null;

    // NO-CHAT-LOST. Persist every inbound to chat_messages BEFORE the brain
    // runs, so an Anthropic / Vercel failure mid-runConcierge does not lose
    // what Jensen sent. The runConcierge end-path also appends, but Jensen's
    // message must be safe before any failure can swallow it.
    const inboundParty = sender.role !== "owner" ? "taona" : "jensen";
    await ops.chatAppend("user", text, "whatsapp", inboundParty, {
      externalId: inboundWamid,
      replyToExternalId,
    }).catch(() => {});
    // Mirror inbound into Chatwoot (read-only, Path B). Best-effort.
    const { mirrorToChatwoot } = await import("@/lib/chatwoot-mirror");
    mirrorToChatwoot("incoming", from, text).catch(() => {});

    // Resolve the swipe-reply anchor (Wall 1). If the inbound reply-quoted a
    // prior Dorje outbound row, look it up by external_id (uniquely indexed)
    // and grab its content as the anchor excerpt. The model receives this as
    // a hard-wall block in the system tail telling it which prior message Jensen
    // is pointing at, so "done" no longer fuzzes against a different task.
    let swipeAnchor: { quotedExcerpt: string } | null = null;
    if (replyToExternalId) {
      try {
        const rows = await admin()
          .from("chat_messages")
          .select("content,ts,role")
          .eq("external_id", replyToExternalId)
          .limit(1);
        const quoted = (rows.data || [])[0] as any;
        if (quoted?.content) {
          const excerpt = String(quoted.content).replace(/\s+/g, " ").slice(0, 200);
          if (excerpt) swipeAnchor = { quotedExcerpt: excerpt };
        }
      } catch {
        // best-effort; absence of anchor degrades to today's fuzzy behavior, not a failure
      }
    }

    // FM-11 DETERMINISTIC DONE-RESOLUTION. Bare confirmations from JENSEN
    // (owner tier only) route the most recently created open task to done
    // WITHOUT model dispatch. KT #127: when the model is brittle for a
    // deterministic verb, code the verb. Owner-only because Taona (admin)
    // chatting "Done" must NOT mark Jensen's tasks complete. Strip the
    // harness tag before matching so the prod harness exercises this path.
    // Wall 1 carve-out (2026-06-16): a swipe-anchor on the same turn means
    // Jensen pointed at a specific message, so the LLM brain steers better
    // than open[0]; fall through to runConcierge in that case.
    const cleaned = text.replace(/^\s*\[H[a-z0-9]{6,}\]\s*/, "").trim();
    const doneEligible = sender.role === "owner" || process.env.JENSEN_MODE === "TRAINING";
    if (doneEligible && !swipeAnchor && /^(done|done\.|did it|yes done|handled|marked done)$/i.test(cleaned)) {
      const open = await ops.listTasks({ done: false }).catch(() => [] as any[]);
      if (open.length > 0) {
        await ops.updateTask({ id: open[0].id, done: true }).catch(() => {});
        await ops.chatAppend("user", text, "whatsapp", "jensen", { externalId: inboundWamid }).catch(() => {});
        const reply = `Done. Marked "${open[0].title}" complete.`;
        await ops.chatAppend("assistant", reply, "whatsapp", "jensen").catch(() => {});
        await sendWhatsApp(from, reply);
        return NextResponse.json({ ok: true });
      }
      // No open tasks: fall through to the brain so Jensen gets a graceful reply.
    }

    // DETERMINISTIC FILE-SEND-BACK (KT #206561, same principle as FM-11 above:
    // the model is unreliable at calling send_filed_document because recall-
    // injected context short-circuits the tool). Scoped to IDENTITY docs only
    // (passport / Emirates ID / visa) which are single-instance, so there is no
    // wrong-file risk; multi-instance docs (contracts, invoices) stay with the
    // brain which can disambiguate. Self-validating: only sends a real vaulted
    // file; otherwise falls through to the brain to explain + offer a re-upload.
    if (doneEligible && !swipeAnchor) {
      const idDoc = matchIdentityFileRequest(cleaned);
      if (idDoc) {
        const r = await sendFiledDocument(idDoc, inboundParty, { autoLatest: true });
        if (r.ok) {
          const reply = `Sent your ${(r.result?.sent) || idDoc}. It's in this chat now.`;
          await ops.chatAppend("user", text, "whatsapp", inboundParty, { externalId: inboundWamid }).catch(() => {});
          await ops.chatAppend("assistant", reply, "whatsapp", inboundParty).catch(() => {});
          await sendWhatsApp(from, reply);
          return NextResponse.json({ ok: true });
        }
        // No vaulted file: fall through to the brain to explain + ask for a re-send.
      }
    }

    // DURABLE TURN COALESCING (KT #330, ported from Sasa KT #327). A rapid burst
    // from the same sender must produce ONE reply, not one per message. brain-core's
    // shouldProcess lock is an in-memory Map that does NOT survive across Vercel
    // invocations; the durable wa_turn_claim (keyed by sender phone) is what
    // actually coalesces. FAIL-OPEN: any error degrades to the single-message
    // reply below (a double-reply at worst, never silence). The inbound is already
    // persisted above (NO-CHAT-LOST), so a loser's text is safe for the winner to
    // fold in.
    let co: { proceed: boolean; winner: boolean; failOpen?: boolean; command?: string };
    try {
      co = await coalesceTurn(from, inboundParty, inboundWamid, text);
    } catch (coErr) {
      // The module is self-fail-open, but double-guard here: any unexpected throw
      // degrades to the single-message reply (proceed:true), never silence.
      co = { proceed: true, winner: false, failOpen: true };
    }
    if (!co.proceed) {
      // LOSER: another invocation holds the claim and will fold this message's
      // text into its turn. Return without replying (exactly-once).
      return NextResponse.json({ ok: true, coalesced: true });
    }
    // WINNER assembled the whole burst into co.command; a fail-open reply uses the
    // single message we already have.
    const turnInput = co.winner && co.command ? co.command : text;

    // FAIL-CLOSED REPLY (never go silent). If the brain throws (Anthropic
    // outage, dead key, any error) the user must still hear back, not get
    // silence. We send an honest fallback (sending does not need the brain) and
    // log the error to the audit channel so the operator sees it. The inbound
    // is already persisted above (NO-CHAT-LOST), so nothing is lost either way.
    try {
      const { reply } = await runConcierge({ messages: [...history, { role: "user", content: turnInput }], channel: "whatsapp", sender, swipeAnchor });
      await sendWhatsApp(from, reply || "I'm here.");
    } catch (brainErr: any) {
      await sendWhatsApp(
        from,
        "I hit a snag on my end and could not finish that just now. Your message is saved, give me a moment and resend it and I will pick it straight up.",
      ).catch(() => {});
      try {
        await admin().from("chat_messages").insert({
          role: "system",
          content: `reply_failed: ${String(brainErr?.message || brainErr).slice(0, 400)}`,
          channel: "audit",
          party: inboundParty,
          ts: Date.now(),
        });
      } catch { /* best-effort audit log, never block */ }
    } finally {
      // The winner releases the claim AFTER the reply, so a crash mid-brain leaves
      // the claim to expire (TTL) rather than wedging the sender into silence. A
      // loser never reaches here (it returned above).
      if (co.winner) await finishTurn(from).catch(() => {});
    }
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 200 });
  }
}

// Lightweight webhook diagnostic. The auto-WABA-discovery path failed for this
// account because Meta surfaces the system-user id at entry[0].id (not the
// WABA id), and the token lacks business_management scope to enumerate WABAs.
// We still capture the last entry[0].id and a truncated payload preview in kv
// so the operator can compare them against their WhatsApp Manager dashboard
// when looking up the real WABA_ID. No template submission attempted: that
// path is blocked until lr_meta_waba_id is set by the operator (a number
// looked up in business.facebook.com/wa/manage and saved by a one-shot
// helper). Once set, /api/cron/daily uses MORNING_BRIEF_TEMPLATE env to know
// which approved template to fire.
async function captureWebhookDiagnostic(body: any): Promise<void> {
  try {
    const entryId = body?.entry?.[0]?.id;
    if (entryId && /^\d{10,20}$/.test(String(entryId))) {
      await kvSet("lr_meta_last_entry_id", { id: String(entryId), at: Date.now() });
    }
    // Truncated preview — first 1.5KB of the JSON. Helpful for spotting the
    // real WABA in case Meta drops it at a different key for some payloads.
    const preview = JSON.stringify(body || {}).slice(0, 1500);
    await kvSet("lr_meta_last_webhook_preview", { preview, at: Date.now() });
  } catch {
    // Diagnostic failure must never block message processing.
  }
}
