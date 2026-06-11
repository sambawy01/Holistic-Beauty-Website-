/**
 * SEED-ONLY shop catalog.
 *
 * Orders are now validated against the DYNAMIC catalog in @/lib/catalog
 * (Vercel Blob `catalog/products.json`, editable from /admin). This file
 * remains solely as the seed source: when the catalog blob does not exist
 * yet, @/lib/catalog builds its SEED from these six products.
 *
 * Do NOT import this module from the order path — use @/lib/catalog.
 *
 * Prices are in EGP and RUB (integer units, no cents). Two products carry
 * prices converted from onmacabim-prof.com USD list prices (rates of
 * 2026-06-11, EGP rounded to nearest 50, RUB to nearest 100); the other
 * four had no listed price and keep placeholder values pending the
 * owner's confirmation.
 *
 * Slugs and prices MUST stay identical to the PRODUCTS array in /shop.js
 * (static site) — drift breaks order submission.
 */

export interface ShopProduct {
  slug: string;
  nameEn: string;
  nameRu: string;
  priceEgp: number;
  priceRub: number;
}

export const SHOP_PRODUCTS: readonly ShopProduct[] = [
  {
    slug: "tohar-hamidbar-concentrate",
    nameEn: "Tohar Hamidbar No.2 Herbal Concentrate — DM line 150ml",
    nameRu: "Травяной концентрат Tohar Hamidbar №2 (линия DM, 150 мл)",
    priceEgp: 1450,
    priceRub: 2000,
  },
  {
    slug: "nd-neck-decollete-cream",
    nameEn: "N.D Cream for Neck & Décolleté — Vivant line 50ml",
    nameRu: "Крем для шеи и декольте N.D (линия Vivant, 50 мл)",
    priceEgp: 1250,
    priceRub: 1750,
  },
  {
    slug: "vitamin-c-mask",
    nameEn: "Nourishing Skin Mask Vitamin C — VC line 50ml",
    nameRu: "Питательная маска с витамином C (линия VC, 50 мл)",
    priceEgp: 2300,
    priceRub: 3200,
  },
  {
    slug: "vitality-spf15-moisturizer",
    nameEn: "Vitality Moisturizer SPF 15 — Oxygen line 50ml",
    nameRu: "Увлажняющий крем Vitality SPF 15 (линия Oxygen, 50 мл)",
    priceEgp: 1150,
    priceRub: 1600,
  },
  {
    slug: "nomela-serum",
    nameEn: "NoMela Facial Serum — Luna whitening series 50ml",
    nameRu: "Сыворотка для лица NoMela (серия Luna, 50 мл)",
    priceEgp: 1350,
    priceRub: 1900,
  },
  {
    slug: "moisturizer-normal-dry",
    nameEn: "Moisturizer for Normal to Dry Skin — ST Cells line 50ml",
    nameRu: "Увлажняющий крем для нормальной и сухой кожи (линия ST Cells, 50 мл)",
    priceEgp: 4850,
    priceRub: 6700,
  },
] as const;

export const PRODUCTS_BY_SLUG: ReadonlyMap<string, ShopProduct> = new Map(
  SHOP_PRODUCTS.map((p) => [p.slug, p])
);

/** "3540" -> "3,540" (EGP style). */
export function formatEgp(amount: number): string {
  return `E£${amount.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

/** "4900" -> "4 900 ₽" (RUB style, space-grouped). */
export function formatRub(amount: number): string {
  return `${amount.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ")} ₽`;
}
