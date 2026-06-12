import {
  confirmBooking,
  createOutOfOffice,
  declineBooking,
  listBookingsInRange,
  listOwnerBookings,
  rescheduleBooking,
  type CalBooking,
} from "../admin/cal";
import {
  effectiveSoldOut,
  generateSlug,
  getCatalog,
  saveCatalog,
  restoreQuantities,
  type Product,
} from "../catalog";
import {
  getOrder,
  listOrders,
  updateOrderStatus,
  isValidOrderNumber,
  type CancelReason,
  type StoredOrder,
} from "../orders";
import { sendOrderStatusEmail, type EmailStatus } from "../order-status-email";
import { brandedEmailHtml, escapeHtml } from "../branded-email";
import { buildDailyBriefEmail } from "../daily-brief-email";
import { gatherDailyBriefData } from "../daily-brief-data";
import { renderLetterheadPdf } from "./letterhead-pdf";
import { sendDocument } from "../telegram";
import {
  addLedgerEntry,
  categoriesFor,
  isValidDateKey,
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
  PAYMENT_METHODS,
  type LedgerDirection,
  type PaymentMethod,
} from "../finance";
import {
  buildPnL,
  pnlToLetterheadBody,
  resolvePeriod,
  type PnL,
} from "../finance-report";

/**
 * Vassili's tool belt.
 *
 * Two classes of tools:
 * - READ-ONLY (bookings_*, orders_list, order_lookup, catalog_list,
 *   stats_summary, client_history, daily_brief, document_create) execute
 *   immediately inside the agent loop.
 * - MUTATING (booking_confirm/decline/move, order_set_status,
 *   product_update/add/remove, block_time, email_send to non-owner
 *   recipients) are NEVER executed by the model directly. The agent loop
 *   intercepts them, stores a pending action on Blob, and Victoria gets a
 *   [Confirm | Cancel] inline keyboard. Only the callback handler calls
 *   `executeTool` for these. Every confirmation summary spells out the
 *   third-party side effects (client emails, public-site changes, calendar
 *   blocking) — see `describeMutation`, which builds the summary
 *   structurally so disclosure cannot depend on the model's mood.
 *
 * `document_create` sends the PDF straight to the owner chat — it creates
 * nothing outside Telegram, so it counts as read-only.
 */

export interface ToolContext {
  chatId: number;
}

const CAIRO_TZ = "Africa/Cairo";

// --- Ollama tool schemas ------------------------------------------------------

export interface OllamaTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown> = {},
  required: string[] = []
): OllamaTool {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties, required },
    },
  };
}

export const TOOLS: OllamaTool[] = [
  tool(
    "bookings_today",
    "List today's CONFIRMED appointments (Cairo time): time, service, client, phone, notes."
  ),
  tool(
    "bookings_upcoming",
    "List upcoming CONFIRMED appointments over the next days: date, time, service, client."
  ),
  tool(
    "bookings_pending",
    "List PENDING booking requests awaiting Victoria's confirmation. Returns each booking's uid — needed for booking_confirm / booking_decline / booking_move."
  ),
  tool(
    "booking_confirm",
    "Confirm (accept) a pending booking request. MUTATING — Victoria will be asked to confirm with a button. Look up the uid via bookings_pending first.",
    { uid: { type: "string", description: "Cal booking uid" } },
    ["uid"]
  ),
  tool(
    "booking_decline",
    "Decline (reject) a pending booking request; the reason is emailed to the client. MUTATING — requires Victoria's button confirmation.",
    {
      uid: { type: "string", description: "Cal booking uid" },
      reason: { type: "string", description: "Reason sent to the client" },
    },
    ["uid", "reason"]
  ),
  tool(
    "booking_move",
    "Reschedule a booking to a new start time (rebooks immediately). MUTATING — requires Victoria's button confirmation.",
    {
      uid: { type: "string", description: "Cal booking uid" },
      newStartISO: {
        type: "string",
        description: "New start time, ISO 8601 UTC (e.g. 2026-06-15T13:00:00Z)",
      },
      reason: { type: "string", description: "Optional rescheduling reason" },
    },
    ["uid", "newStartISO"]
  ),
  tool(
    "orders_list",
    "List shop orders (newest first): order number, status, client, phone, total, items.",
    {
      status: {
        type: "string",
        enum: ["ordered", "confirmed", "shipped", "delivered", "cancelled"],
        description: "Optional status filter",
      },
    }
  ),
  tool(
    "order_set_status",
    "Advance a shop order's status (ordered→confirmed→shipped→delivered; cancel from ordered/confirmed, reason required when cancelling). Sends the client a status email. MUTATING — requires Victoria's button confirmation.",
    {
      orderNumber: { type: "string", description: "e.g. VV-AB12CD" },
      status: {
        type: "string",
        enum: ["confirmed", "shipped", "delivered", "cancelled"],
      },
      reason: {
        type: "string",
        description: "Required when cancelling — included in the client email",
      },
    },
    ["orderNumber", "status"]
  ),
  tool(
    "catalog_list",
    "List shop catalog products: slug, name, prices (EGP/RUB), stock quantity, sold-out and active flags."
  ),
  tool(
    "product_update",
    "Update a shop product's price, stock quantity or sold-out flag. MUTATING — requires Victoria's button confirmation. Get the slug via catalog_list first.",
    {
      slug: { type: "string", description: "Product slug from catalog_list" },
      priceEgp: { type: "number", description: "New price in EGP" },
      priceRub: { type: "number", description: "New price in RUB" },
      quantity: {
        type: "number",
        description: "New stock quantity (0 = auto sold-out)",
      },
      soldOut: { type: "boolean", description: "Manual sold-out flag" },
    },
    ["slug"]
  ),
  tool(
    "daily_brief",
    "Victoria's full daily brief: today's appointments, pending booking requests, shop orders needing action."
  ),
  tool(
    "email_send",
    "Send a branded email from bookings@victoriaholisticbeauty.com. Plain-text body. Emails to addresses other than Victoria's own require her button confirmation.",
    {
      to: { type: "string", description: "Recipient email address" },
      subject: { type: "string" },
      body: { type: "string", description: "Plain text body" },
    },
    ["to", "subject", "body"]
  ),
  tool(
    "document_create",
    "Create a PDF document on the company letterhead and send it to Victoria in this chat. Body supports light markdown: '# Heading' lines and '- bullet' lines. English and Russian both render (embedded Cyrillic-capable fonts).",
    {
      title: { type: "string", description: "Document title" },
      body: { type: "string", description: "Document body (markdownish)" },
      recipient: {
        type: "string",
        description: "Optional 'To:' line (person/company the document is for)",
      },
    },
    ["title", "body"]
  ),
  tool(
    "product_add",
    "Add a NEW product to the shop catalog. It goes live on the public site immediately after Victoria confirms. MUTATING — requires Victoria's button confirmation.",
    {
      nameEn: { type: "string", description: "Product name in English" },
      nameRu: { type: "string", description: "Product name in Russian" },
      priceEgp: { type: "number", description: "Price in EGP (required)" },
      priceRub: { type: "number", description: "Price in RUB (optional)" },
      descEn: { type: "string", description: "Description in English (optional)" },
      descRu: { type: "string", description: "Description in Russian (optional)" },
      usageEn: {
        type: "string",
        description: "Usage/application directions in English (optional)",
      },
      usageRu: {
        type: "string",
        description: "Usage/application directions in Russian (optional)",
      },
      imageUrl: { type: "string", description: "Product photo URL (optional)" },
      quantity: {
        type: "number",
        description: "Initial stock quantity (omit = stock not tracked)",
      },
    },
    ["nameEn", "nameRu", "priceEgp"]
  ),
  tool(
    "product_remove",
    "Remove a product from the shop: it is HIDDEN from the public site (soft remove, reversible) — never hard-deleted. MUTATING — requires Victoria's button confirmation. Get the slug via catalog_list first.",
    { slug: { type: "string", description: "Product slug from catalog_list" } },
    ["slug"]
  ),
  tool(
    "block_time",
    "Block whole DAYS on Victoria's Cal.com calendar so clients cannot book them (out-of-office). Cal.com only supports full days on this account — if Victoria asks to block part of a day, tell her only whole days are possible. MUTATING — requires Victoria's button confirmation.",
    {
      startDate: { type: "string", description: "First blocked day, YYYY-MM-DD" },
      endDate: {
        type: "string",
        description: "Last blocked day inclusive, YYYY-MM-DD (omit = one day)",
      },
      note: { type: "string", description: "Optional note, e.g. 'vacation'" },
    },
    ["startDate"]
  ),
  tool(
    "stats_summary",
    "Business stats for a period: confirmed bookings count (Cal.com) plus shop orders — count, revenue in EGP by status, cancellations.",
    {
      period: {
        type: "string",
        enum: ["week", "month", "custom"],
        description:
          "week = current Mon–Sun, month = current calendar month, custom = use from/to",
      },
      from: { type: "string", description: "Custom range start, YYYY-MM-DD" },
      to: { type: "string", description: "Custom range end, YYYY-MM-DD" },
    },
    ["period"]
  ),
  tool(
    "client_history",
    "A client's past and upcoming bookings, matched by name or email substring (case-insensitive). Looks one year back and one year ahead.",
    {
      query: {
        type: "string",
        description: "Part of the client's name or email, e.g. 'hany' or '@mail.ru'",
      },
    },
    ["query"]
  ),
  tool(
    "order_lookup",
    "Full detail of ONE shop order by its VV-number: items, totals, address, contact, and complete status history with reasons.",
    {
      orderNumber: { type: "string", description: "e.g. VV-AB12CD" },
    },
    ["orderNumber"]
  ),
  tool(
    "log_expense",
    "Record a business EXPENSE in Victoria's private finance ledger (rent, supplies, product stock, marketing, salaries, utilities, bank fees, other). MUTATING — requires Victoria's button confirmation. The ledger is private (clients never see it).",
    {
      category: {
        type: "string",
        enum: [...EXPENSE_CATEGORIES],
        description: "Expense category",
      },
      amountEgp: { type: "number", description: "Amount in EGP (positive)" },
      method: {
        type: "string",
        enum: [...PAYMENT_METHODS],
        description: "How it was paid",
      },
      note: { type: "string", description: "Optional note, e.g. 'Onmacabim restock'" },
      date: {
        type: "string",
        description: "Date YYYY-MM-DD (omit = today, Cairo)",
      },
    },
    ["category", "amountEgp", "method"]
  ),
  tool(
    "log_income",
    "Record off-platform/cash INCOME in Victoria's private finance ledger (treatment paid in cash, gift card, other). Do NOT use this for shop orders or online bookings — those are counted automatically. MUTATING — requires Victoria's button confirmation.",
    {
      category: {
        type: "string",
        enum: [...INCOME_CATEGORIES],
        description: "Income category",
      },
      amountEgp: { type: "number", description: "Amount in EGP (positive)" },
      method: {
        type: "string",
        enum: [...PAYMENT_METHODS],
        description: "How it was received",
      },
      note: { type: "string", description: "Optional note" },
      date: {
        type: "string",
        description: "Date YYYY-MM-DD (omit = today, Cairo)",
      },
    },
    ["category", "amountEgp", "method"]
  ),
  tool(
    "finance_summary",
    "Profit & Loss for a period: revenue (shop orders + treatments + cash/other income), expenses by category, and net. Read-only.",
    {
      period: {
        type: "string",
        enum: ["week", "month", "custom"],
        description:
          "week = current Mon–Sun, month = current calendar month, custom = use from/to",
      },
      from: { type: "string", description: "Custom range start, YYYY-MM-DD" },
      to: { type: "string", description: "Custom range end, YYYY-MM-DD" },
    },
    ["period"]
  ),
  tool(
    "finance_pnl_document",
    "Generate a Profit & Loss statement on the company letterhead (PDF) for a period and send it to Victoria in this chat. Read-only (goes only to Victoria).",
    {
      period: {
        type: "string",
        enum: ["week", "month", "custom"],
        description:
          "week = current Mon–Sun, month = current calendar month, custom = use from/to",
      },
      from: { type: "string", description: "Custom range start, YYYY-MM-DD" },
      to: { type: "string", description: "Custom range end, YYYY-MM-DD" },
    },
    ["period"]
  ),
];

// --- Mutation gate ----------------------------------------------------------------

const MUTATING_TOOLS = new Set([
  "booking_confirm",
  "booking_decline",
  "booking_move",
  "order_set_status",
  "product_update",
  "product_add",
  "product_remove",
  "block_time",
  "email_send",
  "log_expense",
  "log_income",
]);

/** Victoria's own addresses — email_send to these skips the confirm gate. */
function ownerEmailAllowlist(): Set<string> {
  const set = new Set<string>(["victoria@victoriaholisticbeauty.com"]);
  for (const addr of (process.env.NOTIFY_EMAIL || "").split(",")) {
    const a = addr.trim().toLowerCase();
    if (a) set.add(a);
  }
  return set;
}

/** Does this tool call need Victoria's [Confirm] tap before executing? */
export function requiresConfirmation(
  name: string,
  args: Record<string, unknown>
): boolean {
  if (!MUTATING_TOOLS.has(name)) return false;
  if (name === "email_send") {
    const to = typeof args.to === "string" ? args.to.trim().toLowerCase() : "";
    return !ownerEmailAllowlist().has(to);
  }
  return true;
}

// --- Mutation argument validation ----------------------------------------------

/** Tool parameters that must be a single valid email address when present. */
const EMAIL_PARAMS: Record<string, readonly string[]> = {
  email_send: ["to"],
};

export type ValidatedArgs =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Normalize and validate a MUTATING tool call's arguments against its
 * declared schema — ONCE, before the pending action is created. Both the
 * confirmation summary (describeMutation) and the executor must consume the
 * returned object, so what Victoria confirms is exactly what executes.
 *
 * This closes the disclosure/executor divergence: e.g. `to: ["a@evil.com"]`
 * used to render as a BLANK recipient on the confirmation card while the
 * executor's String() coercion emailed the real address. Now any param whose
 * runtime type differs from the declared type — or a missing/empty required
 * string, or an invalid email — REFUSES the call outright; it is never
 * queued. Undeclared params are dropped. One deliberate exception: a string
 * that round-trips losslessly through Number() for a number-typed param is
 * coerced (LLMs emit numbers-as-strings constantly) — the summary renders
 * the coerced value, so confirm-what-executes is preserved.
 */
export function validateMutationArgs(
  name: string,
  args: Record<string, unknown>
): ValidatedArgs {
  const schema = TOOLS.find((t) => t.function.name === name);
  if (!schema) return { ok: false, error: `unknown tool "${name}"` };
  const { properties, required } = schema.function.parameters;
  const requiredSet = new Set(required);
  const emailParams = new Set(EMAIL_PARAMS[name] ?? []);
  const normalized: Record<string, unknown> = {};

  for (const [key, spec] of Object.entries(properties)) {
    const declared = (spec as { type?: string; enum?: string[] }) ?? {};
    const value = args[key];

    if (value === undefined || value === null) {
      if (requiredSet.has(key)) {
        return { ok: false, error: `required parameter "${key}" is missing` };
      }
      continue;
    }

    if (declared.type === "string") {
      if (typeof value !== "string") {
        return {
          ok: false,
          error: `parameter "${key}" must be a single text value`,
        };
      }
      const trimmed = value.trim();
      if (requiredSet.has(key) && trimmed.length === 0) {
        return { ok: false, error: `required parameter "${key}" is empty` };
      }
      if (emailParams.has(key) && !EMAIL_RE.test(trimmed)) {
        return {
          ok: false,
          error: `parameter "${key}" must be one valid email address`,
        };
      }
      if (declared.enum && !declared.enum.includes(trimmed)) {
        return {
          ok: false,
          error: `parameter "${key}" must be one of: ${declared.enum.join(", ")}`,
        };
      }
      normalized[key] = trimmed;
    } else if (declared.type === "number") {
      let num: unknown = value;
      // LLMs routinely emit numbers as strings ('"priceEgp": "250"').
      // Coerce ONLY when the round-trip is lossless (Number() then back to
      // the exact same string) — the summary then renders the coerced
      // number, so what Victoria confirms is exactly what executes. Anything
      // lossy ("015", "1e3", "250.0") or non-numeric is still refused.
      if (typeof num === "string") {
        const trimmed = num.trim();
        const coerced = Number(trimmed);
        if (
          trimmed.length > 0 &&
          Number.isFinite(coerced) &&
          String(coerced) === trimmed
        ) {
          num = coerced;
        }
      }
      if (typeof num !== "number" || !Number.isFinite(num)) {
        return { ok: false, error: `parameter "${key}" must be a number` };
      }
      normalized[key] = num;
    } else if (declared.type === "boolean") {
      if (typeof value !== "boolean") {
        return { ok: false, error: `parameter "${key}" must be true or false` };
      }
      normalized[key] = value;
    } else {
      // No other parameter types are declared in TOOLS today; refuse rather
      // than pass through something the summary cannot faithfully render.
      return { ok: false, error: `parameter "${key}" has an unsupported type` };
    }
  }

  return { ok: true, args: normalized };
}

/**
 * Human summary of a mutating call, shown above [Confirm | Cancel].
 *
 * STRUCTURAL DISCLOSURE: every summary must spell out the third-party side
 * effects of confirming (emails the client will receive, public-site
 * changes, calendar blocking) on a trailing "→" line. This lives here — in
 * the gate's summary builder — so disclosure is guaranteed by code, never
 * dependent on the model choosing to mention it.
 */
export function describeMutation(
  name: string,
  args: Record<string, unknown>
): string {
  const s = (k: string) => (typeof args[k] === "string" ? String(args[k]) : "");
  switch (name) {
    case "booking_confirm":
      return (
        `Confirm booking ${s("uid")}\n` +
        `→ The client will receive a booking-confirmation email from Cal.com.`
      );
    case "booking_decline":
      return (
        `Decline booking ${s("uid")} — reason: ${s("reason") || "(none)"}\n` +
        `→ The client will be EMAILED this reason (Cal.com rejection email).`
      );
    case "booking_move":
      return (
        `Move booking ${s("uid")} to ${s("newStartISO")}\n` +
        `→ The booking is rebooked immediately and the client is emailed the new time.`
      );
    case "order_set_status": {
      const cancelling = s("status") === "cancelled";
      return (
        `Set order ${s("orderNumber")} to "${s("status")}"${
          s("reason") ? ` — reason: ${s("reason")}` : ""
        }\n` +
        (cancelling
          ? `→ The client will receive a cancellation email INCLUDING this reason.`
          : `→ The client will receive a status email ("${s("status")}").`)
      );
    }
    case "product_update": {
      const changes: string[] = [];
      if (typeof args.priceEgp === "number")
        changes.push(`price ${args.priceEgp} EGP`);
      if (typeof args.priceRub === "number")
        changes.push(`price ${args.priceRub} RUB`);
      if (typeof args.quantity === "number")
        changes.push(`quantity ${args.quantity}`);
      if (typeof args.soldOut === "boolean")
        changes.push(`soldOut ${args.soldOut}`);
      return (
        `Update product ${s("slug")}: ${changes.join(", ") || "(no changes)"}\n` +
        `→ The change goes LIVE on the public site immediately.`
      );
    }
    case "product_add": {
      const qty =
        typeof args.quantity === "number"
          ? `, qty ${args.quantity}`
          : ", stock untracked";
      const rub =
        typeof args.priceRub === "number" ? ` / ${args.priceRub} RUB` : "";
      return (
        `Add product "${s("nameEn")}" (${s("nameRu")}) — ${
          typeof args.priceEgp === "number" ? args.priceEgp : "?"
        } EGP${rub}${qty}\n` +
        `→ The product goes LIVE on the public site immediately.`
      );
    }
    case "product_remove":
      return (
        `Remove product ${s("slug")}\n` +
        `→ It disappears from the public site immediately (soft remove — kept in the catalog, reversible).`
      );
    case "block_time": {
      const start = s("startDate");
      const end = s("endDate") || start;
      const range = end === start ? start : `${start} – ${end}`;
      return (
        `Block calendar: ${range}${s("note") ? ` — ${s("note")}` : ""}\n` +
        `→ The WHOLE day(s) become unbookable on Cal.com — clients see no available slots there.`
      );
    }
    case "email_send":
      return (
        `Send email to ${s("to")}\n` +
        `Subject: "${s("subject")}"\n` +
        `——— full message ———\n` +
        `${s("body")}\n` +
        `——————————————\n` +
        `→ This exact email goes to ${s("to")} from bookings@victoriaholisticbeauty.com.`
      );
    case "log_expense": {
      const amount = typeof args.amountEgp === "number" ? args.amountEgp : "?";
      const when = s("date") || "today";
      return (
        `Log expense: ${amount} EGP · ${s("category")} · ${s("method")} · ${when}` +
        `${s("note") ? ` — ${s("note")}` : ""}\n` +
        `→ Logs an expense to your books (private — not visible to clients).`
      );
    }
    case "log_income": {
      const amount = typeof args.amountEgp === "number" ? args.amountEgp : "?";
      const when = s("date") || "today";
      return (
        `Log income: ${amount} EGP · ${s("category")} · ${s("method")} · ${when}` +
        `${s("note") ? ` — ${s("note")}` : ""}\n` +
        `→ Logs cash/off-platform income to your books (private — not visible to clients).`
      );
    }
    default:
      return `${name}(${JSON.stringify(args)})`;
  }
}

// --- formatting helpers --------------------------------------------------------

function cairoClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "??:??";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: CAIRO_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);
}

function cairoDayClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: CAIRO_TZ,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(d)
    .replace(",", "");
}

function cairoDateKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CAIRO_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function serviceTitle(b: CalBooking): string {
  const title = b.title || "Booking";
  const idx = title.indexOf(" between ");
  return idx > 0 ? title.slice(0, idx) : title;
}

function bookingPhone(b: CalBooking): string {
  const v = b.bookingFieldsResponses?.["attendeePhoneNumber"];
  return typeof v === "string" && v.trim() ? v.trim() : "no phone";
}

function bookingLine(b: CalBooking, withDate: boolean): string {
  const when = withDate ? cairoDayClock(b.start) : cairoClock(b.start);
  return `${when} · ${serviceTitle(b)} · ${b.attendees?.[0]?.name || "Unknown"} · ${bookingPhone(b)} (uid: ${b.uid})`;
}

function orderLine(o: StoredOrder): string {
  const items = o.items.map((i) => `${i.qty}x ${i.names.en}`).join(", ");
  return `${o.orderNumber} [${o.status}] · ${o.name} · ${o.phone} · ${o.totals.egp} EGP — ${items}`;
}

// --- executors -------------------------------------------------------------------

type Executor = (
  args: Record<string, unknown>,
  ctx: ToolContext
) => Promise<string>;

async function execBookingsToday(): Promise<string> {
  const bookings = await listOwnerBookings();
  const todayKey = cairoDateKey(new Date());
  const today = bookings.filter(
    (b) =>
      (b.status || "").toLowerCase() === "accepted" &&
      cairoDateKey(new Date(b.start)) === todayKey
  );
  if (today.length === 0) return "No confirmed appointments today.";
  return today.map((b) => bookingLine(b, false)).join("\n");
}

async function execBookingsUpcoming(): Promise<string> {
  const bookings = await listOwnerBookings();
  const upcoming = bookings.filter(
    (b) => (b.status || "").toLowerCase() === "accepted"
  );
  if (upcoming.length === 0) return "No upcoming confirmed appointments.";
  return upcoming
    .slice(0, 20)
    .map((b) => bookingLine(b, true))
    .join("\n");
}

async function execBookingsPending(): Promise<string> {
  const bookings = await listOwnerBookings();
  const pending = bookings.filter(
    (b) => (b.status || "").toLowerCase() === "pending"
  );
  if (pending.length === 0) return "No pending booking requests.";
  return pending.map((b) => bookingLine(b, true)).join("\n");
}

function calResultText(
  verb: string,
  result: { ok: boolean; status: number; body: unknown }
): string {
  if (result.ok) return `${verb} — done.`;
  const detail =
    typeof result.body === "object" && result.body !== null
      ? JSON.stringify(result.body).slice(0, 300)
      : String(result.body).slice(0, 300);
  return `${verb} FAILED (Cal.com ${result.status}): ${detail}`;
}

async function execOrdersList(args: Record<string, unknown>): Promise<string> {
  const status = typeof args.status === "string" ? args.status : undefined;
  const orders = await listOrders({ limit: 30 });
  const filtered = status ? orders.filter((o) => o.status === status) : orders;
  if (filtered.length === 0)
    return status ? `No orders with status "${status}".` : "No orders found.";
  return filtered.map(orderLine).join("\n");
}

async function execOrderSetStatus(
  args: Record<string, unknown>
): Promise<string> {
  const orderNumber = String(args.orderNumber ?? "").trim().toUpperCase();
  const status = String(args.status ?? "");
  if (!isValidOrderNumber(orderNumber)) {
    return `Invalid order number "${orderNumber}" (expected VV-XXXXXX).`;
  }
  if (!["confirmed", "shipped", "delivered", "cancelled"].includes(status)) {
    return `Invalid status "${status}".`;
  }
  const nextStatus = status as EmailStatus;

  let cancelReason: CancelReason | undefined;
  if (nextStatus === "cancelled") {
    const note = typeof args.reason === "string" ? args.reason.trim() : "";
    if (!note) return "Cancelling requires a reason.";
    cancelReason = { code: "other", note: note.slice(0, 300) };
  }

  const result = await updateOrderStatus(orderNumber, nextStatus, cancelReason);
  if (!result.ok) {
    return result.error === "not-found"
      ? `Order ${orderNumber} not found.`
      : `Invalid transition: ${result.current} → ${result.requested}.`;
  }

  // Mirror the /api/admin status route: restore stock on cancel (non-fatal).
  let stockNote = "";
  if (nextStatus === "cancelled") {
    try {
      await restoreQuantities(
        result.order.items.map(({ slug, qty }) => ({ slug, qty }))
      );
      stockNote = " Stock restored to catalog.";
    } catch (error) {
      console.error(`[assistant] Stock restore failed (${orderNumber}):`, error);
      stockNote = " WARNING: stock restore failed — fix counts in /admin.";
    }
  }

  const emailResult = await sendOrderStatusEmail(
    result.order,
    nextStatus,
    cancelReason
  );
  const emailNote = emailResult.sent
    ? " Client emailed."
    : ` Client NOT emailed (${emailResult.reason ?? "unknown"}).`;
  return `Order ${orderNumber} → ${nextStatus}.${emailNote}${stockNote}`;
}

async function execCatalogList(): Promise<string> {
  const catalog = await getCatalog();
  return catalog
    .map(
      (p) =>
        `${p.slug} · ${p.en.name} · ${p.priceEgp} EGP / ${p.priceRub} RUB · qty: ${
          p.quantity === null ? "untracked" : p.quantity
        }${effectiveSoldOut(p) ? " · SOLD OUT" : ""}${p.active ? "" : " · hidden"}`
    )
    .join("\n");
}

async function execProductUpdate(
  args: Record<string, unknown>
): Promise<string> {
  const slug = String(args.slug ?? "").trim();
  const catalog = await getCatalog();
  const product = catalog.find((p) => p.slug === slug);
  if (!product) return `Product "${slug}" not found — check catalog_list.`;

  const changes: string[] = [];
  if (typeof args.priceEgp === "number" && args.priceEgp >= 0) {
    product.priceEgp = Math.round(args.priceEgp);
    changes.push(`price ${product.priceEgp} EGP`);
  }
  if (typeof args.priceRub === "number" && args.priceRub >= 0) {
    product.priceRub = Math.round(args.priceRub);
    changes.push(`price ${product.priceRub} RUB`);
  }
  if (typeof args.quantity === "number" && args.quantity >= 0) {
    product.quantity = Math.round(args.quantity);
    changes.push(`quantity ${product.quantity}`);
  }
  if (typeof args.soldOut === "boolean") {
    product.soldOut = args.soldOut;
    changes.push(`soldOut ${args.soldOut}`);
  }
  if (changes.length === 0) return "No valid changes given.";

  product.updatedAt = new Date().toISOString();
  await saveCatalog(catalog);
  return `Updated ${slug}: ${changes.join(", ")}.${
    effectiveSoldOut(product) ? " Product now shows as sold out." : ""
  }`;
}

async function execProductAdd(args: Record<string, unknown>): Promise<string> {
  const str = (k: string) =>
    typeof args[k] === "string" ? (args[k] as string).trim() : "";
  const nameEn = str("nameEn").slice(0, 120);
  const nameRu = str("nameRu").slice(0, 120);
  if (!nameEn || !nameRu)
    return "Both names are required (nameEn and nameRu).";
  if (typeof args.priceEgp !== "number" || args.priceEgp <= 0)
    return "A positive priceEgp is required.";
  const priceEgp = Math.round(args.priceEgp);
  const priceRub =
    typeof args.priceRub === "number" && args.priceRub >= 0
      ? Math.round(args.priceRub)
      : 0;
  const quantity =
    typeof args.quantity === "number" && args.quantity >= 0
      ? Math.round(args.quantity)
      : null;
  const usageEn = str("usageEn").slice(0, 2000);
  const usageRu = str("usageRu").slice(0, 2000);

  const catalog = await getCatalog();
  const slug = generateSlug(nameEn, new Set(catalog.map((p) => p.slug)));
  const now = new Date().toISOString();
  const product: Product = {
    slug,
    en: { name: nameEn, sub: "", desc: str("descEn").slice(0, 2000) },
    ru: { name: nameRu, sub: "", desc: str("descRu").slice(0, 2000) },
    priceEgp,
    priceRub,
    photo: str("imageUrl").slice(0, 500),
    alt: { en: nameEn, ru: nameRu },
    ...(usageEn || usageRu
      ? { usage: { en: usageEn, ru: usageRu } }
      : {}),
    quantity,
    soldOut: false,
    active: true,
    createdAt: now,
    updatedAt: now,
  };
  catalog.push(product);
  await saveCatalog(catalog);
  return `Added "${nameEn}" (slug: ${slug}) — ${priceEgp} EGP / ${priceRub} RUB, ${
    quantity === null ? "stock untracked" : `qty ${quantity}`
  }. It is LIVE on the site now.${
    product.photo ? "" : " No photo yet — add one in /admin when ready."
  }`;
}

async function execProductRemove(
  args: Record<string, unknown>
): Promise<string> {
  const slug = String(args.slug ?? "").trim();
  const catalog = await getCatalog();
  const product = catalog.find((p) => p.slug === slug);
  if (!product) return `Product "${slug}" not found — check catalog_list.`;
  if (!product.active)
    return `Product "${slug}" is already hidden from the site — nothing to do.`;
  product.active = false;
  product.updatedAt = new Date().toISOString();
  await saveCatalog(catalog);
  return `Product "${slug}" removed from the public site (soft remove: it stays in the catalog with active=false, so this is reversible from /admin or by re-activating it).`;
}

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDateKey(key: string): boolean {
  if (!DATE_KEY_RE.test(key)) return false;
  const d = new Date(`${key}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === key;
}

async function execBlockTime(args: Record<string, unknown>): Promise<string> {
  const startDate = String(args.startDate ?? "").trim();
  const endDate = String(args.endDate ?? "").trim() || startDate;
  const note =
    typeof args.note === "string" ? args.note.trim().slice(0, 200) : "";
  if (!isRealDateKey(startDate) || !isRealDateKey(endDate)) {
    return "Dates must be real days in YYYY-MM-DD form.";
  }
  if (endDate < startDate) return "endDate must not be before startDate.";
  const todayCairo = cairoDateKey(new Date());
  if (endDate < todayCairo) {
    return `That range is in the past (today in Cairo is ${todayCairo}) — nothing to block.`;
  }

  const result = await createOutOfOffice(startDate, endDate, note || undefined);
  if (!result.ok) {
    const detail =
      typeof result.body === "object" && result.body !== null
        ? JSON.stringify(result.body).slice(0, 300)
        : String(result.body).slice(0, 300);
    return `Blocking FAILED (Cal.com ${result.status}): ${detail}`;
  }
  const id = (result.body as { data?: { id?: number } } | null)?.data?.id;
  const range = endDate === startDate ? startDate : `${startDate} – ${endDate}`;
  return `Calendar blocked: ${range} — the whole day(s) are now unbookable (Cal.com out-of-office${
    typeof id === "number" ? ` #${id}` : ""
  }). Note: Cal.com only supports FULL-day blocks on this account — partial-day windows are not possible. To unblock, remove the entry in Cal.com → Availability → Out of office.`;
}

/** Shift a YYYY-MM-DD key by whole days (UTC arithmetic). */
function shiftDateKey(key: string, days: number): string {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function execStatsSummary(
  args: Record<string, unknown>
): Promise<string> {
  const period = String(args.period ?? "week");
  const todayKey = cairoDateKey(new Date());
  let fromKey: string;
  let toKey: string;
  let label: string;

  if (period === "custom") {
    fromKey = String(args.from ?? "").trim();
    toKey = String(args.to ?? "").trim();
    if (!isRealDateKey(fromKey) || !isRealDateKey(toKey)) {
      return "Custom period needs both from and to as real YYYY-MM-DD dates.";
    }
    if (toKey < fromKey) [fromKey, toKey] = [toKey, fromKey];
    label = `${fromKey} – ${toKey}`;
  } else if (period === "month") {
    fromKey = `${todayKey.slice(0, 7)}-01`;
    const [y, m] = todayKey.split("-").map(Number);
    toKey = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    label = `this month (${fromKey} – ${toKey})`;
  } else {
    // week: current Monday–Sunday (Cairo)
    const dow = new Date(`${todayKey}T00:00:00Z`).getUTCDay(); // 0 = Sun
    fromKey = shiftDateKey(todayKey, -((dow + 6) % 7));
    toKey = shiftDateKey(fromKey, 6);
    label = `this week (${fromKey} – ${toKey})`;
  }

  const [bookings, allOrders] = await Promise.all([
    listBookingsInRange(`${fromKey}T00:00:00.000Z`, `${toKey}T23:59:59.999Z`),
    listOrders({ limit: 200 }),
  ]);

  const byStatus = (s: string) =>
    bookings.filter((b) => (b.status || "").toLowerCase() === s).length;
  const confirmedBookings = byStatus("accepted");
  const pendingBookings = byStatus("pending");
  const cancelledBookings =
    byStatus("cancelled") + byStatus("rejected");

  const orders = allOrders.filter((o) => {
    const k = (o.createdAt || "").slice(0, 10);
    return k >= fromKey && k <= toKey;
  });
  const orderAgg = new Map<string, { count: number; egp: number }>();
  for (const o of orders) {
    const agg = orderAgg.get(o.status) ?? { count: 0, egp: 0 };
    agg.count += 1;
    agg.egp += o.totals?.egp ?? 0;
    orderAgg.set(o.status, agg);
  }
  const cancelledOrders = orderAgg.get("cancelled")?.count ?? 0;
  const activeRevenue = orders
    .filter((o) => o.status !== "cancelled")
    .reduce((sum, o) => sum + (o.totals?.egp ?? 0), 0);

  const lines = [
    `Stats for ${label}:`,
    `Bookings — ${confirmedBookings} confirmed` +
      (pendingBookings ? `, ${pendingBookings} pending` : "") +
      (cancelledBookings ? `, ${cancelledBookings} cancelled/rejected` : ""),
    `Orders — ${orders.length} total, ${activeRevenue} EGP revenue (excl. cancelled)`,
  ];
  for (const [status, agg] of orderAgg) {
    lines.push(`  · ${status}: ${agg.count} order(s), ${agg.egp} EGP`);
  }
  if (cancelledOrders === 0) lines.push(`  · cancelled: 0`);
  return lines.join("\n");
}

async function execClientHistory(
  args: Record<string, unknown>
): Promise<string> {
  const query = String(args.query ?? "").trim().toLowerCase();
  if (query.length < 2) {
    return "Give me at least 2 characters of the client's name or email.";
  }
  const now = Date.now();
  const bookings = await listBookingsInRange(
    new Date(now - 365 * 86_400_000).toISOString(),
    new Date(now + 365 * 86_400_000).toISOString()
  );
  const matches = bookings.filter((b) =>
    (b.attendees ?? []).some(
      (a) =>
        (a.name || "").toLowerCase().includes(query) ||
        (a.email || "").toLowerCase().includes(query)
    )
  );
  if (matches.length === 0) {
    return `No bookings match "${query}" (searched one year back and ahead).`;
  }
  const line = (b: CalBooking) => {
    const a = b.attendees?.[0];
    return `${cairoDayClock(b.start)} · ${serviceTitle(b)} · ${b.status} · ${
      a?.name || "Unknown"
    }${a?.email ? ` (${a.email})` : ""}`;
  };
  const nowIso = new Date(now).toISOString();
  const upcoming = matches.filter((b) => b.start >= nowIso).slice(0, 15);
  const past = matches
    .filter((b) => b.start < nowIso)
    .reverse()
    .slice(0, 15);
  const parts = [`Client history for "${query}" — ${matches.length} booking(s):`];
  if (upcoming.length > 0)
    parts.push("Upcoming:", ...upcoming.map(line));
  if (past.length > 0) parts.push("Past (newest first):", ...past.map(line));
  return parts.join("\n");
}

async function execOrderLookup(
  args: Record<string, unknown>
): Promise<string> {
  const orderNumber = String(args.orderNumber ?? "").trim().toUpperCase();
  if (!isValidOrderNumber(orderNumber)) {
    return `Invalid order number "${orderNumber}" (expected VV-XXXXXX).`;
  }
  const order = await getOrder(orderNumber);
  if (!order) return `Order ${orderNumber} not found.`;

  const lines = [
    `${order.orderNumber} — ${order.status.toUpperCase()}`,
    `Placed: ${cairoDayClock(order.createdAt)}`,
    `Client: ${order.name} · ${order.phone}${order.email ? ` · ${order.email}` : ""}`,
    `Address: ${order.address || "(none)"}`,
  ];
  if (order.note) lines.push(`Note: ${order.note}`);
  lines.push("Items:");
  for (const i of order.items) {
    lines.push(`— ${i.qty}× ${i.names.en} — ${i.lineTotals.egp} EGP`);
  }
  lines.push(
    `Total: ${order.totals.egp} EGP / ${order.totals.rub} RUB`,
    `Client language: ${order.lang}`,
    "Status history:"
  );
  for (const h of Array.isArray(order.statusHistory) ? order.statusHistory : []) {
    const reason = h.reason
      ? ` · reason: ${h.reason.code}${h.reason.note ? ` (${h.reason.note})` : ""}`
      : "";
    lines.push(`— ${h.status} · ${cairoDayClock(h.at)}${reason}`);
  }
  return lines.join("\n");
}

async function execDailyBrief(): Promise<string> {
  const data = await gatherDailyBriefData();
  const brief = buildDailyBriefEmail(data);
  return brief.text;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function execEmailSend(args: Record<string, unknown>): Promise<string> {
  const to = String(args.to ?? "").trim();
  const subject = String(args.subject ?? "").trim().slice(0, 200);
  const body = String(args.body ?? "").trim().slice(0, 8000);
  if (!EMAIL_RE.test(to)) return `"${to}" is not a valid email address.`;
  if (!subject || !body) return "Subject and body are both required.";

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(
      `[assistant] RESEND_API_KEY not set — would email ${to}:\nSubject: ${subject}\n${body}`
    );
    return "Email is not configured (RESEND_API_KEY missing) — nothing sent.";
  }

  const contentHtml = body
    .split(/\n{2,}/)
    .map(
      (p) =>
        `<p style="margin:0 0 16px;color:#3A332C;font-size:15px;line-height:1.65;">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`
    )
    .join("");
  const html = brandedEmailHtml({ heading: subject, contentHtml });

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    signal: AbortSignal.timeout(12_000),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Victoria Vasilyeva Holistic Beauty <bookings@victoriaholisticbeauty.com>",
      to: [to],
      reply_to: "victoria@victoriaholisticbeauty.com",
      subject,
      text: body,
      html,
    }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    console.error(`[assistant] email_send to ${to} failed (${res.status}): ${detail}`);
    return `Email to ${to} FAILED (Resend ${res.status}).`;
  }
  return `Email sent to ${to}: "${subject}".`;
}

async function execDocumentCreate(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<string> {
  const title = String(args.title ?? "").trim().slice(0, 120);
  const body = String(args.body ?? "").trim().slice(0, 20000);
  const recipient =
    typeof args.recipient === "string" && args.recipient.trim()
      ? args.recipient.trim().slice(0, 120)
      : undefined;
  if (!title || !body) return "Title and body are both required.";

  const { pdf, unsupportedCharsStripped } = await renderLetterheadPdf({
    title,
    body,
    recipient,
  });
  const filename =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "document";
  const sent = await sendDocument(ctx.chatId, `${filename}.pdf`, pdf, {
    caption: title,
  });
  if (!sent.ok) return "PDF was generated but sending to Telegram failed.";
  return `PDF "${title}" sent to the chat.${
    unsupportedCharsStripped
      ? " Note: some characters (e.g. emoji) could not be rendered and were removed."
      : ""
  }`;
}

async function execLogLedger(
  direction: LedgerDirection,
  args: Record<string, unknown>
): Promise<string> {
  const category = String(args.category ?? "").trim();
  if (!categoriesFor(direction).includes(category)) {
    return `Invalid ${direction} category "${category}". Use one of: ${categoriesFor(direction).join(", ")}.`;
  }
  const amountEgp =
    typeof args.amountEgp === "number" ? args.amountEgp : Number(args.amountEgp);
  if (!Number.isFinite(amountEgp) || amountEgp <= 0) {
    return "Amount must be a positive number of EGP.";
  }
  const method = String(args.method ?? "").trim();
  if (!(PAYMENT_METHODS as readonly string[]).includes(method)) {
    return `Invalid method "${method}". Use one of: ${PAYMENT_METHODS.join(", ")}.`;
  }
  const rawDate = typeof args.date === "string" ? args.date.trim() : "";
  const date = rawDate || cairoDateKey(new Date());
  if (!isValidDateKey(date)) {
    return `Invalid date "${rawDate}" — use YYYY-MM-DD.`;
  }
  const note = typeof args.note === "string" ? args.note.trim().slice(0, 1000) : "";

  const entry = await addLedgerEntry({
    date,
    direction,
    category,
    amountEgp: Math.round(amountEgp * 100) / 100,
    method: method as PaymentMethod,
    note,
  });
  const verb = direction === "expense" ? "Expense" : "Income";
  return `${verb} logged: ${entry.amountEgp} EGP · ${category} · ${method} · ${date}${
    note ? ` — ${note}` : ""
  }. (Private — clients never see your books.)`;
}

/** Resolve a {period, from, to} arg bundle into a concrete P&L period. */
function resolveToolPeriod(
  args: Record<string, unknown>
): { ok: true; pnl: Promise<PnL>; label: string } | { ok: false; error: string } {
  const period = String(args.period ?? "month") as "week" | "month" | "custom";
  if (!["week", "month", "custom"].includes(period)) {
    return { ok: false, error: 'period must be "week", "month" or "custom".' };
  }
  const resolved = resolvePeriod({
    period,
    from: typeof args.from === "string" ? args.from : undefined,
    to: typeof args.to === "string" ? args.to : undefined,
  });
  if (!resolved.ok) return { ok: false, error: resolved.error };
  return {
    ok: true,
    pnl: buildPnL(resolved.period),
    label: resolved.period.label,
  };
}

async function execFinanceSummary(
  args: Record<string, unknown>
): Promise<string> {
  const resolved = resolveToolPeriod(args);
  if (!resolved.ok) return resolved.error;
  const pnl = await resolved.pnl;

  const lines = [
    `P&L for ${pnl.period.label}:`,
    `Revenue — ${pnl.revenue.totalEgp} EGP total`,
    `  · shop orders: ${pnl.revenue.shopEgp} EGP`,
    `  · treatments (confirmed bookings): ${pnl.revenue.treatmentsEgp} EGP`,
    `  · cash/other income: ${pnl.revenue.manualIncomeEgp} EGP`,
    `Expenses — ${pnl.expenses.totalEgp} EGP total`,
  ];
  for (const c of pnl.expenses.byCategory) {
    lines.push(`  · ${c.category}: ${c.amountEgp} EGP`);
  }
  if (pnl.expenses.byCategory.length === 0) {
    lines.push("  · (no expenses logged)");
  }
  lines.push(
    `Net — ${pnl.netEgp >= 0 ? "profit" : "loss"} ${Math.abs(pnl.netEgp)} EGP`
  );
  if (pnl.failures.length) {
    lines.push(`(Heads up: couldn't load ${pnl.failures.join(", ")} — may be incomplete.)`);
  }
  return lines.join("\n");
}

async function execFinancePnlDocument(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<string> {
  const resolved = resolveToolPeriod(args);
  if (!resolved.ok) return resolved.error;
  const pnl = await resolved.pnl;

  const { pdf } = await renderLetterheadPdf({
    title: `Profit & Loss — ${pnl.period.label}`,
    body: pnlToLetterheadBody(pnl),
  });
  const filename =
    `pnl-${pnl.period.tag}`.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 60) || "pnl";
  const sent = await sendDocument(ctx.chatId, `${filename}.pdf`, pdf, {
    caption: `P&L — ${pnl.period.label}`,
  });
  if (!sent.ok) return "P&L PDF was generated but sending to Telegram failed.";
  return `P&L statement for ${pnl.period.label} sent to the chat (net ${
    pnl.netEgp >= 0 ? "profit" : "loss"
  } ${Math.abs(pnl.netEgp)} EGP).`;
}

const EXECUTORS: Record<string, Executor> = {
  bookings_today: () => execBookingsToday(),
  bookings_upcoming: () => execBookingsUpcoming(),
  bookings_pending: () => execBookingsPending(),
  booking_confirm: async (args) =>
    calResultText(
      `Booking ${String(args.uid ?? "")} confirmed`,
      await confirmBooking(String(args.uid ?? ""))
    ),
  booking_decline: async (args) =>
    calResultText(
      `Booking ${String(args.uid ?? "")} declined`,
      await declineBooking(String(args.uid ?? ""), String(args.reason ?? ""))
    ),
  booking_move: async (args) =>
    calResultText(
      `Booking ${String(args.uid ?? "")} moved to ${String(args.newStartISO ?? "")}`,
      await rescheduleBooking(
        String(args.uid ?? ""),
        String(args.newStartISO ?? ""),
        typeof args.reason === "string" ? args.reason : undefined
      )
    ),
  orders_list: (args) => execOrdersList(args),
  order_set_status: (args) => execOrderSetStatus(args),
  order_lookup: (args) => execOrderLookup(args),
  catalog_list: () => execCatalogList(),
  product_update: (args) => execProductUpdate(args),
  product_add: (args) => execProductAdd(args),
  product_remove: (args) => execProductRemove(args),
  block_time: (args) => execBlockTime(args),
  stats_summary: (args) => execStatsSummary(args),
  client_history: (args) => execClientHistory(args),
  daily_brief: () => execDailyBrief(),
  email_send: (args) => execEmailSend(args),
  document_create: (args, ctx) => execDocumentCreate(args, ctx),
  log_expense: (args) => execLogLedger("expense", args),
  log_income: (args) => execLogLedger("income", args),
  finance_summary: (args) => execFinanceSummary(args),
  finance_pnl_document: (args, ctx) => execFinancePnlDocument(args, ctx),
};

/**
 * Execute a tool by name. Callers are responsible for the confirmation gate
 * (`requiresConfirmation`) — this function executes unconditionally.
 * Returns human/model-readable text; errors are caught and reported as text.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<string> {
  const executor = EXECUTORS[name];
  if (!executor) return `Unknown tool: ${name}`;
  try {
    return await executor(args, ctx);
  } catch (error) {
    console.error(`[assistant] Tool ${name} failed:`, error);
    return `Tool ${name} failed: ${error instanceof Error ? error.message : "unknown error"}`;
  }
}
