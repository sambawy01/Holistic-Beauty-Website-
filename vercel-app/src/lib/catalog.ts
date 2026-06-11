import { get, put } from "@vercel/blob";
import { SHOP_PRODUCTS } from "./shop-products";

/**
 * Dynamic shop catalog on Vercel Blob (private store `vv-orders`).
 *
 * Layout: ONE JSON document at `catalog/products.json` holding the full
 * product array. The shop is tiny (a handful of products), so a single
 * read-modify-write document is simpler and safer than per-product blobs.
 *
 * Lifecycle:
 * - When the blob does not exist yet, `getCatalog()` returns SEED — the
 *   six launch products from @/lib/shop-products (names/prices) merged with
 *   the marketing copy/photos that previously lived only in /shop.js. The
 *   blob is written lazily on the first admin save (or the first order
 *   decrement), so a fresh deployment works with zero setup.
 * - `effectiveSoldOut(p)` is the single sold-out rule: manual flag OR a
 *   tracked quantity that reached 0. `quantity: null` means "not tracked".
 * - Orders decrement quantities via read-modify-write. At this shop's
 *   volume (a few orders a day) racing writers are tolerable by design.
 */

export interface ProductCopy {
  name: string;
  sub: string;
  desc: string;
}

export interface Product {
  slug: string;
  en: ProductCopy;
  ru: ProductCopy;
  priceEgp: number;
  priceRub: number;
  /** Absolute URL (blob upload) or site-relative path ("assets/img/…"). */
  photo: string;
  alt: { en: string; ru: string };
  /** null = stock not tracked; 0 = auto sold-out. */
  quantity: number | null;
  /** Manual sold-out flag, independent of quantity. */
  soldOut: boolean;
  /** Hidden products stay in the catalog but never reach the public API. */
  active: boolean;
  /**
   * Manufacturer usage/application directions (optional, editable in /admin).
   * Surfaced to the AI concierge and the public API so clients can be told
   * how to use what they bought — "according to the manufacturer".
   */
  usage?: { en: string; ru: string };
  createdAt: string;
  updatedAt: string;
}

/** Shape served by the public GET /api/products — no internal fields. */
export interface PublicProduct {
  slug: string;
  name: { en: string; ru: string };
  sub: { en: string; ru: string };
  desc: { en: string; ru: string };
  priceEgp: number;
  priceRub: number;
  photo: string;
  alt: { en: string; ru: string };
  soldOut: boolean;
  /** Manufacturer usage directions, when Victoria has provided them. */
  usage?: { en: string; ru: string };
}

export const CATALOG_PATHNAME = "catalog/products.json";

// --- Seed --------------------------------------------------------------------

const SEED_TIMESTAMP = "2026-06-11T00:00:00.000Z";
const SEED_QUANTITY = 20;

/**
 * Marketing copy / photos for the six launch products, keyed by the slugs in
 * @/lib/shop-products (the SEED source of truth for slugs/names/prices).
 * This text previously lived only in the static site's /shop.js.
 */
const SEED_COPY: Record<
  string,
  { sub: { en: string; ru: string }; desc: { en: string; ru: string }; photo: string; alt: { en: string; ru: string } }
> = {
  "tohar-hamidbar-concentrate": {
    sub: { en: "DM line · 150 ml", ru: "линия DM · 150 мл" },
    desc: {
      en: "Highly concentrated herbal formula for oily, porous and blemish-prone skin. Plant extracts and acids cleanse and tighten pores, mattify, and calm the skin with a strong antioxidant effect.",
      ru: "Высококонцентрированное растительное средство для жирной, пористой и проблемной кожи. Экстракты растений и кислоты очищают и сужают поры, матируют и успокаивают кожу, обладая мощным антиоксидантным действием.",
    },
    photo: "assets/img/shop/tohar-hamidbar-concentrate.jpg",
    alt: {
      en: "Onmacabim DM Tohar Hamidbar No.2 — white pump bottle with a green leaf motif",
      ru: "Onmacabim DM Tohar Hamidbar №2 — белый флакон с помпой и зелёным листом",
    },
  },
  "nd-neck-decollete-cream": {
    sub: { en: "Vivant line · 50 ml", ru: "линия Vivant · 50 мл" },
    desc: {
      en: "A complex care cream for the delicate neck and décolleté zone combining natural and biotechnological components. Enzymes and lipopeptides support cell renewal and collagen synthesis for a natural firming effect.",
      ru: "Комплексный крем для деликатной зоны шеи и декольте, сочетающий природные и биотехнологичные компоненты. Энзимы и липопептиды поддерживают обновление клеток и синтез коллагена, создавая естественный эффект лифтинга.",
    },
    photo: "assets/img/shop/nd-neck-decollete-cream.jpg",
    alt: {
      en: "Onmacabim Vivant N.D Cream — white jar beside its olive-green box",
      ru: "Onmacabim Vivant N.D Cream — белая банка рядом с оливковой коробкой",
    },
  },
  "vitamin-c-mask": {
    sub: { en: "VC line · 50 ml", ru: "линия VC · 50 мл" },
    desc: {
      en: "Rich, antioxidant-packed nourishing mask with a brightening effect. Helps reduce hyperpigmentation and supports collagen production — well suited to dehydrated skin with signs of photoaging.",
      ru: "Насыщенная питательная маска с антиоксидантами и осветляющим эффектом. Помогает уменьшить гиперпигментацию и поддерживает выработку коллагена — подходит обезвоженной коже с признаками фотостарения.",
    },
    photo: "assets/img/shop/vitamin-c-mask.jpg",
    alt: {
      en: "Onmacabim Nourishing Skin Mask Vitamin C — white tube beside its box",
      ru: "Onmacabim питательная маска с витамином C — белая туба рядом с коробкой",
    },
  },
  "vitality-spf15-moisturizer": {
    sub: { en: "Oxygen line · 50 ml", ru: "линия Oxygen · 50 мл" },
    desc: {
      en: "A light, quickly absorbed cream-fluid with a delicate fresh scent. Restores the skin's natural moisture balance, improves elasticity and complexion, and protects against UV with SPF 15.",
      ru: "Лёгкий, быстро впитывающийся крем-флюид с нежным свежим ароматом. Восстанавливает естественный баланс влаги, повышает упругость, улучшает цвет лица и защищает от ультрафиолета с SPF 15.",
    },
    photo: "assets/img/shop/vitality-spf15-moisturizer.jpg",
    alt: {
      en: "Onmacabim Oxygen Vitality Moisturizing Lotion SPF 15 — white pump bottle beside its box",
      ru: "Onmacabim Oxygen Vitality увлажняющий лосьон SPF 15 — белый флакон с помпой рядом с коробкой",
    },
  },
  "nomela-serum": {
    sub: { en: "Luna whitening series · 50 ml", ru: "осветляющая серия Luna · 50 мл" },
    desc: {
      en: "A delicate brightening serum that balances skin tone and helps prevent new pigmentation. Moisturizing polysaccharides and lightening extracts reduce melanin synthesis. For all skin types, year-round.",
      ru: "Деликатная осветляющая сыворотка выравнивает тон кожи и помогает предотвратить появление новой пигментации. Увлажняющие полисахариды и осветляющие экстракты снижают синтез меланина. Для всех типов кожи, круглый год.",
    },
    photo: "assets/img/shop/nomela-serum.jpg",
    alt: {
      en: "Onmacabim Luna NoMela facial serum — white dropper bottle with a gold collar beside its box",
      ru: "Onmacabim Luna NoMela сыворотка для лица — белый флакон с пипеткой и золотым ободком рядом с коробкой",
    },
  },
  "moisturizer-normal-dry": {
    sub: { en: "ST Cells line · 50 ml", ru: "линия ST Cells · 50 мл" },
    desc: {
      en: "A stem-cell moisturizer that supports collagen production and hyaluronic acid renewal. Skin looks smoother, firmer and more rested, with better resistance to outside stressors.",
      ru: "Увлажняющий крем с фитостволовыми клетками поддерживает выработку коллагена и обновление гиалуроновой кислоты. Кожа выглядит более гладкой, упругой и отдохнувшей, лучше противостоит внешним воздействиям.",
    },
    photo: "assets/img/shop/moisturizer-normal-dry.jpg",
    alt: {
      en: "Onmacabim ST Cells moisturizer for normal to dry skin — white pump bottle beside its box",
      ru: "Onmacabim ST Cells увлажняющий крем для нормальной и сухой кожи — белый флакон с помпой рядом с коробкой",
    },
  },
};

/**
 * Manufacturer "Application method" directions, condensed faithfully from
 * the Onmacabim product pages on onmacabim-prof.com/en/product/* (the same
 * origin as the seed catalog). No invented claims — wording stays within
 * what the manufacturer publishes; RU is a natural translation.
 */
const SEED_USAGE: Record<string, { en: string; ru: string }> = {
  "tohar-hamidbar-concentrate": {
    en: "Can be used year-round. In the evening, apply to cleansed face and do not rinse off. During periods of active sun exposure, sunscreen with at least SPF 15 is required. On problem skin a temporary tingling, itching, burning or redness is possible on application — per the manufacturer these reactions pass on their own.",
    ru: "Можно использовать круглый год. Вечером нанесите на очищенную кожу лица и не смывайте. В период активного солнца обязательно пользуйтесь солнцезащитным средством с SPF не ниже 15. На проблемной коже при нанесении возможны временное покалывание, зуд, жжение или покраснение — по данным производителя, эти реакции проходят самостоятельно.",
  },
  "nd-neck-decollete-cream": {
    en: "Apply to the cleansed skin of the neck and décolleté with light massaging movements until fully absorbed, for intensive moisturizing and nourishment.",
    ru: "Наносите на очищенную кожу шеи и декольте лёгкими массирующими движениями до полного впитывания — для интенсивного увлажнения и питания.",
  },
  "vitamin-c-mask": {
    en: "Apply a thin layer onto cleansed skin and rinse off after 15–20 minutes. Use 2–3 times a week.",
    ru: "Нанесите тонким слоем на очищенную кожу и смойте через 15–20 минут. Используйте 2–3 раза в неделю.",
  },
  "vitality-spf15-moisturizer": {
    en: "Apply in the morning to clean skin of the face and neck, spreading with light massaging movements. Ideally suited as a makeup base; the manufacturer also recommends it for use as a serum.",
    ru: "Утром нанесите на чистую кожу лица и шеи, распределяя лёгкими массирующими движениями. Идеально подходит как база под макияж; производитель также рекомендует использовать его как сыворотку.",
  },
  "nomela-serum": {
    en: "Apply morning and evening to thoroughly cleansed skin, before your cream. During the day, use a sunscreen with at least SPF 30. Suitable for daily use, all skin types, with no seasonal limitations.",
    ru: "Наносите утром и вечером на тщательно очищенную кожу перед кремом. Днём используйте солнцезащитное средство с SPF не ниже 30. Подходит для ежедневного применения, для всех типов кожи, без сезонных ограничений.",
  },
  "moisturizer-normal-dry": {
    en: "In the morning, after cleansing and toning, apply over the face, neck and décolleté area.",
    ru: "Утром, после очищения и тонизирования, нанесите на лицо, шею и зону декольте.",
  },
};

/** Short names for the catalog (without the line/size suffix that lives in `sub`). */
const SEED_SHORT_NAMES: Record<string, { en: string; ru: string }> = {
  "tohar-hamidbar-concentrate": { en: "Tohar Hamidbar No.2 Herbal Concentrate", ru: "Травяной концентрат Tohar Hamidbar №2" },
  "nd-neck-decollete-cream": { en: "N.D Cream for Neck & Décolleté", ru: "Крем для шеи и декольте N.D" },
  "vitamin-c-mask": { en: "Nourishing Skin Mask Vitamin C", ru: "Питательная маска с витамином C" },
  "vitality-spf15-moisturizer": { en: "Vitality Moisturizer SPF 15", ru: "Увлажняющий крем Vitality SPF 15" },
  "nomela-serum": { en: "NoMela Facial Serum", ru: "Сыворотка для лица NoMela" },
  "moisturizer-normal-dry": { en: "Moisturizer for Normal to Dry Skin", ru: "Увлажняющий крем для нормальной и сухой кожи" },
};

export const SEED: readonly Product[] = SHOP_PRODUCTS.map((p) => {
  const copy = SEED_COPY[p.slug];
  const names = SEED_SHORT_NAMES[p.slug];
  return {
    slug: p.slug,
    en: {
      name: names?.en ?? p.nameEn,
      sub: copy?.sub.en ?? "",
      desc: copy?.desc.en ?? "",
    },
    ru: {
      name: names?.ru ?? p.nameRu,
      sub: copy?.sub.ru ?? "",
      desc: copy?.desc.ru ?? "",
    },
    priceEgp: p.priceEgp,
    priceRub: p.priceRub,
    photo: copy?.photo ?? "",
    alt: copy?.alt ?? { en: "", ru: "" },
    ...(SEED_USAGE[p.slug] ? { usage: SEED_USAGE[p.slug] } : {}),
    quantity: SEED_QUANTITY,
    soldOut: false,
    active: true,
    createdAt: SEED_TIMESTAMP,
    updatedAt: SEED_TIMESTAMP,
  };
});

function cloneSeed(): Product[] {
  return SEED.map((p) => ({
    ...p,
    en: { ...p.en },
    ru: { ...p.ru },
    alt: { ...p.alt },
    ...(p.usage ? { usage: { ...p.usage } } : {}),
  }));
}

// --- Sold-out rule ------------------------------------------------------------

/** The single source of truth: manual flag OR tracked stock at zero. */
export function effectiveSoldOut(p: Product): boolean {
  return p.soldOut || p.quantity === 0;
}

export function toPublicProduct(p: Product): PublicProduct {
  return {
    slug: p.slug,
    name: { en: p.en.name, ru: p.ru.name },
    sub: { en: p.en.sub, ru: p.ru.sub },
    desc: { en: p.en.desc, ru: p.ru.desc },
    priceEgp: p.priceEgp,
    priceRub: p.priceRub,
    photo: p.photo,
    alt: { ...p.alt },
    soldOut: effectiveSoldOut(p),
    ...(p.usage && (p.usage.en || p.usage.ru)
      ? { usage: { ...p.usage } }
      : {}),
  };
}

// --- Persistence ----------------------------------------------------------------

/**
 * Read the full catalog. A missing blob (fresh store) falls back to SEED;
 * any other failure throws so callers can decide how to degrade — a transient
 * read error must never be mistaken for "empty store" by a writer, or a
 * subsequent save would clobber the real catalog with seed data.
 */
export async function getCatalog(): Promise<Product[]> {
  const result = await get(CATALOG_PATHNAME, {
    access: "private",
    useCache: false,
  });
  // The SDK returns null for a missing blob (fresh store) and throws on
  // transport/auth errors — those propagate to the caller.
  if (!result) return cloneSeed();
  const data = (await new Response(result.stream).json()) as unknown;
  if (!Array.isArray(data)) {
    throw new Error("Catalog blob is corrupt (not an array)");
  }
  return data as Product[];
}

/** Overwrite the catalog document (also performs the lazy first write of SEED edits). */
export async function saveCatalog(products: Product[]): Promise<void> {
  await put(CATALOG_PATHNAME, JSON.stringify(products, null, 2), {
    access: "private",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

/**
 * Decrement tracked stock after a successful order (read-modify-write).
 * Quantities floor at 0 — which makes the product auto sold-out for all
 * subsequent catalog fetches. Untracked products (quantity: null) and
 * unknown slugs are skipped. Races at this volume are acceptable.
 */
export async function decrementQuantities(
  items: { slug: string; qty: number }[]
): Promise<void> {
  const catalog = await getCatalog();
  const now = new Date().toISOString();
  let changed = false;
  for (const { slug, qty } of items) {
    const product = catalog.find((p) => p.slug === slug);
    if (product && typeof product.quantity === "number") {
      product.quantity = Math.max(0, product.quantity - qty);
      product.updatedAt = now;
      changed = true;
    }
  }
  if (changed) await saveCatalog(catalog);
}

/**
 * Restore tracked stock when an order is cancelled (read-modify-write).
 * The mirror of `decrementQuantities`: quantities are added back only for
 * items that still exist in the catalog AND still track stock — deleted
 * products and untracked (`quantity: null`) ones are skipped. Races at this
 * volume are acceptable.
 */
export async function restoreQuantities(
  items: { slug: string; qty: number }[]
): Promise<void> {
  const catalog = await getCatalog();
  const now = new Date().toISOString();
  let changed = false;
  for (const { slug, qty } of items) {
    const product = catalog.find((p) => p.slug === slug);
    if (product && typeof product.quantity === "number") {
      product.quantity = product.quantity + qty;
      product.updatedAt = now;
      changed = true;
    }
  }
  if (changed) await saveCatalog(catalog);
}

// --- Slugs -----------------------------------------------------------------------

/**
 * Kebab-case slug from the EN name, made unique against the existing catalog
 * by appending -2, -3, … Slugs are immutable after creation (they live in
 * carts, orders and bookmarks).
 */
export function generateSlug(nameEn: string, existing: Set<string>): string {
  const base =
    nameEn
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/, "") || "product";
  if (!existing.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!existing.has(candidate)) return candidate;
  }
}

// --- Price formatting (kept in the catalog module so the order path no longer
// imports @/lib/shop-products, which is now only the SEED source) -----------------

/** "3540" -> "E£3,540". */
export function formatEgp(amount: number): string {
  return `E£${amount.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

/** "4900" -> "4 900 ₽". */
export function formatRub(amount: number): string {
  return `${amount.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ")} ₽`;
}
