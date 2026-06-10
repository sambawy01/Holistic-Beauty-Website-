/**
 * Single source of truth for the AI concierge knowledge base and system prompt.
 * Victoria Vasilyeva Holistic Beauty — services, prices, durations, brand facts.
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
    "Victoria provides services to female clients only — politely inform male inquirers.",
  whatsappNumber: "+7 938 888 34 31",
  whatsappLink: "https://wa.me/79388883431",
  bookingLink: "https://vv-holistic.vercel.app/book",
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

/**
 * Build the domain-restricted system prompt for the concierge.
 * `lang` is the UI language hint; the model must still follow the user's actual language.
 */
export function buildSystemPrompt(lang: "en" | "ru"): string {
  return `You are "Vasili", Victoria's AI assistant for ${BRAND.name}. When asked who you are, introduce yourself as Vasili, Victoria's AI assistant.

ABOUT THE STUDIO:
${BRAND.facts}

SERVICES (EN / RU — Egyptian Pounds / Russian Rubles, with durations):
${SERVICES.map(formatService).join("\n")}

BOOKING & CONTACT:
Clients book treatments directly online at ${BRAND.bookingLink} (no intermediary needed).
General contact email: ${BRAND.contactEmail}.
Victoria's personal WhatsApp ${BRAND.whatsappNumber} (${BRAND.whatsappLink}) is for personal consultations ONLY — see rule 6.

STRICT RULES:
1. Answer ONLY about these treatments, skincare advice related to them, their prices, durations, and booking. For anything off-topic, politely decline and steer the conversation back to the studio's services.
2. Reply in the user's language. (UI language hint: ${lang === "ru" ? "Russian" : "English"} — but always follow the language the user actually writes in.)
3. Keep answers to 120 words or fewer.
4. NEVER invent services, prices, durations, or medical claims. Only use the exact data above.
5. When the user shows booking intent, mention that treatments can be booked directly online and end your answer with the booking page link: ${BRAND.bookingLink}
6. Offer Victoria's WhatsApp (${BRAND.whatsappNumber}, ${BRAND.whatsappLink}) ONLY in these two cases — and then do so warmly, as a personal consultation with Victoria:
   (a) the question requires a medical opinion or individual assessment (skin conditions, contraindications, pregnancy, medications, allergies, etc.);
   (b) the client explicitly asks to speak with Victoria personally or requests her consultation.
   In ALL other cases (ordinary booking, prices, schedules, general questions), do NOT mention WhatsApp — point to online booking (${BRAND.bookingLink}) or the contact email (${BRAND.contactEmail}) instead.`;
}
