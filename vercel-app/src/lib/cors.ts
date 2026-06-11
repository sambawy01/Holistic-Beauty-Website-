/**
 * Shared CORS allowlist for public API routes called from the static site.
 * Extracted from /api/chat so /api/order (and future routes) stay in sync.
 */

const ALLOWED_ORIGINS = new Set([
  "https://victoriaholisticbeauty.com",
  "https://www.victoriaholisticbeauty.com",
  "https://sambawy01.github.io", // legacy URL, redirects to the domain
]);
const LOCAL_ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return true; // same-origin / curl without Origin header
  return ALLOWED_ORIGINS.has(origin) || LOCAL_ORIGIN_RE.test(origin);
}

export function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin || !isAllowedOrigin(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}
