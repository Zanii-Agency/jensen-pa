// Voice-note transcription. Thin Jensen adapter over @zanii/intake's
// transcribeAudio primitive. WhatsApp voice notes arrive as OGG/Opus; Whisper
// handles that natively. Server-only.
//
// Signature preserved (Buffer in, Promise<string | null> out — null on missing
// key or empty result, so the WhatsApp handler can degrade gracefully).
//
// Primary-with-fallback policy (Law 12 + KT entry "primary-with-fallback for
// cloud-replaced services"): when TRANSCRIBE_PRIMARY_URL is set, try the
// OpenAI-wire-compatible primary endpoint first with a 5s timeout. On
// timeout, network error, or empty result, fall back to hosted OpenAI on
// the deterministic safety net. Either path obeys intake's graceful
// degradation contract (empty string on failure -> null at the boundary).
//
// We log which path was used and elapsed ms so the split is observable.

import { transcribeAudio as intakeTranscribeAudio } from "./intake/index.js";

const PRIMARY_TIMEOUT_MS = 5000;

interface RaceResult {
  text: string;
  timedOut: boolean;
}

async function withTimeout(p: Promise<string>, ms: number): Promise<RaceResult> {
  let timeoutId: NodeJS.Timeout | undefined;
  const timeout = new Promise<RaceResult>((resolve) => {
    timeoutId = setTimeout(() => resolve({ text: "", timedOut: true }), ms);
  });
  const main = p.then((text) => ({ text, timedOut: false }));
  try {
    const result = await Promise.race([main, timeout]);
    return result;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function transcribeAudio(buf: Buffer, mime: string): Promise<string | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const base64 = buf.toString("base64");
  const safeMime = mime || "audio/ogg";
  const primaryUrl = (process.env.TRANSCRIBE_PRIMARY_URL || "").trim();

  // Primary path: only attempted when an env URL is configured.
  if (primaryUrl) {
    const t0 = Date.now();
    const { text, timedOut } = await withTimeout(
      intakeTranscribeAudio(base64, safeMime, { openaiKey: key, baseUrl: primaryUrl }),
      PRIMARY_TIMEOUT_MS
    );
    const elapsed = Date.now() - t0;
    const trimmed = (text || "").trim();
    if (trimmed && !timedOut) {
      console.info(JSON.stringify({
        kind: "transcribe",
        path: "primary",
        elapsed_ms: elapsed,
        ok: true,
      }));
      return trimmed;
    }
    console.info(JSON.stringify({
      kind: "transcribe",
      path: "primary",
      elapsed_ms: elapsed,
      ok: false,
      reason: timedOut ? "timeout" : "empty_or_error",
    }));
    // fall through to OpenAI fallback
  }

  // Fallback (also the default when no primary URL is set): hosted OpenAI.
  const t1 = Date.now();
  const out = await intakeTranscribeAudio(base64, safeMime, { openaiKey: key });
  const elapsedF = Date.now() - t1;
  const trimmedF = (out || "").trim();
  console.info(JSON.stringify({
    kind: "transcribe",
    path: primaryUrl ? "fallback" : "openai",
    elapsed_ms: elapsedF,
    ok: !!trimmedF,
  }));
  return trimmedF || null;
}
