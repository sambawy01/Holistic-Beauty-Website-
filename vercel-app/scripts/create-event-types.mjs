#!/usr/bin/env node
/**
 * One-off script: create/update the 11 per-service Cal.com event types
 * for Victoria Vasilyeva Holistic Beauty, all with owner confirmation
 * required (confirmationPolicy: always).
 *
 * Usage:  node scripts/create-event-types.mjs   (run from vercel-app/)
 *
 * Reads CALCOM_API_KEY and CALCOM_API_URL from .env.local — no secrets here.
 * Idempotent: existing slugs are PATCHed instead of duplicated.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- env -------------------------------------------------------------------
function loadEnvLocal() {
  const envPath = join(__dirname, "..", ".env.local");
  const env = {};
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

const env = loadEnvLocal();
const API_KEY = process.env.CALCOM_API_KEY || env.CALCOM_API_KEY;
const API_URL =
  process.env.CALCOM_API_URL || env.CALCOM_API_URL || "https://api.cal.eu/v2";

if (!API_KEY) {
  console.error("CALCOM_API_KEY missing (set it in vercel-app/.env.local)");
  process.exit(1);
}

const HEADERS = {
  Authorization: `Bearer ${API_KEY}`,
  "cal-api-version": "2024-06-14",
  "Content-Type": "application/json",
};

async function cal(method, path, body) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: HEADERS,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.status !== "success") {
    throw new Error(
      `${method} ${path} -> ${res.status}: ${JSON.stringify(json).slice(0, 500)}`
    );
  }
  return json.data;
}

// --- the 11 services ---------------------------------------------------------
const CONFIRMATION = { type: "always", blockUnconfirmedBookingsInBooker: false };
const LOCATIONS = [{ type: "attendeeAddress" }];

const SERVICES = [
  {
    slug: "facial-massage",
    title: "Facial Massage",
    durations: [60, 90],
    description:
      "Plastic / Myofascial / Buccal — E£1,900 (60m) · E£2,800 (90m) / 2 600–3 900 ₽",
  },
  {
    slug: "body-massage",
    title: "Medical Body Massage",
    durations: [40, 60],
    description: "E£2,100 (40m) · E£2,800 (60m) / 2 900–3 900 ₽",
  },
  {
    slug: "microcurrent-rf",
    title: "Microcurrent / RF Therapy",
    durations: [20],
    description: "E£900 / 1 300 ₽",
  },
  {
    slug: "hydrofacial",
    title: "HydroFacial + Ultrasonic Cleaning",
    durations: [60, 90],
    description: "Onmacabim — E£3,100 / 4 300 ₽",
  },
  {
    slug: "clear-skin-holy-land",
    title: "Clear Skin with HOLY LAND",
    durations: [60],
    description: "Fruit Peel & Hydro Mask — E£1,500 / 2 100 ₽",
  },
  {
    slug: "carboxytherapy",
    title: "Non-Invasive Carboxytherapy",
    durations: [30],
    description: "E£1,100 / 1 500 ₽",
  },
  {
    slug: "mandelic-peel",
    title: "Mandelic Onmacabim Peel",
    durations: [20],
    description: "All-Season Lifting — E£1,400 / 1 900 ₽",
  },
  {
    slug: "alginate-mask",
    title: "Alginate Mask",
    durations: [30],
    description: "E£900 / 1 300 ₽",
  },
  {
    slug: "dermapen-face-neck-decollete",
    title: "Derma Pen — Full Face + Neck + Décolletage",
    durations: [90],
    description: "E£3,800 / 5 300 ₽",
  },
  {
    slug: "dermapen-face-neck",
    title: "Derma Pen — Full Face + Neck",
    durations: [60],
    description: "E£2,800 / 3 900 ₽",
  },
  {
    slug: "dermapen-single-area",
    title: "Derma Pen — Single Area",
    durations: [30],
    description: "E£2,100 / 2 900 ₽",
  },
];

// Existing manually-created event types that must also require confirmation.
const EXISTING_IDS = [327544, 327595];

// --- main --------------------------------------------------------------------
function payloadFor(svc) {
  const longest = Math.max(...svc.durations);
  const payload = {
    title: svc.title,
    slug: svc.slug,
    lengthInMinutes: longest, // default = longer duration
    description: svc.description,
    locations: LOCATIONS,
    confirmationPolicy: CONFIRMATION,
  };
  if (svc.durations.length > 1) {
    payload.lengthInMinutesOptions = svc.durations;
  }
  return payload;
}

async function main() {
  const existing = await cal("GET", "/event-types");
  const bySlug = new Map(existing.map((et) => [et.slug, et]));

  const results = [];

  for (const svc of SERVICES) {
    const payload = payloadFor(svc);
    const found = bySlug.get(svc.slug);
    let id;
    if (found) {
      // slug can't be re-sent unchanged-safely on PATCH in all versions; drop it
      const { slug: _slug, ...patch } = payload;
      const updated = await cal("PATCH", `/event-types/${found.id}`, patch);
      id = updated.id;
      console.log(`updated  ${svc.slug} (id ${id})`);
    } else {
      const created = await cal("POST", "/event-types", payload);
      id = created.id;
      console.log(`created  ${svc.slug} (id ${id})`);
    }

    // Verify by GET-ing it back
    const check = await cal("GET", `/event-types/${id}`);
    const confirmOk = check.confirmationPolicy?.type === "always";
    const durations = check.lengthInMinutesOptions ?? [check.lengthInMinutes];
    const durationsOk =
      JSON.stringify([...durations].sort((a, b) => a - b)) ===
      JSON.stringify([...svc.durations].sort((a, b) => a - b));
    const slugOk = check.slug === svc.slug;
    if (!confirmOk || !durationsOk || !slugOk) {
      throw new Error(
        `verification failed for ${svc.slug}: slug=${check.slug} durations=${durations} confirmationPolicy=${JSON.stringify(check.confirmationPolicy)}`
      );
    }
    results.push({ slug: svc.slug, id, durations, confirmation: check.confirmationPolicy.type });
  }

  // Enable confirmation on the two pre-existing event types too.
  for (const id of EXISTING_IDS) {
    const updated = await cal("PATCH", `/event-types/${id}`, {
      confirmationPolicy: CONFIRMATION,
    });
    const check = await cal("GET", `/event-types/${id}`);
    if (check.confirmationPolicy?.type !== "always") {
      throw new Error(`confirmation not enabled on existing event type ${id}`);
    }
    console.log(
      `patched existing ${id} (${updated.slug}) -> confirmationPolicy: ${check.confirmationPolicy.type}`
    );
  }

  console.log("\nslug -> id (verified: slug, durations, confirmation=always)");
  console.log("-".repeat(64));
  for (const r of results) {
    console.log(
      `${r.slug.padEnd(30)} ${String(r.id).padEnd(8)} [${r.durations.join(", ")}m]`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
