import { NextRequest, NextResponse } from "next/server";
import {
  isAuthorizedAdminRequest,
  unauthorizedResponse,
} from "@/lib/admin/auth";
import { renderLetterheadPdf } from "@/lib/assistant/letterhead-pdf";
import {
  buildPnL,
  pnlFilename,
  pnlToLetterheadBody,
  resolvePeriodFromParams,
} from "@/lib/finance-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/finance/pdf?period=...|?month=...
 * → the P&L rendered on the company letterhead (same renderer as Vassili's
 *   documents — embedded Cyrillic-capable fonts). Admin-only.
 */
export async function GET(request: NextRequest) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedResponse();

  const resolved = resolvePeriodFromParams(request.nextUrl.searchParams);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: 400 });
  }

  try {
    const pnl = await buildPnL(resolved.period);
    const { pdf } = await renderLetterheadPdf({
      title: `Profit & Loss — ${pnl.period.label}`,
      body: pnlToLetterheadBody(pnl),
    });
    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${pnlFilename(pnl)}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("[admin/finance/pdf] Failed:", error);
    return NextResponse.json(
      { error: "Couldn't build the P&L PDF. Please try again." },
      { status: 500 }
    );
  }
}
