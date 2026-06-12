import {
  categoriesFor,
  isValidDateKey,
  PAYMENT_METHODS,
  type LedgerDirection,
  type LedgerPatch,
  type NewLedgerEntry,
  type PaymentMethod,
} from "@/lib/finance";

/**
 * Validation for admin finance writes (POST create / PUT update), mirroring
 * @/lib/admin/catalog-input.
 *
 * - `create` requires direction, category (valid for that direction), a
 *   positive amount, a method and a real date; note/receiptUrl optional.
 * - `update` is partial: only provided keys are validated and applied. The
 *   id, createdAt and source fields are never client-writable. When a partial
 *   update changes `direction`, a `category` must be supplied too (so the
 *   category can be re-checked against the new direction).
 */

const MAX_NOTE = 1000;
const MAX_RECEIPT_URL = 600;
const MAX_AMOUNT = 100_000_000;

export type ValidationResult =
  | { ok: true; value: NewLedgerEntry | LedgerPatch }
  | { ok: false; fields: Record<string, string> };

function str(v: unknown): string | null {
  return typeof v === "string" ? v.trim() : null;
}

function validateDirection(
  raw: unknown,
  required: boolean,
  fields: Record<string, string>
): LedgerDirection | undefined {
  if (raw === undefined) {
    if (required) fields.direction = "direction is required";
    return undefined;
  }
  if (raw === "expense" || raw === "income") return raw;
  fields.direction = 'direction must be "expense" or "income"';
  return undefined;
}

function validateAmount(
  raw: unknown,
  required: boolean,
  fields: Record<string, string>
): number | undefined {
  if (raw === undefined) {
    if (required) fields.amountEgp = "amountEgp is required";
    return undefined;
  }
  // Accept numeric strings (the assistant and form both can send them).
  let num = raw;
  if (typeof num === "string" && num.trim() !== "" && Number.isFinite(Number(num))) {
    num = Number(num);
  }
  if (
    typeof num !== "number" ||
    !Number.isFinite(num) ||
    num <= 0 ||
    num > MAX_AMOUNT
  ) {
    fields.amountEgp = `amountEgp must be a number between 0 and ${MAX_AMOUNT}`;
    return undefined;
  }
  // Money to 2 decimal places — avoids float dust in stored totals.
  return Math.round(num * 100) / 100;
}

function validateMethod(
  raw: unknown,
  required: boolean,
  fields: Record<string, string>
): PaymentMethod | undefined {
  if (raw === undefined) {
    if (required) fields.method = "method is required";
    return undefined;
  }
  if (typeof raw === "string" && (PAYMENT_METHODS as readonly string[]).includes(raw)) {
    return raw as PaymentMethod;
  }
  fields.method = `method must be one of: ${PAYMENT_METHODS.join(", ")}`;
  return undefined;
}

function validateReceiptUrl(
  raw: unknown,
  fields: Record<string, string>
): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const url = str(raw);
  if (url === null || url.length > MAX_RECEIPT_URL) {
    fields.receiptUrl = `receiptUrl must be a string of at most ${MAX_RECEIPT_URL} characters, or null`;
    return undefined;
  }
  if (url === "") return null;
  if (!/^https:\/\/[^\s"'<>]+$/i.test(url)) {
    fields.receiptUrl = "receiptUrl must be an https:// URL";
    return undefined;
  }
  return url;
}

export function validateLedgerInput(
  body: unknown,
  mode: "create" | "update"
): ValidationResult {
  const fields: Record<string, string> = {};
  const b = (body ?? {}) as Record<string, unknown>;
  const create = mode === "create";

  const direction = validateDirection(b.direction, create, fields);
  const amountEgp = validateAmount(b.amountEgp, create, fields);
  const method = validateMethod(b.method, create, fields);

  // Date.
  let date: string | undefined;
  if (b.date !== undefined) {
    const d = str(b.date) ?? "";
    if (!isValidDateKey(d)) {
      fields.date = "date must be a real calendar date in YYYY-MM-DD form";
    } else {
      date = d;
    }
  } else if (create) {
    fields.date = "date is required";
  }

  // Category — validated against the EFFECTIVE direction. On update, a
  // direction change requires the category to be re-supplied.
  let category: string | undefined;
  if (b.category !== undefined) {
    const c = str(b.category) ?? "";
    const effectiveDirection = direction ?? undefined;
    if (effectiveDirection === undefined && !create) {
      // Updating category without a direction: we can't know the valid set
      // unless the caller also tells us the direction.
      fields.category = "to change category, also send the matching direction";
    } else if (
      effectiveDirection &&
      !categoriesFor(effectiveDirection).includes(c)
    ) {
      fields.category = `category must be one of: ${categoriesFor(effectiveDirection).join(", ")}`;
    } else if (effectiveDirection) {
      category = c;
    }
  } else if (create) {
    fields.category = "category is required";
  } else if (direction !== undefined) {
    // Direction changed on update but no category supplied — ambiguous.
    fields.category = "changing direction requires a matching category";
  }

  // Note.
  let note: string | undefined;
  if (b.note !== undefined) {
    const n = str(b.note) ?? "";
    if (n.length > MAX_NOTE) {
      fields.note = `note must be at most ${MAX_NOTE} characters`;
    } else {
      note = n;
    }
  }

  const receiptUrl = validateReceiptUrl(b.receiptUrl, fields);

  if (Object.keys(fields).length > 0) return { ok: false, fields };

  if (create) {
    // All required fields are guaranteed present here.
    const value: NewLedgerEntry = {
      date: date!,
      direction: direction!,
      category: category!,
      amountEgp: amountEgp!,
      method: method!,
      ...(note !== undefined ? { note } : {}),
      ...(receiptUrl !== undefined ? { receiptUrl } : {}),
    };
    return { ok: true, value };
  }

  const patch: LedgerPatch = {
    ...(date !== undefined ? { date } : {}),
    ...(direction !== undefined ? { direction } : {}),
    ...(category !== undefined ? { category } : {}),
    ...(amountEgp !== undefined ? { amountEgp } : {}),
    ...(method !== undefined ? { method } : {}),
    ...(note !== undefined ? { note } : {}),
    ...(receiptUrl !== undefined ? { receiptUrl } : {}),
  };
  return { ok: true, value: patch };
}
