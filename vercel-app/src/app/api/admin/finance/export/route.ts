import { NextRequest, NextResponse } from "next/server";
import {
  isAuthorizedAdminRequest,
  unauthorizedResponse,
} from "@/lib/admin/auth";
import {
  buildPnL,
  pnlFilename,
  pnlToCsv,
  resolvePeriodFromParams,
} from "@/lib/finance-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/finance/export?period=...|?month=...
 * → a CSV (text/csv, attachment) of the ledger entries in range plus a P&L
 *   summary block. Admin-only.
 */
export async function GET(request: NextRequest) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedResponse();

  const resolved = resolvePeriodFromParams(request.nextUrl.searchParams);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: 400 });
  }

  try {
    const pnl = await buildPnL(resolved.period);
    const csv = pnlToCsv(pnl);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${pnlFilename(pnl)}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("[admin/finance/export] Failed:", error);
    return NextResponse.json(
      { error: "Couldn't build the export. Please try again." },
      { status: 500 }
    );
  }
}
