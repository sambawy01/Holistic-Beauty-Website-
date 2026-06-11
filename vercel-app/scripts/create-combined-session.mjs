#!/usr/bin/env node
/**
 * Create/update the single "Combined Session" Cal.com event type used for
 * multi-treatment bookings (several treatments in one session; durations sum).
 *
 * Usage:  node scripts/create-combined-session.mjs   (run from vercel-app/)
 *
 * lengthInMinutesOptions = every achievable sum of 2–4 treatments from the
 * catalogue (each service counted at its LONGEST duration), capped at 240 min,
 * plus every single-service duration so the event type is robust.
 *
 * Idempotent: if slug `combined-session` exists it is PATCHed, else POSTed.
 * If Cal rejects the options array (length cap), falls back to a 10-minute
 * grid 40..240 and reports.
 *
 * Reads CALCOM_API_KEY and CALCOM_API_URL from .env.local — no secrets here.
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
    const err = new Error(
      `${method} ${path} -> ${res.status}: ${JSON.stringify(json).slice(0, 500)}`
    );
    err.httpStatus = res.status;
    throw err;
  }
  return json.data;
}

// --- duration math -----------------------------------------------------------
// Longest duration per service (mirrors src/lib/services.ts — 11 services).
const SERVICE_LONGEST = [90, 60, 20, 90, 60, 30, 20, 30, 90, 60, 30];
// Every duration that appears on any single-service event type.
const SINGLE_DURATIONS = [20, 30, 40, 60, 90];
const MAX_TOTAL = 240;

/** All achievable sums of 2..4 items drawn (without replacement) from values. */
function combinedSums(values, minPick = 2, maxPick = 4, cap = MAX_TOTAL) {
  const sums = new Set();
  const n = values.length;
  function rec(start, picked, total) {
    if (total > cap) return;
    if (picked >= minPick) sums.add(total);
    if (picked === maxPick) return;
    for (let i = start; i < n; i++) rec(i + 1, picked + 1, total + values[i]);
  }
  rec(0, 0, 0);
  return sums;
}

const optionSet = combinedSums(SERVICE_LONGEST);
for (const d of SINGLE_DURATIONS) optionSet.add(d);
const OPTIONS = [...optionSet].sort((a, b) => a - b);

const FALLBACK_OPTIONS = [];
for (let m = 40; m <= MAX_TOTAL; m += 10) FALLBACK_OPTIONS.push(m);

// --- main --------------------------------------------------------------------
const SLUG = "combined-session";

function payloadFor(options) {
  return {
    title: "Combined Session",
    slug: SLUG,
    lengthInMinutes: options[0],
    lengthInMinutesOptions: options,
    description:
      "Several treatments in one session — total time is the sum of the chosen treatments.",
    locations: [{ type: "attendeeAddress" }],
    confirmationPolicy: { type: "always", blockUnconfirmedBookingsInBooker: false },
  };
}

async function upsert(options) {
  const existing = await cal("GET", "/event-types");
  const found = existing.find((et) => et.slug === SLUG);
  const payload = payloadFor(options);
  if (found) {
    const { slug: _slug, ...patch } = payload;
    const updated = await cal("PATCH", `/event-types/${found.id}`, patch);
    console.log(`updated  ${SLUG} (id ${updated.id})`);
    return updated.id;
  }
  const created = await cal("POST", "/event-types", payload);
  console.log(`created  ${SLUG} (id ${created.id})`);
  return created.id;
}

async function main() {
  console.log(`computed lengthInMinutesOptions (${OPTIONS.length}):`);
  console.log(JSON.stringify(OPTIONS));

  let used = OPTIONS;
  let id;
  try {
    id = await upsert(OPTIONS);
  } catch (err) {
    console.warn(`Cal rejected computed options array: ${err.message}`);
    console.warn("Falling back to 10-minute grid 40..240");
    used = FALLBACK_OPTIONS;
    id = await upsert(FALLBACK_OPTIONS);
  }

  // Verify by GET that the options stuck.
  const check = await cal("GET", `/event-types/${id}`);
  const got = check.lengthInMinutesOptions ?? [check.lengthInMinutes];
  const ok =
    JSON.stringify([...got].sort((a, b) => a - b)) ===
    JSON.stringify([...used].sort((a, b) => a - b));
  console.log(`\nGET /event-types/${id}`);
  console.log(`  slug:                  ${check.slug}`);
  console.log(`  lengthInMinutes:       ${check.lengthInMinutes}`);
  console.log(`  lengthInMinutesOptions ${JSON.stringify(got)}`);
  console.log(`  confirmationPolicy:    ${check.confirmationPolicy?.type}`);
  console.log(`  locations:             ${JSON.stringify(check.locations)}`);
  if (!ok || check.slug !== SLUG || check.confirmationPolicy?.type !== "always") {
    throw new Error("verification failed — options/slug/confirmation mismatch");
  }
  console.log(`\nOK — combined-session event type id ${id} verified.`);
  console.log(
    `Add to src/lib/services.ts: COMBINED_SESSION = { slug: "${SLUG}", eventTypeId: ${id} }`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
