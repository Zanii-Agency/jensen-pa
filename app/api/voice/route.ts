import { NextRequest, NextResponse } from "next/server";
import { claudeJSON, NO_DASHES } from "@/lib/anthropic";
import { transcribeAudio as intakeTranscribeAudio } from "@/lib/intake/index.js";

export const runtime = "nodejs";
export const maxDuration = 90;

// Audio (base64) -> @zanii/intake transcript -> Claude summary + tasks.
// Powers voice notes, the end-of-day debrief, and meeting notes.
export async function POST(req: NextRequest) {
  try {
    const { audioBase64, mime, filename } = await req.json();
    if (!audioBase64) return NextResponse.json({ error: "audio required" }, { status: 400 });
    const key = process.env.OPENAI_API_KEY;
    if (!key) return NextResponse.json({ error: "OPENAI_API_KEY not set" }, { status: 500 });

    const transcript = (await intakeTranscribeAudio(audioBase64, mime || "audio/webm", { openaiKey: key })).trim();
    if (!transcript) return NextResponse.json({ transcript: "", summary: "", tasks: [] });
    // filename is kept for backwards compatibility with the notes UI client but
    // intake derives its own filename from the mime; no behaviour change.
    void filename;

    const extracted = await claudeJSON<{ summary: string; tasks: string[] }>(
      `You turn a spoken note or meeting transcript into a tight summary and a list of concrete action items for Jensen, an F&B consultant. ${NO_DASHES}`,
      `Transcript:\n${transcript}\n\nReturn JSON: { "summary": "2 to 4 sentence summary", "tasks": ["actionable item", ...] }`,
      900,
    );
    return NextResponse.json({ transcript, summary: extracted?.summary || "", tasks: extracted?.tasks || [] });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
