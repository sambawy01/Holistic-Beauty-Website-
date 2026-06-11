import { NextRequest, NextResponse } from "next/server";
import {
  isAuthorizedAdminRequest,
  unauthorizedResponse,
} from "@/lib/admin/auth";
import {
  validateProductInput,
  type ProductInput,
} from "@/lib/admin/catalog-input";
import {
  getCatalog,
  saveCatalog,
  generateSlug,
  type Product,
} from "@/lib/catalog";

export const runtime = "nodejs";

/**
 * /api/admin/catalog — Victoria's product manager.
 *
 * GET  → the FULL catalog (internal fields included: quantity, manual
 *        soldOut flag, active, timestamps).
 * POST → create a product. The slug is auto-generated from the EN name
 *        (kebab-case, unique) and immutable afterwards.
 *
 * Auth: Basic (ADMIN_USER/ADMIN_PASS) or the legacy admin key — enforced by
 * the proxy AND re-checked here (defense in depth).
 *
 * The first successful save lazily persists the SEED catalog to the blob.
 */

export async function GET(request: NextRequest) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedResponse();

  try {
    const products = await getCatalog();
    return NextResponse.json({ products });
  } catch (error) {
    console.error("[admin/catalog] Read failed:", error);
    return NextResponse.json(
      { error: "Couldn't load the catalog. Please try again." },
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

  const result = validateProductInput(body, "create");
  if (!result.ok) {
    return NextResponse.json(
      { error: "Validation failed", fields: result.fields },
      { status: 400 }
    );
  }
  const input = result.value as Required<
    Pick<ProductInput, "en" | "ru" | "priceEgp" | "priceRub">
  > &
    ProductInput;

  try {
    const catalog = await getCatalog();
    const slug = generateSlug(input.en.name, new Set(catalog.map((p) => p.slug)));
    const now = new Date().toISOString();
    const product: Product = {
      slug,
      en: input.en,
      ru: input.ru,
      priceEgp: input.priceEgp,
      priceRub: input.priceRub,
      photo: input.photo ?? "",
      alt: input.alt ?? { en: "", ru: "" },
      ...(input.usage !== undefined ? { usage: input.usage } : {}),
      quantity: input.quantity !== undefined ? input.quantity : null,
      soldOut: input.soldOut ?? false,
      active: input.active ?? true,
      createdAt: now,
      updatedAt: now,
    };
    catalog.push(product);
    await saveCatalog(catalog);
    return NextResponse.json({ product }, { status: 201 });
  } catch (error) {
    console.error("[admin/catalog] Create failed:", error);
    return NextResponse.json(
      { error: "Couldn't save the product. Please try again." },
      { status: 500 }
    );
  }
}
