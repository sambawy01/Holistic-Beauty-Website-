import { NextRequest, NextResponse } from "next/server";
import { corsHeaders, isAllowedOrigin } from "@/lib/cors";
import { getCatalog, toPublicProduct, SEED, type Product } from "@/lib/catalog";

export const runtime = "nodejs";

/**
 * GET /api/products — the public catalog consumed by the static shop page.
 *
 * - Same CORS allowlist as /api/chat and /api/order.
 * - Only ACTIVE products, in their public shape (computed `soldOut`,
 *   no quantity / manual flags / timestamps — stock numbers are private).
 * - Short CDN cache (~60s + SWR): sold-out flips propagate within a minute,
 *   while the static shop never hammers the blob store.
 * - A blob read failure degrades to the SEED catalog rather than a 5xx —
 *   the shop staying rentable beats strict freshness here.
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

  let catalog: Product[];
  try {
    catalog = await getCatalog();
  } catch (error) {
    console.error("[products] Catalog read failed — serving seed:", error);
    catalog = [...SEED];
  }

  const products = catalog.filter((p) => p.active).map(toPublicProduct);

  return NextResponse.json(
    { products },
    {
      headers: {
        ...corsHeaders(origin, "GET, OPTIONS"),
        "Cache-Control": CACHE_CONTROL,
      },
    }
  );
}
