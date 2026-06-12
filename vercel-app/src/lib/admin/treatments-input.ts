import type { Treatment } from "@/lib/treatments";

/**
 * Validation for admin treatments writes (POST create / PUT update) —
 * mirrors @/lib/admin/catalog-input for products.
 *
 * - `create` mode requires EN+RU names, duration and both prices; the
 *   description defaults to empty and `active` to true.
 * - `update` mode is partial: only the provided keys are validated and
 *   applied. `slug`, `eventTypeId`, `createdAt`, `updatedAt` are never
 *   client-writable — the event type link is managed server-side.
 */

const MAX_NAME = 160;
const MAX_DESC = 600;
const MAX_PRICE = 10_000_000;
const MIN_DURATION = 5;
const MAX_DURATION = 600;

export interface TreatmentInput {
  name?: { en: string; ru: string };
  description?: { en: string; ru: string };
  durationMinutes?: number;
  priceEgp?: number;
  priceRub?: number;
  active?: boolean;
}

export type TreatmentValidationResult =
  | { ok: true; value: TreatmentInput }
  | { ok: false; fields: Record<string, string> };

function str(v: unknown): string | null {
  return typeof v === "string" ? v.trim() : null;
}

function validatePair(
  raw: unknown,
  key: "name" | "description",
  required: boolean,
  maxLen: number,
  requireText: boolean,
  fields: Record<string, string>
): { en: string; ru: string } | undefined {
  if (raw === undefined) {
    if (required) fields[key] = `${key} is required`;
    return undefined;
  }
  const o = (raw ?? {}) as Record<string, unknown>;
  const en = str(o.en) ?? "";
  const ru = str(o.ru) ?? "";
  if (requireText && (en.length < 1 || ru.length < 1)) {
    fields[key] = `${key} requires both EN and RU text`;
  }
  if (en.length > maxLen || ru.length > maxLen) {
    fields[key] = `${key} must be at most ${maxLen} characters`;
  }
  return { en, ru };
}

function validateInt(
  raw: unknown,
  key: "priceEgp" | "priceRub" | "durationMinutes",
  required: boolean,
  min: number,
  max: number,
  fields: Record<string, string>
): number | undefined {
  if (raw === undefined) {
    if (required) fields[key] = `${key} is required`;
    return undefined;
  }
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw < min ||
    raw > max
  ) {
    fields[key] = `${key} must be an integer between ${min} and ${max}`;
    return undefined;
  }
  return raw;
}

export function validateTreatmentInput(
  body: unknown,
  mode: "create" | "update"
): TreatmentValidationResult {
  const fields: Record<string, string> = {};
  const b = (body ?? {}) as Record<string, unknown>;
  const create = mode === "create";
  const value: TreatmentInput = {};

  const name = validatePair(b.name, "name", create, MAX_NAME, true, fields);
  if (name !== undefined) value.name = name;
  const description = validatePair(
    b.description,
    "description",
    false,
    MAX_DESC,
    false,
    fields
  );
  if (description !== undefined) value.description = description;

  const durationMinutes = validateInt(
    b.durationMinutes,
    "durationMinutes",
    create,
    MIN_DURATION,
    MAX_DURATION,
    fields
  );
  if (durationMinutes !== undefined) value.durationMinutes = durationMinutes;

  const priceEgp = validateInt(b.priceEgp, "priceEgp", create, 0, MAX_PRICE, fields);
  if (priceEgp !== undefined) value.priceEgp = priceEgp;
  const priceRub = validateInt(b.priceRub, "priceRub", create, 0, MAX_PRICE, fields);
  if (priceRub !== undefined) value.priceRub = priceRub;

  if (b.active !== undefined) {
    if (typeof b.active === "boolean") value.active = b.active;
    else fields.active = "active must be a boolean";
  }

  if (Object.keys(fields).length > 0) return { ok: false, fields };
  return { ok: true, value };
}

/** Apply a validated partial update (slug + eventTypeId immutable). */
export function applyTreatmentInput(
  treatment: Treatment,
  input: TreatmentInput
): Treatment {
  return {
    ...treatment,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined
      ? { description: input.description }
      : {}),
    ...(input.durationMinutes !== undefined
      ? { durationMinutes: input.durationMinutes }
      : {}),
    ...(input.priceEgp !== undefined ? { priceEgp: input.priceEgp } : {}),
    ...(input.priceRub !== undefined ? { priceRub: input.priceRub } : {}),
    ...(input.active !== undefined ? { active: input.active } : {}),
    updatedAt: new Date().toISOString(),
  };
}
