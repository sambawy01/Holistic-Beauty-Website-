import { NextRequest, NextResponse } from "next/server";
import {
  isAuthorizedAdminRequest,
  unauthorizedResponse,
} from "@/lib/admin/auth";
import { listClientProfiles, toClientSummary } from "@/lib/crm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/clients — the client directory (list view).
 *
 * Returns LIGHT summaries (name, last/next visit, counts, spend, tags) — full
 * history + notes live behind GET /api/admin/clients/<id>. Optional ?search=
 * (name / email / phone) and ?tag= filters.
 *
 * Admin-only PII: NO public route. Auth re-checked here (defense in depth on
 * top of the proxy). Never reachable by the website concierge.
 */
export async function GET(request: NextRequest) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedResponse();

  const params = request.nextUrl.searchParams;
  const search = params.get("search") ?? undefined;
  const tag = params.get("tag") ?? undefined;

  try {
    const profiles = await listClientProfiles({ search, tag });
    return NextResponse.json({ clients: profiles.map(toClientSummary) });
  } catch (error) {
    console.error("[admin/clients] List failed:", error);
    return NextResponse.json(
      { error: "Couldn't load clients. Please try again." },
      { status: 500 }
    );
  }
}
