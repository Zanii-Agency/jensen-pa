import { NextRequest, NextResponse } from "next/server";
import { addEmailEvent } from "@/lib/calendar-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST { messageId, title, date(YYYY-MM-DD), time?, note? } -> add to /calendar.
// Confirmed by Jensen from the mail modal; idempotent by messageId.
export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const messageId = String(b.messageId || "");
    const title = String(b.title || "").trim();
    const date = String(b.date || "").trim();
    if (!messageId || !title || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ ok: false, error: "messageId, title and a valid date are required." }, { status: 400 });
    }
    const time = typeof b.time === "string" && /^\d{1,2}:\d{2}$/.test(b.time) ? b.time : null;
    const note = b.note ? String(b.note).slice(0, 300) : null;
    // Carry the meeting link onto the event so the T-5 reminder can hand it back (KT #342).
    const meetingUrl = typeof b.meetingUrl === "string" && /^https?:\/\//i.test(b.meetingUrl) ? b.meetingUrl.slice(0, 500) : null;
    const r = await addEmailEvent(messageId, { title, date, time, note, meetingUrl });
    import("@/lib/zanii").then(({ recordAction }) => recordAction("calendar.add", { messageId, title, date, via: "portal" })).catch(() => {});
    return NextResponse.json({ ok: true, ...r });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
