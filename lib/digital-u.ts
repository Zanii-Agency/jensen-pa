// Digital Jensen meeting-bot driver. The ONE place jensen-pa talks to the
// zanii-meetingbot service. Used by:
//   1. WhatsApp handler: Jensen pastes a Meet/Zoom/Teams link, fire immediately.
//   2. Mail-sweep: triage finds an emailed invite with a meetingUrl + date+time,
//      schedule the bot for 30 seconds before the meeting starts.
//
// The meeting-bot's /api/dispatch endpoint accepts {link, title?, scheduledAt?,
// callbackUrl, callbackKey?, displayName?} and POSTs notes back to callbackUrl
// when the capture finishes. Our callback is jensen-pa's /api/ingest, which
// extracts tasks and WhatsApps Jensen the summary in his own voice.

const MEET_RE = /(https?:\/\/(?:meet\.google\.com|[^\s]*\.zoom\.us|teams\.(?:microsoft|live)\.com)\/[\w\-/?&=#.@]+)/i;

// Pulls the first Meet/Zoom/Teams URL out of free text. Trailing punctuation
// (commas, full stops, parens, quotes) is trimmed because messaging clients
// frequently append them to URLs. Use this ONLY to decide "is this a platform
// my note-taker can join". For "is there a link to SAVE", use extractAnyUrl.
export function extractMeetingLink(text: string): string | null {
  const m = String(text || "").match(MEET_RE);
  if (!m) return null;
  return m[1].replace(/[).,;'"!?\]]+$/, "");
}

// Link-first capture (Jensen-elevation Phase 1). Pulls the first http(s) URL of
// ANY host. The old code gated link-save on MEET_RE (Meet/Zoom/Teams only), so a
// Luma invite (`luma.com/DubaiTechTues...`, 22 Jun) was silently dropped and the
// bot lied "the Luma link is saved in the notes". A link is a durable fact about
// a meeting regardless of host: capture it, classify the platform separately.
const ANY_URL_RE = /(https?:\/\/[^\s]+)/i;
export function extractAnyUrl(text: string): string | null {
  const m = String(text || "").match(ANY_URL_RE);
  if (!m) return null;
  return m[1].replace(/[).,;'"!?\]]+$/, "");
}

// Words that carry NO meeting identity. The old matcher (route.ts) matched a link
// to an event if ANY word >3 chars in the message appeared in an event title, so
// "sotiris meeting ... with this link" fuzz-matched "Meeting with A2 Milk" on the
// word "meeting" and attached Sotiris's link to A2 Milk (25 Jun, incident D). An
// identity match must ignore these scaffold words and require a DISTINCTIVE token.
const TITLE_STOPWORDS = new Set([
  "meeting", "meet", "call", "with", "the", "and", "for", "this", "that", "your",
  "send", "link", "reminder", "tomorrow", "today", "join", "take", "notes", "noon",
  "morning", "evening", "afternoon", "pm", "am", "at", "on", "to", "me", "a2",
]);

// Resolve which existing event a free-text message refers to, by IDENTITY not
// fuzzy substring. Returns the single event whose title shares a distinctive
// (non-stopword, >3 char) token with the message, or null when there is no
// confident single match (ambiguous or none -> caller parks the link + asks,
// never guesses, never silent-drops). zanii-codef: deliberately conservative —
// a wrong attach is worse than an honest "which meeting?".
export function resolveEventByIdentity(
  message: string,
  events: { id: string; title: string }[],
): { id: string; title: string } | null {
  const tokens = String(message || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !TITLE_STOPWORDS.has(w));
  if (!tokens.length) return null;
  const hits = events.filter((e) => {
    const t = (e.title || "").toLowerCase();
    return tokens.some((w) => t.includes(w));
  });
  return hits.length === 1 ? { id: hits[0].id, title: hits[0].title } : null;
}

// Decide what meeting_url to persist on a calendar write. An explicit value the
// model passed wins; otherwise pull the link straight out of the operator's
// triggering message. This is the deterministic capture that stops links from
// being dropped: the LLM is no longer trusted to remember to pass it (Sotiris,
// 25 Jun, the bot even said "Teams link saved" and saved nothing). KT #206573.
export function meetingUrlForWrite(explicit: string | undefined | null, lastInbound: string | undefined | null): string | undefined {
  if (explicit && String(explicit).trim()) {
    const inExplicit = extractMeetingLink(String(explicit));
    return inExplicit || String(explicit).trim();
  }
  return extractMeetingLink(String(lastInbound || "")) || undefined;
}

function siteUrl(): string {
  // Prefer an explicit override (set on Vercel), then VERCEL_URL, then the
  // canonical production domain.
  const explicit = process.env.JENSEN_PUBLIC_URL;
  if (explicit) return explicit.replace(/\/$/, "");
  const v = process.env.VERCEL_URL;
  if (v) return `https://${v.replace(/\/$/, "")}`;
  return "https://jensen.zanii.agency";
}

// Detect "make the bot leave the meeting" intent in a WhatsApp inbound. We are
// generous about phrasing (Jensen will type things like "yo get out", "stop
// it", "kill the bot", "leave", "cancel") and conservative about false
// positives: the verb must be the dominant intent of the message, NOT a
// phrase inside a longer thought ("stop me if I am wrong" should not fire).
// Returns true only when the message is essentially the cancel verb on its
// own (with optional bot-direction prefix like "digital jensen").
const CANCEL_RE = /^(?:(?:digital\s+jensen\b)|(?:hey\s+(?:digital\s+jensen|bot|jensen))\b)?\s*[,.:]?\s*(stop(?:\s+it)?|leave(?:\s+(?:the\s+)?(?:meeting|call|room))?|cancel|abort|get\s+out|kill\s+(?:it|the\s+bot)|quit|exit)\s*[.!]?\s*$/i;

export function isCancelIntent(text: string): boolean {
  const t = String(text || "").trim();
  if (!t || t.length > 80) return false; // long messages are not cancels
  return CANCEL_RE.test(t);
}

// Fire the cancel on the meeting-bot. Returns { ok, title?, error? }.
export async function cancelActiveBot(): Promise<{ ok: boolean; title?: string; botId?: string; error?: string }> {
  const base = (process.env.MEETING_BOT_URL || "").replace(/\/$/, "");
  const key = process.env.MEETING_BOT_API_KEY;
  if (!base || !key) return { ok: false, error: "MEETING_BOT_URL or MEETING_BOT_API_KEY not configured" };
  try {
    const r = await fetch(`${base}/api/dispatch/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({}),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: body?.error || `${r.status} ${r.statusText}` };
    return { ok: true, title: body?.title, botId: body?.botId };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// Fire a dispatch at the meeting-bot. If scheduledAt is omitted, the bot joins
// immediately. Returns { ok, mode?, error? }.
export async function dispatchMeetingBot(opts: {
  link: string;
  title?: string;
  scheduledAt?: string; // ISO 8601
  displayName?: string;
  phone?: string;       // WhatsApp number to send the summary back to
}): Promise<{ ok: boolean; mode?: string; eventId?: string; botId?: string; error?: string }> {
  const base = (process.env.MEETING_BOT_URL || "").replace(/\/$/, "");
  const key = process.env.MEETING_BOT_API_KEY;
  if (!base || !key) {
    return { ok: false, error: "MEETING_BOT_URL or MEETING_BOT_API_KEY not configured" };
  }
  const ingestKey = process.env.INGEST_KEY;
  const callbackUrl = `${siteUrl()}/api/ingest${opts.phone ? `?phone=${opts.phone}` : ""}`;
  try {
    const r = await fetch(`${base}/api/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({
        link: opts.link,
        title: opts.title || "",
        scheduledAt: opts.scheduledAt || undefined,
        callbackUrl,
        callbackKey: ingestKey || undefined,
        displayName: opts.displayName || "Digital Jensen",
        phone: opts.phone || undefined,
        // KT #362: opt in to lifecycle pings. The engine calls back {event:"joined"}
        // when admitted and {event:"waiting"} if stuck in the waiting room. The
        // /api/ingest handler handles both; flag and handler ship together.
        lifecycle: true,
      }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { ok: false, error: body?.error || `${r.status} ${r.statusText}` };
    }
    return { ok: true, mode: body?.mode, eventId: body?.eventId, botId: body?.botId };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}
