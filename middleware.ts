import { NextRequest, NextResponse } from "next/server";
import { COOKIE, verifyToken } from "@/lib/auth";

// External webhooks have their own auth (HMAC / verify-token / agent secret) and
// must always reach their handlers, even during maintenance. /api/whatsapp has
// the JENSEN_MODE allowlist gate inside route.ts.
// /api/actions is the ChatGPT connector: bearer-gated in its own handler (a cookie
// session can never satisfy a bearer client), so it must bypass the cookie/maintenance wall.
// /api/peer is the cross-bot task bridge (ADR-0015): HMAC-gated in its own handler
// and default-OFF, so it bypasses the cookie/maintenance wall like the other webhooks.
const EXTERNAL = ["/api/whatsapp", "/api/cron", "/api/shopify/webhook", "/api/ingest", "/api/digital-u", "/api/mute", "/api/actions", "/api/peer"];

// The session-login flow's own routes — public for the auth gate, but during
// maintenance they are also walled (don't let anyone log in while we are dark).
const AUTH_PUBLIC = ["/login", "/api/auth"];

function isStatic(pathname: string): boolean {
  return (
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico" ||
    pathname === "/manifest.webmanifest" ||
    /\.(svg|png|jpg|jpeg|webp|ico)$/.test(pathname)
  );
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (EXTERNAL.some((p) => pathname.startsWith(p)) || isStatic(pathname)) {
    return NextResponse.next();
  }

  // MAINTENANCE GATE. While MAINTENANCE_MODE=1, only requests carrying the
  // maintenance_admin cookie may pass; everyone else lands on /maintenance.
  // A one-shot URL grant (?admin=<token>) sets the cookie so the operator can
  // unlock from a phone without DevTools. The WhatsApp bot has its own
  // allowlist gate in app/api/whatsapp/route.ts.
  // Pattern cloned from nisria-techops platform/middleware.ts (Sasa 727 sweep).
  if (process.env.MAINTENANCE_MODE === "1") {
    const grant = req.nextUrl.searchParams.get("admin");
    if (grant && grant === process.env.MAINTENANCE_ADMIN_TOKEN) {
      const url = req.nextUrl.clone();
      url.searchParams.delete("admin");
      const res = NextResponse.redirect(url);
      res.cookies.set("maintenance_admin", grant, {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
      });
      return res;
    }
    const adminToken = req.cookies.get("maintenance_admin")?.value;
    const isAdmin = adminToken && adminToken === process.env.MAINTENANCE_ADMIN_TOKEN;
    if (!isAdmin) {
      if (pathname === "/maintenance") return NextResponse.next();
      const url = req.nextUrl.clone();
      url.pathname = "/maintenance";
      return NextResponse.redirect(url);
    }
  }

  if (AUTH_PUBLIC.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }
  const ok = await verifyToken(req.cookies.get(COOKIE)?.value);
  if (!ok) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|webp|ico)).*)"],
};
