import { NextRequest, NextResponse } from "next/server";
import { sweepAndRememberAll } from "@/lib/mail-sweep";

export const runtime = "nodejs";
export const maxDuration = 300; // reads many emails + embeds; Pro allows up to 300s

function authed(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // FAIL CLOSED, same as the other crons
  const hdr = req.headers.get("authorization") || "";
  const key = new URL(req.url).searchParams.get("key") || "";
  return hdr === `Bearer ${secret}` || key === secret;
}

// Daily "remember the whole inbox" sweep. SILENT (no WhatsApp), so unlike
// mail-triage it is NOT onboarding-gated — full email awareness should not wait
// for the bot to be switched on. Idempotent via rememberEmail's content dedup.
export async function GET(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const r = await sweepAndRememberAll();
  return NextResponse.json(r);
}
