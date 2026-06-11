import { NextRequest, NextResponse } from "next/server";
import {
  isAuthorizedAdminRequest,
  unauthorizedResponse,
} from "@/lib/admin/auth";
import {
  applyProductInput,
  validateProductInput,
} from "@/lib/admin/catalog-input";
import { getCatalog, saveCatalog } from "@/lib/catalog";

export const runtime = "nodejs";

/**
 * /api/admin/catalog/<slug> — update or delete one product.
 *
 * PUT    → partial update (any of: en, ru, priceEgp, priceRub, photo, alt,
 *          quantity, soldOut, active). The slug itself is immutable.
 * DELETE → remove the product from the catalog. Past orders are unaffected —
 *          they carry their own copies of names and totals.
 *
 * Auth: Basic or legacy admin key (proxy + per-route, defense in depth).
 */

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedResponse();

  const { slug } = await params;
  if (!slug || !SLUG_RE.test(slug)) {
    return NextResponse.json({ error: "Invalid slug" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const result = validateProductInput(body, "update");
  if (!result.ok) {
    return NextResponse.json(
      { error: "Validation failed", fields: result.fields },
      { status: 400 }
    );
  }

  try {
    const catalog = await getCatalog();
    const index = catalog.findIndex((p) => p.slug === slug);
    if (index === -1) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }
    const product = applyProductInput(catalog[index], result.value);
    catalog[index] = product;
    await saveCatalog(catalog);
    return NextResponse.json({ product });
  } catch (error) {
    console.error(`[admin/catalog] Update failed (${slug}):`, error);
    return NextResponse.json(
      { error: "Couldn't save the product. Please try again." },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedResponse();

  const { slug } = await params;
  if (!slug || !SLUG_RE.test(slug)) {
    return NextResponse.json({ error: "Invalid slug" }, { status: 400 });
  }

  try {
    const catalog = await getCatalog();
    const remaining = catalog.filter((p) => p.slug !== slug);
    if (remaining.length === catalog.length) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }
    await saveCatalog(remaining);
    return NextResponse.json({ ok: true, slug });
  } catch (error) {
    console.error(`[admin/catalog] Delete failed (${slug}):`, error);
    return NextResponse.json(
      { error: "Couldn't delete the product. Please try again." },
      { status: 500 }
    );
  }
}
