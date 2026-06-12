import { get, put } from "@vercel/blob";

/**
 * Manual finance ledger on Vercel Blob (private store `vv-orders`),
 * mirroring the shop catalog in @/lib/catalog.
 *
 * Layout: ONE JSON document at `finance/ledger.json` holding the full array
 * of ledger entries. The studio's volume is tiny (a handful of entries a
 * week), so a single read-modify-write document is simpler and safer than
 * per-entry blobs — exactly like the catalog and treatments stores.
 *
 * SCOPE — the ledger holds MANUAL entries ONLY: expenses, off-platform/cash
 * income, and adjustments. Platform income (shop orders, treatment bookings)
 * is NEVER duplicated here; it is pulled LIVE at report time from the order
 * and booking data (see @/lib/finance-report). That deliberately avoids the
 * reconciliation bugs a double-entry mirror would create.
 *
 * Lifecycle (mirrors catalog.ts read-error semantics EXACTLY):
 * - A missing blob (fresh store) yields []. The blob is written lazily on the
 *   first `addLedgerEntry`, so a fresh deployment works with zero setup.
 * - Any OTHER read failure THROWS so a transient error is never mistaken for
 *   "empty ledger" by a writer — a subsequent save must never clobber real
 *   entries with an empty array.
 *
 * TESTABILITY: all Blob I/O goes through an injectable `LedgerStore`
 * (defaults to @vercel/blob). `__setLedgerStore` swaps in an in-memory mock
 * for unit tests — the local BLOB token currently 403s on private content
 * reads, so the persistence layer must be verifiable without real prod Blob.
 */

// --- Domain model -------------------------------------------------------------

export const LEDGER_PATHNAME = "finance/ledger.json";

export const EXPENSE_CATEGORIES = [
  "rent",
  "supplies",
  "product-stock",
  "marketing",
  "salaries",
  "utilities",
  "bank-fees",
  "other",
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const INCOME_CATEGORIES = ["treatment-cash", "gift-card", "other"] as const;
export type IncomeCategory = (typeof INCOME_CATEGORIES)[number];

export const PAYMENT_METHODS = [
  "cash",
  "bank-transfer",
  "card",
  "other",
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export type LedgerDirection = "expense" | "income";

export interface LedgerEntry {
  id: string;
  /** Calendar date the money moved, YYYY-MM-DD (Cairo). */
  date: string;
  direction: LedgerDirection;
  /** One of EXPENSE_CATEGORIES (expense) or INCOME_CATEGORIES (income). */
  category: string;
  amountEgp: number;
  method: PaymentMethod;
  note: string;
  /** Optional vv-media receipt photo URL; null when none. */
  receiptUrl: string | null;
  createdAt: string;
  /** Always "manual" — the ledger never stores platform-derived income. */
  source: "manual";
}

/** Valid category set for a direction (used by validation + the executors). */
export function categoriesFor(direction: LedgerDirection): readonly string[] {
  return direction === "expense" ? EXPENSE_CATEGORIES : INCOME_CATEGORIES;
}

// --- Injectable storage -------------------------------------------------------

/**
 * The narrow Blob surface the ledger needs. `read` returns the document text,
 * or null ONLY for a true 404 (fresh store); ANY other failure throws.
 */
export interface LedgerStore {
  read(pathname: string): Promise<string | null>;
  write(pathname: string, body: string): Promise<void>;
}

const blobStore: LedgerStore = {
  async read(pathname) {
    const result = await get(pathname, { access: "private", useCache: false });
    // The SDK returns null for a missing blob (fresh store) and THROWS on
    // transport/auth errors — those propagate to the caller (never clobber).
    if (!result) return null;
    return new Response(result.stream).text();
  },
  async write(pathname, body) {
    await put(pathname, body, {
      access: "private",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  },
};

let store: LedgerStore = blobStore;

/** TEST-ONLY: swap the Blob store for an in-memory mock. */
export function __setLedgerStore(next: LedgerStore): void {
  store = next;
}

/** TEST-ONLY: restore the real @vercel/blob store. */
export function __resetLedgerStore(): void {
  store = blobStore;
}

// --- Validation ---------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date in YYYY-MM-DD form. */
export function isValidDateKey(key: string): boolean {
  if (!DATE_RE.test(key)) return false;
  const d = new Date(`${key}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === key;
}

/** Structural check for one stored ledger entry (corruption guard). */
function isValidEntry(value: unknown): value is LedgerEntry {
  const e = value as LedgerEntry | null;
  return (
    typeof e === "object" &&
    e !== null &&
    typeof e.id === "string" &&
    e.id.length > 0 &&
    typeof e.date === "string" &&
    DATE_RE.test(e.date) &&
    (e.direction === "expense" || e.direction === "income") &&
    typeof e.category === "string" &&
    typeof e.amountEgp === "number" &&
    Number.isFinite(e.amountEgp) &&
    typeof e.method === "string" &&
    typeof e.note === "string" &&
    (e.receiptUrl === null || typeof e.receiptUrl === "string") &&
    typeof e.createdAt === "string" &&
    e.source === "manual"
  );
}

// --- Persistence --------------------------------------------------------------

/**
 * Read the full ledger. A missing blob (fresh store) yields []; any other
 * failure throws (a transient read must never read as "empty" to a writer).
 * Per-entry shape validation throws on ANY malformed entry — same policy as
 * the treatments store: corruption surfaces loudly rather than flowing
 * through as a partial/garbled ledger.
 */
export async function listLedger(): Promise<LedgerEntry[]> {
  const text = await store.read(LEDGER_PATHNAME);
  if (text === null) return [];
  const data = JSON.parse(text) as unknown;
  if (!Array.isArray(data)) {
    throw new Error("Ledger blob is corrupt (not an array)");
  }
  for (const entry of data) {
    if (!isValidEntry(entry)) {
      throw new Error(
        `Ledger blob is corrupt (malformed entry: ${JSON.stringify(entry).slice(0, 200)})`
      );
    }
  }
  return data as LedgerEntry[];
}

/** Overwrite the ledger document (also the lazy first write). */
async function saveLedger(entries: LedgerEntry[]): Promise<void> {
  await store.write(LEDGER_PATHNAME, JSON.stringify(entries, null, 2));
}

export interface NewLedgerEntry {
  date: string;
  direction: LedgerDirection;
  category: string;
  amountEgp: number;
  method: PaymentMethod;
  note?: string;
  receiptUrl?: string | null;
}

/**
 * Append a manual entry (read-modify-write). Returns the stored entry with
 * its generated id/createdAt. Races at this volume are acceptable, exactly as
 * the catalog/treatments stores document.
 */
export async function addLedgerEntry(
  input: NewLedgerEntry
): Promise<LedgerEntry> {
  const ledger = await listLedger();
  const now = new Date().toISOString();
  const entry: LedgerEntry = {
    id: crypto.randomUUID(),
    date: input.date,
    direction: input.direction,
    category: input.category,
    amountEgp: input.amountEgp,
    method: input.method,
    note: input.note ?? "",
    receiptUrl: input.receiptUrl ?? null,
    createdAt: now,
    source: "manual",
  };
  ledger.push(entry);
  await saveLedger(ledger);
  return entry;
}

export type LedgerPatch = Partial<
  Pick<
    LedgerEntry,
    "date" | "direction" | "category" | "amountEgp" | "method" | "note" | "receiptUrl"
  >
>;

/**
 * Patch an entry by id (read-modify-write). Returns the updated entry, or
 * null when the id is unknown.
 */
export async function updateLedgerEntry(
  id: string,
  patch: LedgerPatch
): Promise<LedgerEntry | null> {
  const ledger = await listLedger();
  const index = ledger.findIndex((e) => e.id === id);
  if (index === -1) return null;
  const updated: LedgerEntry = { ...ledger[index], ...patch };
  ledger[index] = updated;
  await saveLedger(ledger);
  return updated;
}

/**
 * Hard-delete an entry by id (read-modify-write). Ledger entries are
 * user-owned records, so a hard delete is correct — there is no public-facing
 * artifact to soft-hide (the deletion is still gated behind a confirm in the
 * admin UI and the assistant). Returns true when something was removed.
 */
export async function removeLedgerEntry(id: string): Promise<boolean> {
  const ledger = await listLedger();
  const remaining = ledger.filter((e) => e.id !== id);
  if (remaining.length === ledger.length) return false;
  await saveLedger(remaining);
  return true;
}

// --- Pure helpers (no I/O — unit-testable in isolation) -----------------------

export interface PeriodFilter {
  /** Inclusive start date key, YYYY-MM-DD. */
  from: string;
  /** Inclusive end date key, YYYY-MM-DD. */
  to: string;
  direction?: LedgerDirection;
  category?: string;
}

/**
 * Entries whose `date` falls inside [from, to] (inclusive), optionally
 * narrowed by direction and/or category. Date keys are compared as strings —
 * valid because YYYY-MM-DD sorts lexicographically the same as chronologically.
 */
export function filterByPeriod(
  entries: LedgerEntry[],
  filter: PeriodFilter
): LedgerEntry[] {
  return entries.filter((e) => {
    if (e.date < filter.from || e.date > filter.to) return false;
    if (filter.direction && e.direction !== filter.direction) return false;
    if (filter.category && e.category !== filter.category) return false;
    return true;
  });
}

/** Sum amountEgp grouped by category, returned as a stable, sorted array. */
export function sumByCategory(
  entries: LedgerEntry[]
): { category: string; amountEgp: number }[] {
  const totals = new Map<string, number>();
  for (const e of entries) {
    totals.set(e.category, (totals.get(e.category) ?? 0) + e.amountEgp);
  }
  return [...totals.entries()]
    .map(([category, amountEgp]) => ({ category, amountEgp }))
    .sort(
      (a, b) => b.amountEgp - a.amountEgp || a.category.localeCompare(b.category)
    );
}

/** Total amountEgp across a set of entries. */
export function sumAmount(entries: LedgerEntry[]): number {
  return entries.reduce((sum, e) => sum + e.amountEgp, 0);
}
