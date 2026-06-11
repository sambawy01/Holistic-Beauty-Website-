/**
 * Service catalogue for Victoria Vasilyeva Holistic Beauty.
 * eventTypeId values are the real Cal.com (api.cal.eu) event types created by
 * scripts/create-event-types.mjs — every one requires Victoria's confirmation.
 */

export interface Service {
  slug: string;
  eventTypeId: number;
  en: { title: string };
  ru: { title: string };
  /** Available durations in minutes (ascending). Bookings default to the longest. */
  durations: number[];
  priceLine: { en: string; ru: string };
  /** Numeric price at the LONGEST duration — used to sum combined sessions. */
  price: { egp: number; rub: number };
}

export const SERVICES: Service[] = [
  {
    slug: "facial-massage",
    eventTypeId: 327658,
    en: { title: "Facial Massage" },
    ru: { title: "Массаж лица" },
    durations: [60, 90],
    priceLine: {
      en: "E£1,900–2,800 · 2 600–3 900 ₽",
      ru: "E£1,900–2,800 · 2 600–3 900 ₽",
    },
    price: { egp: 2800, rub: 3900 },
  },
  {
    slug: "body-massage",
    eventTypeId: 327662,
    en: { title: "Medical Body Massage" },
    ru: { title: "Медицинский массаж тела" },
    durations: [40, 60],
    priceLine: {
      en: "E£2,100–2,800 · 2 900–3 900 ₽",
      ru: "E£2,100–2,800 · 2 900–3 900 ₽",
    },
    price: { egp: 2800, rub: 3900 },
  },
  {
    slug: "microcurrent-rf",
    eventTypeId: 327663,
    en: { title: "Microcurrent / RF Therapy" },
    ru: { title: "Микротоки · RF-терапия" },
    durations: [20],
    priceLine: { en: "E£900 · 1 300 ₽", ru: "E£900 · 1 300 ₽" },
    price: { egp: 900, rub: 1300 },
  },
  {
    slug: "hydrofacial",
    eventTypeId: 327664,
    en: { title: "HydroFacial + Ultrasonic Cleaning" },
    ru: { title: "HydroFacial + ультразвуковая чистка" },
    durations: [60, 90],
    priceLine: { en: "E£3,100 · 4 300 ₽", ru: "E£3,100 · 4 300 ₽" },
    price: { egp: 3100, rub: 4300 },
  },
  {
    slug: "clear-skin-holy-land",
    eventTypeId: 327665,
    en: { title: "Clear Skin with HOLY LAND" },
    ru: { title: "Чистая кожа с HOLY LAND" },
    durations: [60],
    priceLine: { en: "E£1,500 · 2 100 ₽", ru: "E£1,500 · 2 100 ₽" },
    price: { egp: 1500, rub: 2100 },
  },
  {
    slug: "carboxytherapy",
    eventTypeId: 327666,
    en: { title: "Non-Invasive Carboxytherapy" },
    ru: { title: "Неинвазивная карбокситерапия" },
    durations: [30],
    priceLine: { en: "E£1,100 · 1 500 ₽", ru: "E£1,100 · 1 500 ₽" },
    price: { egp: 1100, rub: 1500 },
  },
  {
    slug: "mandelic-peel",
    eventTypeId: 327667,
    en: { title: "Mandelic Onmacabim Peel" },
    ru: { title: "Миндальный пилинг Onmacabim" },
    durations: [20],
    priceLine: { en: "E£1,400 · 1 900 ₽", ru: "E£1,400 · 1 900 ₽" },
    price: { egp: 1400, rub: 1900 },
  },
  {
    slug: "alginate-mask",
    eventTypeId: 327668,
    en: { title: "Alginate Mask" },
    ru: { title: "Альгинатная маска" },
    durations: [30],
    priceLine: { en: "E£900 · 1 300 ₽", ru: "E£900 · 1 300 ₽" },
    price: { egp: 900, rub: 1300 },
  },
  {
    slug: "dermapen-face-neck-decollete",
    eventTypeId: 327669,
    en: { title: "Derma Pen — Full Face + Neck + Décolletage" },
    ru: { title: "Дермапен — лицо + шея + декольте" },
    durations: [90],
    priceLine: { en: "E£3,800 · 5 300 ₽", ru: "E£3,800 · 5 300 ₽" },
    price: { egp: 3800, rub: 5300 },
  },
  {
    slug: "dermapen-face-neck",
    eventTypeId: 327670,
    en: { title: "Derma Pen — Full Face + Neck" },
    ru: { title: "Дермапен — лицо + шея" },
    durations: [60],
    priceLine: { en: "E£2,800 · 3 900 ₽", ru: "E£2,800 · 3 900 ₽" },
    price: { egp: 2800, rub: 3900 },
  },
  {
    slug: "dermapen-single-area",
    eventTypeId: 327671,
    en: { title: "Derma Pen — Single Area" },
    ru: { title: "Дермапен — одна зона" },
    durations: [30],
    priceLine: { en: "E£2,100 · 2 900 ₽", ru: "E£2,100 · 2 900 ₽" },
    price: { egp: 2100, rub: 2900 },
  },
];

export function getServiceBySlug(slug: string | undefined): Service | undefined {
  if (!slug) return undefined;
  return SERVICES.find((s) => s.slug === slug);
}

/**
 * Multi-treatment sessions are booked on a single shared Cal.com event type
 * created by scripts/create-combined-session.mjs. Its lengthInMinutesOptions
 * cover every achievable sum of 2–4 treatments (longest duration per service,
 * capped at 240 min) plus all single-service durations.
 */
export const COMBINED_SESSION = {
  slug: "combined-session",
  eventTypeId: 327902,
} as const;

/** Verified against Cal (GET /event-types/327902 → lengthInMinutesOptions). */
export const COMBINED_DURATION_OPTIONS: readonly number[] = [
  20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180,
  190, 200, 210, 220, 230, 240,
];

export const MAX_COMBINED_MINUTES = 240;

/** Longest duration of a service — combined sessions always use this. */
export function longestDuration(service: Service): number {
  return Math.max(...service.durations);
}
