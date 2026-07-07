import { NextRequest, NextResponse } from "next/server";
import { listMemory, forgetMemory } from "@/lib/concierge/brain";

export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json({ items: await listMemory() });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    await forgetMemory(id);
    import("@/lib/zanii").then(({ recordAction }) => recordAction("memory.forget", { id, via: "portal" })).catch(() => {});
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
