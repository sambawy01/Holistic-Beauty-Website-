import {
  effectiveSoldOut,
  formatEgp,
  formatRub,
  type Product,
} from "@/lib/catalog";
import { SEED as TREATMENTS_SEED, type Treatment } from "@/lib/treatments";
import { SERVICES } from "@/lib/services";

/**
 * Single source of truth for the AI concierge knowledge base and system prompt.
 * Victoria Vasilyeva Holistic Beauty — services, prices, durations, brand facts.
 *
 * Shop products AND treatments are injected DYNAMICALLY: /api/chat loads the
 * live catalogs (falling back to their built-in SEEDs on a blob failure) and
 * passes them to `buildSystemPrompt`, so Vassili always knows current prices,
 * durations, availability and the manufacturer's usage directions.
 */

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

/**
 * Per-duration price variants for the multi-duration SEED treatments — the
 * SAME options /book offers (its static SERVICES entries keep multi-duration
 * toggles and range price lines; the per-duration prices below are the ones
 * server-rendered on index.html/ru.html, e.g. "£2,300 60m · £3,350 90m").
 * Without these the concierge would quote only the longest duration's price
 * and disagree with /book about e.g. a 60-minute facial massage.
 */
const SEED_VARIANTS: Record<
  string,
  readonly { minutes: number; egp: number; rub: number }[]
> = {
  "facial-massage": [
    { minutes: 60, egp: 2300, rub: 3100 },
    { minutes: 90, egp: 3350, rub: 4700 },
  ],
  "body-massage": [
    { minutes: 40, egp: 2500, rub: 3500 },
    { minutes: 60, egp: 3350, rub: 4700 },
  ],
  hydrofacial: [
    { minutes: 60, egp: 3700, rub: 5200 },
    { minutes: 90, egp: 3700, rub: 5200 },
  ],
};

/**
 * Same match /book's treatmentToService uses: while a catalog treatment is
 * still identical to its static SERVICES entry, /book serves the static
 * multi-duration entry — so the concierge must quote the variants too. Once
 * Victoria edits the treatment, /book collapses it to a single duration and
 * price, and so do we.
 */
function matchesStaticService(t: Treatment): boolean {
  const s = SERVICES.find((x) => x.slug === t.slug);
  return Boolean(
    s &&
      s.eventTypeId === t.eventTypeId &&
      Math.max(...s.durations) === t.durationMinutes &&
      s.price.egp === t.priceEgp &&
      s.price.rub === t.priceRub &&
      s.en.title === t.name.en &&
      s.ru.title === t.name.ru
  );
}

/** One prompt line per treatment: EN/RU names, optional sub-line, duration(s), prices. */
function formatTreatment(t: Treatment): string {
  const desc =
    t.description.en || t.description.ru
      ? ` (${[t.description.en, t.description.ru].filter(Boolean).join(" / ")})`
      : "";
  const variants = SEED_VARIANTS[t.slug];
  const priced =
    variants && matchesStaticService(t)
      ? variants
          .map(
            (v) =>
              `${v.minutes} min — ${formatEgp(v.egp)} / ${formatRub(v.rub)}`
          )
          .join("; ")
      : `${t.durationMinutes} min — ${formatEgp(t.priceEgp)} / ${formatRub(t.priceRub)}`;
  return `- ${t.name.en} / ${t.name.ru}${desc} — ${priced}`;
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
 * actual language. `products` is the live shop catalog (active products) and
 * `treatments` the live treatments catalog — /api/chat passes the dynamic
 * catalogs or their SEED fallbacks.
 */
export function buildSystemPrompt(
  lang: "en" | "ru",
  products: readonly Product[] = [],
  treatments: readonly Treatment[] = TREATMENTS_SEED
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
${treatments.map(formatTreatment).join("\n")}${shopSection}

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
