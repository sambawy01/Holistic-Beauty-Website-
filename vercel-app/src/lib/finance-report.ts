import { listBookingsInRange, type CalBooking } from "./admin/cal";
import { listOrders, type StoredOrder } from "./orders";
import { getTreatmentsCatalog, type Treatment } from "./treatments";
import { orderRevenueEgp, revenueOrders } from "./reports/weekly-report";
import {
  filterByPeriod,
  listLedger,
  sumAmount,
  sumByCategory,
  type LedgerEntry,
} from "./finance";

/**
 * Profit & Loss for the studio — the period-agnostic engine behind the admin
 * Finance tab, the CSV/PDF exports, Vassili's finance_summary tool, and the
 * monthly P&L cron.
 *
 * THE NO-DOUBLE-ENTRY MODEL (deliberate — see @/lib/finance):
 *   REVENUE  = shop order revenue (live, from the order store)
 *            + treatment revenue (live, from Cal bookings × catalog price)
 *            + manual income entries (ledger)
 *   EXPENSES = manual expense entries (ledger), by category
 *   NET      = REVENUE − EXPENSES
 *
 * Platform income is pulled LIVE and never mirrored into the ledger, so there
 * is nothing to reconcile. The shop revenue figure reuses the weekly report's
 * exact status rule (orderRevenueEgp / ORDER_REVENUE_STATUSES) so the two
 * surfaces agree by construction.
 *
 * THE "CONFIRMED BOOKING = EARNED" ASSUMPTION  ⚠ flag for owner confirmation:
 *   Treatment revenue counts every Cal booking in the period whose status is
 *   "accepted" (confirmed), priced at the linked treatment's CURRENT catalog
 *   price (EGP). This treats a confirmed appointment as earned income for the
 *   period it falls in — it does NOT model no-shows, on-the-day discounts, or
 *   prices that changed after the visit. For a single-practitioner studio
 *   where confirmed visits are reliably honoured this is a sound proxy; if
 *   Victoria wants only PAST (already-happened) confirmed visits to count, the
 *   `onlyPastBookings` flag narrows it (default: all confirmed in range).
 *
 * The pure core (`computePnL`) takes already-gathered inputs so it is fully
 * unit-testable with no Blob/Cal I/O; `buildPnL` is the live async wrapper.
 */

const CAIRO_TZ = "Africa/Cairo";
const DAY_MS = 24 * 60 * 60 * 1000;

// --- Period resolution --------------------------------------------------------

export interface PnLPeriod {
  /** Inclusive start date key, YYYY-MM-DD (Cairo). */
  from: string;
  /** Inclusive end date key, YYYY-MM-DD (Cairo). */
  to: string;
  /** Human label, e.g. "June 2026" or "this week (2026-06-08 – 2026-06-14)". */
  label: string;
  /** Stable machine tag for filenames/markers, e.g. "2026-06". */
  tag: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDateKey(key: string): boolean {
  if (!DATE_RE.test(key)) return false;
  const d = new Date(`${key}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === key;
}

/** Today's Cairo calendar date as YYYY-MM-DD. */
function cairoTodayKey(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CAIRO_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Shift a YYYY-MM-DD key by whole days (UTC arithmetic — DST-irrelevant). */
function shiftDateKey(key: string, days: number): string {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "2026-06" → "June 2026". */
export function monthLabel(yearMonth: string): string {
  const [y, m] = yearMonth.split("-").map(Number);
  return `${MONTH_NAMES[m - 1] ?? "?"} ${y}`;
}

/** Calendar month containing `key` (YYYY-MM-DD). */
function monthPeriodFor(key: string): PnLPeriod {
  const ym = key.slice(0, 7);
  const [y, m] = ym.split("-").map(Number);
  const from = `${ym}-01`;
  const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // last day
  return { from, to, label: monthLabel(ym), tag: ym };
}

/** The calendar month BEFORE the month containing `now` (Cairo) — for the cron. */
export function previousMonthPeriod(now: Date = new Date()): PnLPeriod {
  const todayKey = cairoTodayKey(now);
  const firstOfThisMonth = `${todayKey.slice(0, 7)}-01`;
  const lastOfPrevMonth = shiftDateKey(firstOfThisMonth, -1);
  return monthPeriodFor(lastOfPrevMonth);
}

export type PeriodResult =
  | { ok: true; period: PnLPeriod }
  | { ok: false; error: string };

/**
 * Resolve a period request into concrete Cairo date bounds.
 * - week   → current Monday–Sunday (Cairo)
 * - month  → current calendar month (Cairo)
 * - custom → [from, to], both YYYY-MM-DD (swapped if reversed)
 */
export function resolvePeriod(input: {
  period: "week" | "month" | "custom";
  from?: string;
  to?: string;
  now?: Date;
}): PeriodResult {
  const now = input.now ?? new Date();
  const todayKey = cairoTodayKey(now);

  if (input.period === "custom") {
    let from = (input.from ?? "").trim();
    let to = (input.to ?? "").trim();
    if (!isRealDateKey(from) || !isRealDateKey(to)) {
      return {
        ok: false,
        error: "custom period needs both from and to as real YYYY-MM-DD dates",
      };
    }
    if (to < from) [from, to] = [to, from];
    return { ok: true, period: { from, to, label: `${from} – ${to}`, tag: `${from}_${to}` } };
  }

  if (input.period === "month") {
    return { ok: true, period: monthPeriodFor(todayKey) };
  }

  // week: current Monday–Sunday (Cairo). getUTCDay on the date key: 0 = Sun.
  const dow = new Date(`${todayKey}T00:00:00Z`).getUTCDay();
  const from = shiftDateKey(todayKey, -((dow + 6) % 7));
  const to = shiftDateKey(from, 6);
  return {
    ok: true,
    period: { from, to, label: `this week (${from} – ${to})`, tag: `week_${from}` },
  };
}

/**
 * Resolve a period from URL search params, accepting either:
 * - `month=YYYY-MM` (convenience for the admin month selector), or
 * - `period=week|month|custom` (+ `from`/`to` for custom).
 * Defaults to the current calendar month when nothing is given.
 */
export function resolvePeriodFromParams(
  params: URLSearchParams,
  now: Date = new Date()
): PeriodResult {
  const month = (params.get("month") ?? "").trim();
  if (month) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return { ok: false, error: "month must be in YYYY-MM form" };
    }
    return { ok: true, period: monthPeriodFor(`${month}-01`) };
  }
  const period = (params.get("period") ?? "month") as "week" | "month" | "custom";
  if (!["week", "month", "custom"].includes(period)) {
    return { ok: false, error: "period must be week, month or custom" };
  }
  return resolvePeriod({
    period,
    from: params.get("from") ?? undefined,
    to: params.get("to") ?? undefined,
    now,
  });
}

// --- P&L shape ----------------------------------------------------------------

export interface CategoryLine {
  category: string;
  amountEgp: number;
}

export interface TreatmentRevenueLine {
  name: string;
  count: number;
  amountEgp: number;
}

export interface PnL {
  period: PnLPeriod;
  revenue: {
    shopEgp: number;
    treatmentsEgp: number;
    manualIncomeEgp: number;
    totalEgp: number;
    manualIncomeByCategory: CategoryLine[];
    treatmentsBreakdown: TreatmentRevenueLine[];
    /** Accepted bookings in range with no catalog price match (excluded). */
    unmatchedBookings: number;
  };
  expenses: {
    totalEgp: number;
    byCategory: CategoryLine[];
  };
  netEgp: number;
  counts: {
    revenueOrders: number;
    confirmedBookings: number;
    ledgerEntries: number;
  };
  /** Source ledger entries in range (for the CSV export). */
  entries: LedgerEntry[];
  /** Source failures gathered live (Cal/orders/ledger) — fail-soft like the brief. */
  failures: string[];
  generatedAt: string;
}

// --- Pure compute -------------------------------------------------------------

export interface PnLInputs {
  orders: StoredOrder[];
  bookings: CalBooking[];
  treatments: Treatment[];
  ledger: LedgerEntry[];
  failures?: string[];
  now?: Date;
  /** Count ONLY confirmed bookings whose start is already in the past. */
  onlyPastBookings?: boolean;
}

/** "Facial Massage between Victoria and X" → "Facial Massage". */
function serviceTitle(booking: CalBooking): string {
  const title = booking.title || "Booking";
  const idx = title.indexOf(" between ");
  return idx > 0 ? title.slice(0, idx) : title;
}

/** Cairo calendar date key of an instant. */
function cairoKeyOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CAIRO_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * Compute the P&L from already-gathered inputs. Pure (no I/O) — the unit-test
 * seam. Shop revenue reuses orderRevenueEgp so it matches the weekly report
 * exactly for the same set of in-range orders.
 */
export function computePnL(period: PnLPeriod, inputs: PnLInputs): PnL {
  const now = inputs.now ?? new Date();

  // --- shop orders (by CREATED date, Cairo) ---
  const inRangeOrders = inputs.orders.filter((o) => {
    const k = cairoKeyOf(o.createdAt);
    return k >= period.from && k <= period.to;
  });
  const shopEgp = orderRevenueEgp(inRangeOrders);
  const revenueOrderCount = revenueOrders(inRangeOrders).length;

  // --- treatments (confirmed Cal bookings by START date × catalog price) ---
  const priceByName = new Map<string, { price: number; display: string }>();
  for (const t of inputs.treatments) {
    priceByName.set(t.name.en.trim().toLowerCase(), {
      price: t.priceEgp,
      display: t.name.en,
    });
  }
  const inRangeBookings = inputs.bookings.filter((b) => {
    const k = cairoKeyOf(b.start);
    if (!(k >= period.from && k <= period.to)) return false;
    if ((b.status || "").toLowerCase() !== "accepted") return false;
    if (inputs.onlyPastBookings && b.start >= now.toISOString()) return false;
    return true;
  });
  const treatmentAgg = new Map<string, { count: number; amountEgp: number }>();
  let unmatchedBookings = 0;
  for (const b of inRangeBookings) {
    const title = serviceTitle(b);
    const match = priceByName.get(title.trim().toLowerCase());
    if (!match) {
      unmatchedBookings++;
      continue;
    }
    const agg = treatmentAgg.get(match.display) ?? { count: 0, amountEgp: 0 };
    agg.count += 1;
    agg.amountEgp += match.price;
    treatmentAgg.set(match.display, agg);
  }
  const treatmentsBreakdown: TreatmentRevenueLine[] = [...treatmentAgg.entries()]
    .map(([name, v]) => ({ name, count: v.count, amountEgp: v.amountEgp }))
    .sort((a, b) => b.amountEgp - a.amountEgp || a.name.localeCompare(b.name));
  const treatmentsEgp = treatmentsBreakdown.reduce((s, t) => s + t.amountEgp, 0);

  // --- manual ledger entries in range ---
  const inRangeEntries = filterByPeriod(inputs.ledger, {
    from: period.from,
    to: period.to,
  });
  const incomeEntries = inRangeEntries.filter((e) => e.direction === "income");
  const expenseEntries = inRangeEntries.filter((e) => e.direction === "expense");
  const manualIncomeEgp = sumAmount(incomeEntries);
  const manualIncomeByCategory = sumByCategory(incomeEntries);
  const expenseTotalEgp = sumAmount(expenseEntries);
  const expenseByCategory = sumByCategory(expenseEntries);

  const totalRevenue = shopEgp + treatmentsEgp + manualIncomeEgp;
  const netEgp = totalRevenue - expenseTotalEgp;

  return {
    period,
    revenue: {
      shopEgp,
      treatmentsEgp,
      manualIncomeEgp,
      totalEgp: totalRevenue,
      manualIncomeByCategory,
      treatmentsBreakdown,
      unmatchedBookings,
    },
    expenses: {
      totalEgp: expenseTotalEgp,
      byCategory: expenseByCategory,
    },
    netEgp,
    counts: {
      revenueOrders: revenueOrderCount,
      confirmedBookings: inRangeBookings.length,
      ledgerEntries: inRangeEntries.length,
    },
    entries: inRangeEntries.slice().sort((a, b) => a.date.localeCompare(b.date)),
    failures: inputs.failures ?? [],
    generatedAt: now.toISOString(),
  };
}

// --- Live gather --------------------------------------------------------------

export interface PnLDataSources {
  listOrders: typeof listOrders;
  listBookingsInRange: typeof listBookingsInRange;
  getTreatmentsCatalog: typeof getTreatmentsCatalog;
  listLedger: typeof listLedger;
}

const liveSources: PnLDataSources = {
  listOrders,
  listBookingsInRange,
  getTreatmentsCatalog,
  listLedger,
};

/**
 * Gather live data for `period` and compute the P&L. Fail-soft per source
 * (like the daily brief / weekly report): one backend being down degrades a
 * single revenue line and is reported in `failures`, never a hard 5xx.
 * `sources` is injectable for tests.
 */
export async function buildPnL(
  period: PnLPeriod,
  options: { now?: Date; onlyPastBookings?: boolean; sources?: PnLDataSources } = {}
): Promise<PnL> {
  const sources = options.sources ?? liveSources;
  const failures: string[] = [];

  let orders: StoredOrder[] = [];
  try {
    orders = await sources.listOrders({ limit: 200 });
  } catch (error) {
    console.error("[finance-report] Failed to load shop orders:", error);
    failures.push("shop orders");
  }

  let bookings: CalBooking[] = [];
  try {
    // Pad the Cal window by a day each side so timezone boundaries never clip.
    bookings = await sources.listBookingsInRange(
      new Date(new Date(`${period.from}T00:00:00.000Z`).getTime() - DAY_MS).toISOString(),
      new Date(new Date(`${period.to}T23:59:59.999Z`).getTime() + DAY_MS).toISOString(),
      250
    );
  } catch (error) {
    console.error("[finance-report] Failed to load Cal bookings:", error);
    failures.push("bookings");
  }

  let treatments: Treatment[] = [];
  try {
    treatments = await sources.getTreatmentsCatalog();
  } catch (error) {
    console.error("[finance-report] Failed to load treatments catalog:", error);
    failures.push("treatments");
  }

  let ledger: LedgerEntry[] = [];
  try {
    ledger = await sources.listLedger();
  } catch (error) {
    console.error("[finance-report] Failed to load ledger:", error);
    failures.push("ledger");
  }

  return computePnL(period, {
    orders,
    bookings,
    treatments,
    ledger,
    failures,
    now: options.now,
    onlyPastBookings: options.onlyPastBookings,
  });
}

// --- CSV export ---------------------------------------------------------------

/** RFC-4180 field escaping: quote when the value holds comma/quote/newline. */
function csvField(value: string | number): string {
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function csvRow(fields: (string | number)[]): string {
  return fields.map(csvField).join(",");
}

/**
 * Build a CSV of the ledger entries in range plus a summary block. The
 * leading line is a tagged title so the file is self-describing when opened
 * months later; the entries table follows, then a blank line and the P&L
 * summary. Excel/Numbers/LibreOffice all parse this as a single sheet.
 */
export function pnlToCsv(pnl: PnL): string {
  const rows: string[] = [];
  rows.push(csvRow([`Profit & Loss — ${pnl.period.label}`]));
  rows.push(csvRow([`Range`, `${pnl.period.from} to ${pnl.period.to}`]));
  rows.push(csvRow([`Generated`, pnl.generatedAt]));
  rows.push("");

  rows.push(csvRow(["Ledger entries (manual)"]));
  rows.push(
    csvRow(["date", "direction", "category", "amount_egp", "method", "note", "receipt_url"])
  );
  for (const e of pnl.entries) {
    rows.push(
      csvRow([
        e.date,
        e.direction,
        e.category,
        e.amountEgp,
        e.method,
        e.note,
        e.receiptUrl ?? "",
      ])
    );
  }
  rows.push("");

  rows.push(csvRow(["Summary"]));
  rows.push(csvRow(["Revenue — shop orders", pnl.revenue.shopEgp]));
  rows.push(csvRow(["Revenue — treatments (confirmed bookings)", pnl.revenue.treatmentsEgp]));
  rows.push(csvRow(["Revenue — manual income", pnl.revenue.manualIncomeEgp]));
  rows.push(csvRow(["Revenue — TOTAL", pnl.revenue.totalEgp]));
  rows.push("");
  rows.push(csvRow(["Expenses by category"]));
  for (const c of pnl.expenses.byCategory) {
    rows.push(csvRow([`  ${c.category}`, c.amountEgp]));
  }
  rows.push(csvRow(["Expenses — TOTAL", pnl.expenses.totalEgp]));
  rows.push("");
  rows.push(csvRow(["NET (revenue − expenses)", pnl.netEgp]));

  // CRLF line endings — the safest cross-spreadsheet default.
  return rows.join("\r\n");
}

// --- PDF body (markdownish for the letterhead renderer) -----------------------

function egp(n: number): string {
  return `${Math.round(n).toLocaleString("en-US")} EGP`;
}

/**
 * Markdownish body for renderLetterheadPdf — headings (`# `) and bullets
 * (`- `). Kept compact so a normal month fits a single A4 page.
 */
export function pnlToLetterheadBody(pnl: PnL): string {
  const lines: string[] = [];
  lines.push(`Reporting period: ${pnl.period.from} to ${pnl.period.to} (Cairo time).`);
  if (pnl.failures.length) {
    lines.push(
      `Note: some data could not be loaded (${pnl.failures.join(", ")}) — figures below may be incomplete.`
    );
  }
  lines.push("");

  lines.push("# Revenue");
  lines.push(`- Shop orders: ${egp(pnl.revenue.shopEgp)}`);
  lines.push(
    `- Treatments (confirmed bookings): ${egp(pnl.revenue.treatmentsEgp)}`
  );
  lines.push(`- Other income (cash, gift cards): ${egp(pnl.revenue.manualIncomeEgp)}`);
  lines.push(`- Total revenue: ${egp(pnl.revenue.totalEgp)}`);
  lines.push("");

  lines.push("# Expenses");
  if (pnl.expenses.byCategory.length === 0) {
    lines.push("- No expenses recorded this period.");
  } else {
    for (const c of pnl.expenses.byCategory) {
      lines.push(`- ${c.category}: ${egp(c.amountEgp)}`);
    }
  }
  lines.push(`- Total expenses: ${egp(pnl.expenses.totalEgp)}`);
  lines.push("");

  lines.push("# Net result");
  lines.push(
    `- Net ${pnl.netEgp >= 0 ? "profit" : "loss"}: ${egp(Math.abs(pnl.netEgp))}`
  );
  lines.push("");

  lines.push("# Notes");
  lines.push(
    "- Revenue counts confirmed, shipped and delivered shop orders, and confirmed treatment bookings priced at the current catalogue rate."
  );
  lines.push(
    "- Treatment revenue treats a confirmed booking as earned for the period it falls in."
  );
  if (pnl.revenue.unmatchedBookings > 0) {
    lines.push(
      `- ${pnl.revenue.unmatchedBookings} confirmed booking(s) had no matching catalogue price and were excluded from treatment revenue.`
    );
  }

  return lines.join("\n");
}

/** Filename stem for downloads: "pnl-2026-06". */
export function pnlFilename(pnl: PnL): string {
  const tag = pnl.period.tag.replace(/[^a-z0-9_-]+/gi, "-");
  return `pnl-${tag}`;
}
