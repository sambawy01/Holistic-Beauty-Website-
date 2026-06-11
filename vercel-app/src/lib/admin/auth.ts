import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

/**
 * Admin authentication — two accepted credentials, checked in order:
 *
 * 1. HTTP Basic Auth against ADMIN_USER / ADMIN_PASS. This is the primary
 *    scheme: /admin answers 401 + `WWW-Authenticate: Basic` so the browser
 *    shows its native login prompt and remembers the credentials.
 * 2. LEGACY: the static admin token (env ADMIN_TOKEN) via the `x-admin-key`
 *    header or the `?key=` query param. Booking-request emails already in
 *    inboxes contain /admin?key=<token> links — those must keep working, so
 *    a valid key bypasses Basic entirely.
 *
 * All comparisons are constant-time. Unset env vars fail closed: with no
 * ADMIN_USER/ADMIN_PASS and no ADMIN_TOKEN, nothing authenticates.
 */

/** Constant-time string equality (length leak only, like HMAC verifiers). */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Burn a comparison anyway so the early return doesn't shortcut timing.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Server-only check of the legacy owner admin token (env ADMIN_TOKEN).
 * Returns false when the env var is unset.
 */
export function isValidAdminKey(key: string | null | undefined): boolean {
  const token = process.env.ADMIN_TOKEN;
  if (!token || !key) return false;
  return safeEqual(key, token);
}

/**
 * Validate an `Authorization: Basic …` header against ADMIN_USER/ADMIN_PASS.
 * Returns false when either env var is unset.
 */
export function isValidBasicAuth(header: string | null | undefined): boolean {
  const user = process.env.ADMIN_USER;
  const pass = process.env.ADMIN_PASS;
  if (!user || !pass || !header) return false;

  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header.trim());
  if (!match) return false;

  let decoded: string;
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return false;
  }
  const sep = decoded.indexOf(":");
  if (sep < 0) return false;

  // Evaluate both halves unconditionally — no early exit on a bad username.
  const userOk = safeEqual(decoded.slice(0, sep), user);
  const passOk = safeEqual(decoded.slice(sep + 1), pass);
  return userOk && passOk;
}

/**
 * Combined request-level check used by the proxy and every /api/admin/*
 * route: Basic auth OR legacy key (header or ?key= query param).
 */
export function isAuthorizedAdminRequest(request: Request): boolean {
  if (isValidBasicAuth(request.headers.get("authorization"))) return true;
  if (isValidAdminKey(request.headers.get("x-admin-key"))) return true;
  try {
    const key = new URL(request.url).searchParams.get("key");
    if (isValidAdminKey(key)) return true;
  } catch {
    // Unparseable URL — fall through to unauthorized.
  }
  return false;
}

/**
 * 401 challenge response. The WWW-Authenticate header is what makes the
 * browser pop its native username/password prompt on /admin.
 */
export function unauthorizedResponse(): NextResponse {
  return NextResponse.json(
    { error: "Authentication required" },
    {
      status: 401,
      headers: {
        "WWW-Authenticate": 'Basic realm="Victoria Admin", charset="UTF-8"',
      },
    }
  );
}
