import { NextRequest, NextResponse } from "next/server";
import {
  isAuthorizedAdminRequest,
  unauthorizedResponse,
} from "@/lib/admin/auth";
import { rebookingRadar } from "@/lib/crm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/clients/rebooking?weeks=6 — clients overdue for a check-in
 * (a past confirmed visit older than N weeks AND no upcoming booking), most
 * overdue first, each with a suggested branded check-in DRAFT.
 *
 * Admin-only PII; auth re-checked.
 */
export async function GET(request: NextRequest) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedResponse();

  const weeksRaw = Number(request.nextUrl.searchParams.get("weeks"));
  const weeks =
    Number.isFinite(weeksRaw) && weeksRaw > 0 && weeksRaw <= 104
      ? Math.floor(weeksRaw)
      : 6;

  try {
    const clients = await rebookingRadar({ weeks });
    return NextResponse.json({ weeks, clients });
  } catch (error) {
    console.error("[admin/clients] Rebooking radar failed:", error);
    return NextResponse.json(
      { error: "Couldn't load the re-booking radar. Please try again." },
      { status: 500 }
    );
  }
}
