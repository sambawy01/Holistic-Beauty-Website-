import { NextRequest, NextResponse } from "next/server";
import {
  isAuthorizedAdminRequest,
  unauthorizedResponse,
} from "@/lib/admin/auth";
import { validateLedgerInput } from "@/lib/admin/finance-input";
import { addLedgerEntry, type NewLedgerEntry } from "@/lib/finance";
import { buildPnL, resolvePeriodFromParams } from "@/lib/finance-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /api/admin/finance — Victoria's private finance ledger.
 *
 * GET  → the P&L for a period (default: current month). The response carries
 *        BOTH the summary numbers AND the in-range manual entries, so the
 *        admin Finance tab renders cards + table from one fetch. Period via
 *        ?month=YYYY-MM or ?period=week|month|custom (+ ?from/&to).
 * POST → add a manual ledger entry (expense / off-platform income).
 *
 * Admin-only (no public route — finance is private). Auth: Basic or legacy
 * key, enforced by the proxy AND re-checked here (defense in depth).
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
    console.error("[admin/finance] P&L build failed:", error);
    return NextResponse.json(
      { error: "Couldn't load the finance data. Please try again." },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedResponse();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const result = validateLedgerInput(body, "create");
  if (!result.ok) {
    return NextResponse.json(
      { error: "Validation failed", fields: result.fields },
      { status: 400 }
    );
  }

  try {
    const entry = await addLedgerEntry(result.value as NewLedgerEntry);
    return NextResponse.json({ entry }, { status: 201 });
  } catch (error) {
    console.error("[admin/finance] Create failed:", error);
    return NextResponse.json(
      { error: "Couldn't save the entry. Please try again." },
      { status: 500 }
    );
  }
}
