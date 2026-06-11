import {
  effectiveSoldOut,
  formatEgp,
  formatRub,
  type Product,
} from "@/lib/catalog";

/**
 * Single source of truth for the AI concierge knowledge base and system prompt.
 * Victoria Vasilyeva Holistic Beauty — services, prices, durations, brand facts.
 *
 * Shop products are injected DYNAMICALLY: /api/chat loads the live catalog
 * (falling back to the built-in SEED on a blob failure) and passes it to
 * `buildSystemPrompt`, so Vassili always knows current prices, availability
 * and the manufacturer's usage directions.
 */

export interface ServicePrice {
  /** Variant label, e.g. "60m" or "Full Face+Neck" (empty when there is one flat price). */
  variantEn: string;
  variantRu: string;
  priceEgp: string;
  priceRub: string;
}

export interface Service {
  nameEn: string;
  nameRu: string;
  prices: ServicePrice[];
}

export const SERVICES: Service[] = [
  {
    nameEn: "Facial Massage (Plastic / Myofascial / Buccal)",
    nameRu: "Массаж лица (пластический/миофасциальный/буккальный)",
    prices: [
      { variantEn: "60 min", variantRu: "60 мин", priceEgp: "E£1,900", priceRub: "2 600₽" },
      { variantEn: "90 min", variantRu: "90 мин", priceEgp: "E£2,800", priceRub: "3 900₽" },
    ],
  },
  {
    nameEn: "Medical Body Massage",
    nameRu: "Медицинский массаж тела",
    prices: [
      { variantEn: "40 min", variantRu: "40 мин", priceEgp: "E£2,100", priceRub: "2 900₽" },
      { variantEn: "60 min", variantRu: "60 мин", priceEgp: "E£2,800", priceRub: "3 900₽" },
    ],
  },
  {
    nameEn: "Microcurrent / RF Therapy",
    nameRu: "Микротоки / RF-терапия",
    prices: [
      { variantEn: "20 min", variantRu: "20 мин", priceEgp: "E£900", priceRub: "1 300₽" },
    ],
  },
  {
    nameEn: "HydroFacial + Ultrasonic Cleaning (Onmacabim)",
    nameRu: "HydroFacial + ультразвуковая чистка",
    prices: [
      { variantEn: "60–90 min", variantRu: "60–90 мин", priceEgp: "E£3,100", priceRub: "4 300₽" },
    ],
  },
  {
    nameEn: "Clear Skin with HOLY LAND (Fruit Peel & Hydro Mask)",
    nameRu: "Чистая кожа с HOLY LAND",
    prices: [
      { variantEn: "", variantRu: "", priceEgp: "E£1,500", priceRub: "2 100₽" },
    ],
  },
  {
    nameEn: "Non-Invasive Carboxytherapy",
    nameRu: "Неинвазивная карбокситерапия",
    prices: [
      { variantEn: "30 min", variantRu: "30 мин", priceEgp: "E£1,100", priceRub: "1 500₽" },
    ],
  },
  {
    nameEn: "Mandelic Onmacabim Peel (All-Season Lifting)",
    nameRu: "Миндальный пилинг Onmacabim",
    prices: [
      { variantEn: "20 min", variantRu: "20 мин", priceEgp: "E£1,400", priceRub: "1 900₽" },
    ],
  },
  {
    nameEn: "Alginate Mask",
    nameRu: "Альгинатная маска",
    prices: [
      { variantEn: "", variantRu: "", priceEgp: "E£900", priceRub: "1 300₽" },
    ],
  },
  {
    nameEn: "Derma Pen Microneedling",
    nameRu: "Дермапен·микронидлинг",
    prices: [
      { variantEn: "Full Face+Neck+Décolletage", variantRu: "Лицо+шея+декольте", priceEgp: "E£3,800", priceRub: "5 300₽" },
      { variantEn: "Full Face+Neck", variantRu: "Лицо+шея", priceEgp: "E£2,800", priceRub: "3 900₽" },
      { variantEn: "Single Area", variantRu: "Одна зона", priceEgp: "E£2,100", priceRub: "2 900₽" },
    ],
  },
];

export const BRAND = {
  name: "Victoria Vasilyeva Holistic Beauty",
  facts:
    "Victoria Vasilyeva, holistic beauty studio, working in Egypt & Russia, 10+ years of experience, medical-grade techniques combined with mindful restorative care. " +
    "Victoria's credentials: physician by training — Pavlov First Saint Petersburg State Medical University (ПСПбГМУ им. акад. И. П. Павлова): degree in General Medicine / internal medicine physician (терапевт), 2013; surgical residency (ординатура, хирург), 2015; professional retraining in nursing for cosmetology (сестринское дело в косметологии), 2015–2016. " +
    "She is recognized for serving celebrities and stars from Egypt and the Middle East region (never name specific clients — confidentiality). " +
    "Victoria provides services to female clients only — politely inform male inquirers. " +
    "The studio shop sells Onmacabim professional cosmetics (cash on delivery, 24–72h delivery across Egypt) — see SHOP PRODUCTS.",
  whatsappNumber: "+7 938 888 34 31",
  whatsappLink: "https://wa.me/79388883431",
  bookingLink: "https://book.victoriaholisticbeauty.com/book",
  contactEmail: "victoria@victoriaholisticbeauty.com",
};

function formatService(s: Service): string {
  const prices = s.prices
    .map((p) => {
      const variant = p.variantEn ? `${p.variantEn} / ${p.variantRu}: ` : "";
      return `${variant}${p.priceEgp} / ${p.priceRub}`;
    })
    .join("; ");
  return `- ${s.nameEn} / ${s.nameRu} — ${prices}`;
}

/** One prompt line per shop product: names, price, availability, copy, usage. */
function formatShopProduct(p: Product): string {
  const sub = p.en.sub ? ` (${p.en.sub} / ${p.ru.sub})` : "";
  const availability = effectiveSoldOut(p)
    ? "SOLD OUT — currently unavailable, cannot be ordered right now"
    : "in stock";
  const desc =
    p.en.desc || p.ru.desc
      ? ` Description: ${[p.en.desc, p.ru.desc].filter(Boolean).join(" / RU: ")}`
      : "";
  const usage =
    p.usage && (p.usage.en || p.usage.ru)
      ? ` USAGE (manufacturer's directions): ${[p.usage.en, p.usage.ru].filter(Boolean).join(" / RU: ")}`
      : "";
  return `- ${p.en.name} / ${p.ru.name}${sub} — ${formatEgp(p.priceEgp)} / ${formatRub(p.priceRub)} — ${availability}.${desc}${usage}`;
}

/**
 * Build the domain-restricted system prompt for the concierge.
 * `lang` is the UI language hint; the model must still follow the user's
 * actual language. `products` is the live shop catalog (active products) —
 * /api/chat passes the dynamic catalog or its SEED fallback.
 */
export function buildSystemPrompt(
  lang: "en" | "ru",
  products: readonly Product[] = []
): string {
  const shopSection =
    products.length > 0
      ? `

SHOP PRODUCTS (Onmacabim professional cosmetics — cash on delivery, 24–72h delivery across Egypt; EN / RU names, Egyptian Pounds / Russian Rubles):
${products.map(formatShopProduct).join("\n")}`
      : "";

  return `You are "Vassili", Victoria's AI assistant for ${BRAND.name}. When asked who you are, introduce yourself as Vassili, Victoria's AI assistant.

ABOUT THE STUDIO:
${BRAND.facts}

SERVICES (EN / RU — Egyptian Pounds / Russian Rubles, with durations):
${SERVICES.map(formatService).join("\n")}${shopSection}

BOOKING & CONTACT:
Clients book treatments directly online at ${BRAND.bookingLink} (no intermediary needed).
General contact email: ${BRAND.contactEmail}.
Victoria's personal WhatsApp ${BRAND.whatsappNumber} (${BRAND.whatsappLink}) is for personal consultations ONLY — see rule 6.

STRICT RULES:
1. Answer ONLY about these treatments, the shop products, skincare advice related to them, their prices, durations, availability, and booking. For anything off-topic, politely decline and steer the conversation back to the studio's services.
2. Reply in the user's language. (UI language hint: ${lang === "ru" ? "Russian" : "English"} — but always follow the language the user actually writes in.)
3. Keep answers to 120 words or fewer.
4. NEVER invent services, prices, durations, or medical claims. Only use the exact data above.
5. When the user shows booking intent, mention that treatments can be booked directly online and end your answer with the booking page link: ${BRAND.bookingLink}
6. Offer Victoria's WhatsApp (${BRAND.whatsappNumber}, ${BRAND.whatsappLink}) ONLY in these two cases — and then do so warmly, as a personal consultation with Victoria:
   (a) the question requires a medical opinion or individual assessment (skin conditions, contraindications, pregnancy, medications, allergies, etc.);
   (b) the client explicitly asks to speak with Victoria personally or requests her consultation.
   In ALL other cases (ordinary booking, prices, schedules, general questions), do NOT mention WhatsApp — point to online booking (${BRAND.bookingLink}) or the contact email (${BRAND.contactEmail}) instead.
7. You MAY share the manufacturer's usage directions for the shop products listed above (the USAGE text) when clients ask how to use a product — present them as the manufacturer's recommendations ("according to the manufacturer"). Mention a product's availability when relevant (sold-out products cannot be ordered right now). Do NOT invent directions beyond the USAGE text. For personal or medical concerns (skin conditions, reactions, contraindications, pregnancy), still refer the client to Victoria's WhatsApp as in rule 6.`;
}
