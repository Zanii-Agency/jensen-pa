import { NextRequest, NextResponse } from "next/server";
import { MAIL_COOKIE, decryptCreds } from "@/lib/mailbox";
import { sendMail, OutAttachment } from "@/lib/mail-ops";
import { sendUnified, unpackId, IMAP_ACCOUNT } from "@/lib/mail-provider";

export const runtime = "nodejs";
export const maxDuration = 45;

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({} as any));
  if (!b.to || !b.subject) return NextResponse.json({ error: "Recipient and subject required." }, { status: 400 });

  if (b.id) {
    const { accountId } = unpackId(String(b.id));
    // IMAP item: send via the cookie creds.
    if (accountId === IMAP_ACCOUNT) {
      const creds = await decryptCreds(req.cookies.get(MAIL_COOKIE)?.value);
      if (!creds) return NextResponse.json({ error: "No mailbox connected." }, { status: 401 });
      try {
        const r = await sendMail(creds, { to: b.to, subject: b.subject, text: b.text || "", inReplyTo: b.inReplyTo });
        if (!r.ok) return NextResponse.json({ error: r.error }, { status: 502 });
        import("@/lib/zanii").then(({ recordAction }) => recordAction("email.send", { to: b.to, subject: b.subject, channel: "imap", ok: true, via: "portal" })).catch(() => {});
        return NextResponse.json({ ok: true });
      } catch (e: any) {
        return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
      }
    }
    // OAuth (Microsoft / Zoho) item.
    try {
      await sendUnified(accountId, b.to, b.subject, b.text || "");
      import("@/lib/zanii").then(({ recordAction }) => recordAction("email.send", { to: b.to, subject: b.subject, channel: "oauth", ok: true, via: "portal" })).catch(() => {});
      return NextResponse.json({ ok: true });
    } catch (e: any) {
      return NextResponse.json({ error: e?.message || String(e) }, { status: 502 });
    }
  }

  // Legacy IMAP path (the standalone /mail composer).
  const creds = await decryptCreds(req.cookies.get(MAIL_COOKIE)?.value);
  if (!creds) return NextResponse.json({ error: "No mailbox connected." }, { status: 401 });
  try {
    const attachments: OutAttachment[] = Array.isArray(b.attachments) ? b.attachments : [];
    const r = await sendMail(creds, { to: b.to, subject: b.subject, text: b.text || "", inReplyTo: b.inReplyTo, attachments });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 502 });
    import("@/lib/zanii").then(({ recordAction }) => recordAction("email.send", { to: b.to, subject: b.subject, channel: "imap-legacy", attachments: attachments.length, ok: true, via: "portal" })).catch(() => {});
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
