import { NextRequest, NextResponse } from "next/server";
import { corsHeaders, isAllowedOrigin } from "@/lib/cors";
import {
  getTreatmentsCatalog,
  toPublicTreatment,
  SEED,
  type Treatment,
} from "@/lib/treatments";

export const runtime = "nodejs";

/**
 * GET /api/treatments — the public treatments catalog consumed by the static
 * site (index.html / ru.html) and the /book service picker.
 *
 * - Same CORS allowlist as /api/products and /api/chat.
 * - Only ACTIVE treatments, in their public shape (no timestamps).
 * - Short CDN cache (~60s + SWR): price edits propagate within a minute
 *   without the static site hammering the blob store.
 * - A blob read failure degrades to the SEED catalog rather than a 5xx —
 *   the treatments menu staying rentable beats strict freshness here.
 */

const CACHE_CONTROL = "public, max-age=0, s-maxage=60, stale-while-revalidate=300";

export async function OPTIONS(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!isAllowedOrigin(origin)) {
    return new NextResponse(null, { status: 403 });
  }
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(origin, "GET, OPTIONS"),
  });
}

export async function GET(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!isAllowedOrigin(origin)) {
    return NextResponse.json({ error: "Origin not allowed" }, { status: 403 });
  }

  let catalog: Treatment[];
  try {
    catalog = await getTreatmentsCatalog();
  } catch (error) {
    console.error("[treatments] Catalog read failed — serving seed:", error);
    catalog = [...SEED];
  }

  const treatments = catalog.filter((t) => t.active).map(toPublicTreatment);

  return NextResponse.json(
    { treatments },
    {
      headers: {
        ...corsHeaders(origin, "GET, OPTIONS"),
        "Cache-Control": CACHE_CONTROL,
      },
    }
  );
}
