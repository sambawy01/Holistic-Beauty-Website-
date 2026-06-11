import { NextRequest, NextResponse } from "next/server";
import {
  isAuthorizedAdminRequest,
  unauthorizedResponse,
} from "@/lib/admin/auth";

/**
 * Auth gate for the owner admin surface (page + APIs).
 *
 * Accepts HTTP Basic (ADMIN_USER/ADMIN_PASS) or the legacy ADMIN_TOKEN key
 * (?key= query param / x-admin-key header — old booking emails link to
 * /admin?key=<token> and must keep working). Anything else gets a 401 with
 * a WWW-Authenticate challenge so the browser shows its native login prompt.
 *
 * The routes themselves re-check credentials (defense in depth) — this layer
 * exists so the *page* can answer 401+challenge, which a server component
 * cannot do on its own.
 */
export function proxy(request: NextRequest) {
  if (isAuthorizedAdminRequest(request)) {
    return NextResponse.next();
  }
  return unauthorizedResponse();
}

export const config = {
  matcher: ["/admin", "/api/admin/:path*"],
};
