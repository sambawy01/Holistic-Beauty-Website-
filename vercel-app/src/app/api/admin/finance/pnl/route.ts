import { NextRequest, NextResponse } from "next/server";
import {
  isAuthorizedAdminRequest,
  unauthorizedResponse,
} from "@/lib/admin/auth";
import { buildPnL, resolvePeriodFromParams } from "@/lib/finance-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/finance/pnl?period=week|month|custom (+ from/to) | ?month=
 * → the structured P&L JSON (revenue split shop/treatments/manual, expenses
 *   by category, net). Admin-only.
 */
export async function GET(request: NextRequest) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedResponse();

  const resolved = resolvePeriodFromParams(request.nextUrl.searchParams);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: 400 });
  }

  try {
    const pnl = await buildPnL(resolved.period);
    return NextResponse.json({ pnl });
  } catch (error) {
    console.error("[admin/finance/pnl] Build failed:", error);
    return NextResponse.json(
      { error: "Couldn't build the P&L. Please try again." },
      { status: 500 }
    );
  }
}
