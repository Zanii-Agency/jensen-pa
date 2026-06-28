// Connector bearer auth (Phase 4). Pure + testable. Fail-closed: an unset or empty
// token denies everything (never allow-all). Timing-safe constant-length compare.
import crypto from "node:crypto";

export function bearerOk(authHeader: string | null, token: string | undefined): boolean {
  if (!token) return false; // unset secret -> deny all, never open
  const got = String(authHeader || "").replace(/^Bearer\s+/i, "").trim();
  if (!got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
