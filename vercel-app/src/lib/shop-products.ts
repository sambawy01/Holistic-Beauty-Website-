/**
 * Server-side shop catalog — single source of truth for COD orders.
 *
 * The static shop page renders its own copy of this data, but all totals
 * are computed HERE on the server from these prices. Client-supplied
 * prices/totals are never trusted.
 *
 * Prices are placeholder data in EGP and RUB (integer units, no cents).
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
    slug: "hydrating-serum",
    nameEn: "Hydrating Serum — Onmacabim 30ml",
    nameRu: "Увлажняющая сыворотка",
    priceEgp: 1450,
    priceRub: 2000,
  },
  {
    slug: "fruit-peel-mask",
    nameEn: "Fruit Peel Mask — HOLY LAND 50ml",
    nameRu: "Фруктовая маска-пилинг",
    priceEgp: 980,
    priceRub: 1400,
  },
  {
    slug: "alginate-mask-kit",
    nameEn: "Alginate Modeling Mask home kit",
    nameRu: "Альгинатная маска (набор)",
    priceEgp: 750,
    priceRub: 1050,
  },
  {
    slug: "mineral-spf50",
    nameEn: "Mineral Sunscreen SPF 50",
    nameRu: "Минеральный SPF 50",
    priceEgp: 890,
    priceRub: 1250,
  },
  {
    slug: "mandelic-toner",
    nameEn: "Mandelic Renewal Toner 100ml",
    nameRu: "Миндальный тоник",
    priceEgp: 820,
    priceRub: 1150,
  },
  {
    slug: "collagen-patches",
    nameEn: "Collagen Eye Patches 60pcs",
    nameRu: "Коллагеновые патчи",
    priceEgp: 640,
    priceRub: 900,
  },
  {
    slug: "sculpting-tool",
    nameEn: "Facial Sculpting Tool gua sha",
    nameRu: "Скульптурирующий гуаша",
    priceEgp: 560,
    priceRub: 800,
  },
  {
    slug: "night-cream",
    nameEn: "Recovery Night Cream 50ml",
    nameRu: "Восстанавливающий ночной крем",
    priceEgp: 1120,
    priceRub: 1600,
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
