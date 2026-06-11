import type { Product, ProductCopy } from "@/lib/catalog";

/**
 * Validation for admin catalog writes (POST create / PUT update).
 *
 * - `create` mode requires EN+RU names and both prices; everything else
 *   defaults sensibly (empty copy, no photo, untracked stock, active).
 * - `update` mode is partial: only the provided keys are validated and
 *   applied. `slug`, `createdAt`, `updatedAt` are never client-writable.
 */

const MAX_NAME = 160;
const MAX_SUB = 160;
const MAX_DESC = 1200;
const MAX_USAGE = 1200;
const MAX_ALT = 300;
const MAX_PHOTO = 600;
const MAX_PRICE = 10_000_000;
const MAX_QUANTITY = 100_000;

export interface ProductInput {
  en?: ProductCopy;
  ru?: ProductCopy;
  priceEgp?: number;
  priceRub?: number;
  photo?: string;
  alt?: { en: string; ru: string };
  /** Manufacturer usage directions; both empty strings = none. */
  usage?: { en: string; ru: string };
  quantity?: number | null;
  soldOut?: boolean;
  active?: boolean;
}

export type ValidationResult =
  | { ok: true; value: ProductInput }
  | { ok: false; fields: Record<string, string> };

function str(v: unknown): string | null {
  return typeof v === "string" ? v.trim() : null;
}

function validateCopy(
  raw: unknown,
  key: "en" | "ru",
  requireName: boolean,
  fields: Record<string, string>
): ProductCopy | undefined {
  if (raw === undefined) {
    if (requireName) fields[key] = `${key} copy is required`;
    return undefined;
  }
  const o = (raw ?? {}) as Record<string, unknown>;
  const name = str(o.name) ?? "";
  const sub = str(o.sub) ?? "";
  const desc = str(o.desc) ?? "";
  if (name.length < 1 || name.length > MAX_NAME) {
    fields[`${key}.name`] = `${key} name must be 1-${MAX_NAME} characters`;
  }
  if (sub.length > MAX_SUB) {
    fields[`${key}.sub`] = `${key} sub must be at most ${MAX_SUB} characters`;
  }
  if (desc.length > MAX_DESC) {
    fields[`${key}.desc`] = `${key} description must be at most ${MAX_DESC} characters`;
  }
  return { name, sub, desc };
}

function validatePrice(
  raw: unknown,
  key: "priceEgp" | "priceRub",
  required: boolean,
  fields: Record<string, string>
): number | undefined {
  if (raw === undefined) {
    if (required) fields[key] = `${key} is required`;
    return undefined;
  }
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw < 0 ||
    raw > MAX_PRICE
  ) {
    fields[key] = `${key} must be an integer between 0 and ${MAX_PRICE}`;
    return undefined;
  }
  return raw;
}

/** "" allowed (no photo); otherwise http(s) URL or a site-relative path. */
function validatePhoto(raw: unknown, fields: Record<string, string>): string | undefined {
  if (raw === undefined) return undefined;
  const photo = str(raw);
  if (photo === null || photo.length > MAX_PHOTO) {
    fields.photo = `photo must be a string of at most ${MAX_PHOTO} characters`;
    return undefined;
  }
  if (photo === "") return "";
  const isAbsolute = /^https:\/\/[^\s"'<>]+$/i.test(photo);
  const isRelative = /^[a-z0-9][a-z0-9_\-./]*$/i.test(photo) && !photo.includes("..");
  if (!isAbsolute && !isRelative) {
    fields.photo = "photo must be an https:// URL or a site-relative path like assets/img/shop/x.jpg";
    return undefined;
  }
  return photo;
}

export function validateProductInput(
  body: unknown,
  mode: "create" | "update"
): ValidationResult {
  const fields: Record<string, string> = {};
  const b = (body ?? {}) as Record<string, unknown>;
  const create = mode === "create";
  const value: ProductInput = {};

  const en = validateCopy(b.en, "en", create, fields);
  if (en !== undefined) value.en = en;
  const ru = validateCopy(b.ru, "ru", create, fields);
  if (ru !== undefined) value.ru = ru;

  const priceEgp = validatePrice(b.priceEgp, "priceEgp", create, fields);
  if (priceEgp !== undefined) value.priceEgp = priceEgp;
  const priceRub = validatePrice(b.priceRub, "priceRub", create, fields);
  if (priceRub !== undefined) value.priceRub = priceRub;

  const photo = validatePhoto(b.photo, fields);
  if (photo !== undefined) value.photo = photo;

  if (b.alt !== undefined) {
    const o = (b.alt ?? {}) as Record<string, unknown>;
    const altEn = str(o.en) ?? "";
    const altRu = str(o.ru) ?? "";
    if (altEn.length > MAX_ALT || altRu.length > MAX_ALT) {
      fields.alt = `alt texts must be at most ${MAX_ALT} characters`;
    } else {
      value.alt = { en: altEn, ru: altRu };
    }
  }

  if (b.usage !== undefined) {
    const o = (b.usage ?? {}) as Record<string, unknown>;
    const usageEn = str(o.en) ?? "";
    const usageRu = str(o.ru) ?? "";
    if (usageEn.length > MAX_USAGE || usageRu.length > MAX_USAGE) {
      fields.usage = `usage texts must be at most ${MAX_USAGE} characters`;
    } else {
      value.usage = { en: usageEn, ru: usageRu };
    }
  }

  if (b.quantity !== undefined) {
    if (b.quantity === null) {
      value.quantity = null;
    } else if (
      typeof b.quantity === "number" &&
      Number.isInteger(b.quantity) &&
      b.quantity >= 0 &&
      b.quantity <= MAX_QUANTITY
    ) {
      value.quantity = b.quantity;
    } else {
      fields.quantity = `quantity must be null (untracked) or an integer between 0 and ${MAX_QUANTITY}`;
    }
  }

  if (b.soldOut !== undefined) {
    if (typeof b.soldOut === "boolean") value.soldOut = b.soldOut;
    else fields.soldOut = "soldOut must be a boolean";
  }

  if (b.active !== undefined) {
    if (typeof b.active === "boolean") value.active = b.active;
    else fields.active = "active must be a boolean";
  }

  if (Object.keys(fields).length > 0) return { ok: false, fields };
  return { ok: true, value };
}

/** Apply a validated partial update to an existing product (slug immutable). */
export function applyProductInput(product: Product, input: ProductInput): Product {
  return {
    ...product,
    ...(input.en !== undefined ? { en: input.en } : {}),
    ...(input.ru !== undefined ? { ru: input.ru } : {}),
    ...(input.priceEgp !== undefined ? { priceEgp: input.priceEgp } : {}),
    ...(input.priceRub !== undefined ? { priceRub: input.priceRub } : {}),
    ...(input.photo !== undefined ? { photo: input.photo } : {}),
    ...(input.alt !== undefined ? { alt: input.alt } : {}),
    ...(input.usage !== undefined ? { usage: input.usage } : {}),
    ...(input.quantity !== undefined ? { quantity: input.quantity } : {}),
    ...(input.soldOut !== undefined ? { soldOut: input.soldOut } : {}),
    ...(input.active !== undefined ? { active: input.active } : {}),
    updatedAt: new Date().toISOString(),
  };
}
