import { NextRequest } from "next/server";
import { runConcierge } from "@/lib/concierge/loop";
import { senderFromToken } from "@/lib/accounts";
import { COOKIE } from "@/lib/auth";

export const runtime = "nodejs";
export const maxDuration = 120;

// SSE stream for the portal chat. Returns progress events (ack -> thinking ->
// tools -> done) so the chat UI shows immediate feedback instead of a blank
// wait, then the full reply at the end. The client reads event.data for each
// phase and renders the final reply progressively as text chunks arrive.
export async function POST(req: NextRequest) {
  try {
    const { messages } = await req.json();
    if (!Array.isArray(messages) || messages.length === 0) {
      return new Response("messages required", { status: 400 });
    }
    const sender = await senderFromToken(req.cookies.get(COOKIE)?.value).catch(() => undefined);

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: string, data: string) => {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
        };
        send("ack", "");

        // Each portal request is its own inbound. Without an id no held action can be
        // confirmed from the portal, and a proposal made here could only be answered
        // on WhatsApp.
        const { reply, toolsUsed } = await runConcierge({ messages, channel: "portal", sender, inboundId: `portal:${crypto.randomUUID()}` });

        send("done", JSON.stringify({ reply, toolsUsed }));
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  } catch (e: any) {
    return new Response(`event: error\ndata: ${JSON.stringify({ message: e?.message || String(e) })}\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    });
  }
}
