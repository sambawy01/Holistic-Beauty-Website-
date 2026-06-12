import { get, put } from "@vercel/blob";

/**
 * Dynamic treatments catalog on Vercel Blob (private store `vv-orders`),
 * mirroring the shop catalog in @/lib/catalog.
 *
 * Layout: ONE JSON document at `catalog/treatments.json` holding the full
 * treatment array (11 services — a single read-modify-write document).
 *
 * Lifecycle:
 * - When the blob does not exist yet, `getTreatmentsCatalog()` returns SEED —
 *   the 11 live treatments exactly as rendered on the static site and /book
 *   today, each linked to its real Cal.com (api.cal.eu) event type. The blob
 *   is written lazily on the first admin save, so a fresh deployment works
 *   with zero setup.
 * - A treatment's PRICE lives only here — Cal.com event types carry no price
 *   today and that stays the case. Name/duration changes are best-effort
 *   synced to the linked Cal event type by the admin routes.
 * - Deactivating (active: false) hides the treatment from the public API and
 *   best-effort hides the Cal event type (hidden: true).
 *
 * NOTE on single duration/price: services with a duration range on the site
 * (e.g. Facial Massage 60/90) are seeded at their LONGEST duration and that
 * duration's price — the same canonical price `@/lib/services` uses for
 * combined-session sums. The static pages keep their richer server-rendered
 * multi-duration price rows as long as the catalog entry still matches SEED.
 */

export interface Treatment {
  slug: string;
  /** Linked Cal.com event type (api.cal.eu). 0 = no linked event type. */
  eventTypeId: number;
  name: { en: string; ru: string };
  description: { en: string; ru: string };
  durationMinutes: number;
  priceEgp: number;
  priceRub: number;
  /** Deactivated treatments stay in the catalog but never reach the public API. */
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Shape served by the public GET /api/treatments — no internal timestamps. */
export interface PublicTreatment {
  slug: string;
  eventTypeId: number;
  name: { en: string; ru: string };
  description: { en: string; ru: string };
  durationMinutes: number;
  priceEgp: number;
  priceRub: number;
}

export const TREATMENTS_PATHNAME = "catalog/treatments.json";

// --- Seed --------------------------------------------------------------------

const SEED_TIMESTAMP = "2026-06-12T00:00:00.000Z";

/**
 * The 11 live treatments. Verified against:
 * - Cal.com event types (GET api.cal.eu/v2/event-types, 2026-06-12):
 *   ids 327658–327671, slugs/titles/lengths match below.
 * - index.html / ru.html treatment rows (prices already include the +20%).
 * - /book service definitions in @/lib/services (canonical names + the price
 *   at the longest duration).
 * Descriptions are the t-sub lines from the static pages.
 */
export const SEED: readonly Treatment[] = [
  {
    slug: "facial-massage",
    eventTypeId: 327658,
    name: { en: "Facial Massage", ru: "Массаж лица" },
    description: {
      en: "Plastic / Myofascial / Buccal",
      ru: "пластический / миофасциальный / буккальный",
    },
    durationMinutes: 90,
    priceEgp: 3350,
    priceRub: 4700,
    active: true,
    createdAt: SEED_TIMESTAMP,
    updatedAt: SEED_TIMESTAMP,
  },
  {
    slug: "body-massage",
    eventTypeId: 327662,
    name: { en: "Medical Body Massage", ru: "Медицинский массаж тела" },
    description: { en: "", ru: "" },
    durationMinutes: 60,
    priceEgp: 3350,
    priceRub: 4700,
    active: true,
    createdAt: SEED_TIMESTAMP,
    updatedAt: SEED_TIMESTAMP,
  },
  {
    slug: "microcurrent-rf",
    eventTypeId: 327663,
    name: { en: "Microcurrent / RF Therapy", ru: "Микротоки · RF-терапия" },
    description: { en: "", ru: "" },
    durationMinutes: 20,
    priceEgp: 1100,
    priceRub: 1600,
    active: true,
    createdAt: SEED_TIMESTAMP,
    updatedAt: SEED_TIMESTAMP,
  },
  {
    slug: "hydrofacial",
    eventTypeId: 327664,
    name: {
      en: "HydroFacial + Ultrasonic Cleaning",
      ru: "HydroFacial + ультразвуковая чистка",
    },
    description: { en: "Onmacabim", ru: "Onmacabim" },
    durationMinutes: 90,
    priceEgp: 3700,
    priceRub: 5200,
    active: true,
    createdAt: SEED_TIMESTAMP,
    updatedAt: SEED_TIMESTAMP,
  },
  {
    slug: "clear-skin-holy-land",
    eventTypeId: 327665,
    name: { en: "Clear Skin with HOLY LAND", ru: "Чистая кожа с HOLY LAND" },
    description: {
      en: "Fruit Peel & Hydro Mask",
      ru: "фруктовый пилинг и гидромаска",
    },
    durationMinutes: 60,
    priceEgp: 1800,
    priceRub: 2500,
    active: true,
    createdAt: SEED_TIMESTAMP,
    updatedAt: SEED_TIMESTAMP,
  },
  {
    slug: "carboxytherapy",
    eventTypeId: 327666,
    name: {
      en: "Non-Invasive Carboxytherapy",
      ru: "Неинвазивная карбокситерапия",
    },
    description: { en: "", ru: "" },
    durationMinutes: 30,
    priceEgp: 1300,
    priceRub: 1800,
    active: true,
    createdAt: SEED_TIMESTAMP,
    updatedAt: SEED_TIMESTAMP,
  },
  {
    slug: "mandelic-peel",
    eventTypeId: 327667,
    name: { en: "Mandelic Onmacabim Peel", ru: "Миндальный пилинг Onmacabim" },
    description: { en: "All-Season Lifting", ru: "всесезонный лифтинг" },
    durationMinutes: 20,
    priceEgp: 1700,
    priceRub: 2300,
    active: true,
    createdAt: SEED_TIMESTAMP,
    updatedAt: SEED_TIMESTAMP,
  },
  {
    slug: "alginate-mask",
    eventTypeId: 327668,
    name: { en: "Alginate Mask", ru: "Альгинатная маска" },
    description: { en: "", ru: "" },
    durationMinutes: 30,
    priceEgp: 1100,
    priceRub: 1600,
    active: true,
    createdAt: SEED_TIMESTAMP,
    updatedAt: SEED_TIMESTAMP,
  },
  {
    slug: "dermapen-face-neck-decollete",
    eventTypeId: 327669,
    name: {
      en: "Derma Pen — Full Face + Neck + Décolletage",
      ru: "Дермапен — лицо + шея + декольте",
    },
    description: { en: "", ru: "" },
    durationMinutes: 90,
    priceEgp: 4550,
    priceRub: 6400,
    active: true,
    createdAt: SEED_TIMESTAMP,
    updatedAt: SEED_TIMESTAMP,
  },
  {
    slug: "dermapen-face-neck",
    eventTypeId: 327670,
    name: {
      en: "Derma Pen — Full Face + Neck",
      ru: "Дермапен — лицо + шея",
    },
    description: { en: "", ru: "" },
    durationMinutes: 60,
    priceEgp: 3350,
    priceRub: 4700,
    active: true,
    createdAt: SEED_TIMESTAMP,
    updatedAt: SEED_TIMESTAMP,
  },
  {
    slug: "dermapen-single-area",
    eventTypeId: 327671,
    name: { en: "Derma Pen — Single Area", ru: "Дермапен — одна зона" },
    description: { en: "", ru: "" },
    durationMinutes: 30,
    priceEgp: 2500,
    priceRub: 3500,
    active: true,
    createdAt: SEED_TIMESTAMP,
    updatedAt: SEED_TIMESTAMP,
  },
];

function cloneSeed(): Treatment[] {
  return SEED.map((t) => ({
    ...t,
    name: { ...t.name },
    description: { ...t.description },
  }));
}

export function toPublicTreatment(t: Treatment): PublicTreatment {
  return {
    slug: t.slug,
    eventTypeId: t.eventTypeId,
    name: { ...t.name },
    description: { ...t.description },
    durationMinutes: t.durationMinutes,
    priceEgp: t.priceEgp,
    priceRub: t.priceRub,
  };
}

// --- Persistence ----------------------------------------------------------------

/** Structural check for one stored treatment entry. */
function isValidTreatment(value: unknown): value is Treatment {
  const t = value as Treatment | null;
  return (
    typeof t === "object" &&
    t !== null &&
    typeof t.slug === "string" &&
    t.slug.length > 0 &&
    typeof t.eventTypeId === "number" &&
    Number.isFinite(t.eventTypeId) &&
    typeof t.name === "object" &&
    t.name !== null &&
    typeof t.name.en === "string" &&
    t.name.en.length > 0 &&
    typeof t.name.ru === "string" &&
    typeof t.description === "object" &&
    t.description !== null &&
    typeof t.description.en === "string" &&
    typeof t.description.ru === "string" &&
    typeof t.durationMinutes === "number" &&
    Number.isFinite(t.durationMinutes) &&
    typeof t.priceEgp === "number" &&
    Number.isFinite(t.priceEgp) &&
    typeof t.priceRub === "number" &&
    Number.isFinite(t.priceRub) &&
    typeof t.active === "boolean" &&
    typeof t.createdAt === "string" &&
    typeof t.updatedAt === "string"
  );
}

/**
 * Read the full treatments catalog. A missing blob (fresh store) falls back to
 * SEED; any other failure throws so callers can decide how to degrade — a
 * transient read error must never be mistaken for "empty store" by a writer,
 * or a subsequent save would clobber the real catalog with seed data.
 *
 * Per-item shape validation throws on ANY malformed entry (same policy as the
 * not-an-array corrupt check): a garbage-but-array blob must surface as
 * corruption so readers degrade to SEED, not flow through as a valid catalog
 * — /api/treatments would otherwise serve a blanked/garbled menu and the
 * static pages would hide every treatment row.
 */
export async function getTreatmentsCatalog(): Promise<Treatment[]> {
  const result = await get(TREATMENTS_PATHNAME, {
    access: "private",
    useCache: false,
  });
  // The SDK returns null for a missing blob (fresh store) and throws on
  // transport/auth errors — those propagate to the caller.
  if (!result) return cloneSeed();
  const data = (await new Response(result.stream).json()) as unknown;
  if (!Array.isArray(data)) {
    throw new Error("Treatments blob is corrupt (not an array)");
  }
  for (const entry of data) {
    if (!isValidTreatment(entry)) {
      throw new Error(
        `Treatments blob is corrupt (malformed entry: ${JSON.stringify(entry).slice(0, 200)})`
      );
    }
  }
  return data as Treatment[];
}

/** Overwrite the treatments document (also performs the lazy first write of SEED edits). */
export async function saveTreatmentsCatalog(
  treatments: Treatment[]
): Promise<void> {
  await put(TREATMENTS_PATHNAME, JSON.stringify(treatments, null, 2), {
    access: "private",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

// --- Slugs -----------------------------------------------------------------------

/**
 * Kebab-case slug from the EN name, made unique against the existing catalog
 * by appending -2, -3, … Slugs are immutable after creation (they live in
 * booking links, the static pages and Cal event types).
 */
export function generateTreatmentSlug(
  nameEn: string,
  existing: Set<string>
): string {
  const base =
    nameEn
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/, "") || "treatment";
  if (!existing.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!existing.has(candidate)) return candidate;
  }
}
