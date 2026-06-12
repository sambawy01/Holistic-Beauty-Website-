import {
  confirmBooking,
  declineBooking,
  listOwnerBookings,
  rescheduleBooking,
  type CalBooking,
} from "../admin/cal";
import {
  effectiveSoldOut,
  getCatalog,
  saveCatalog,
  restoreQuantities,
} from "../catalog";
import {
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

/**
 * Vassili's tool belt.
 *
 * Two classes of tools:
 * - READ-ONLY (bookings_*, orders_list, catalog_list, daily_brief,
 *   document_create) execute immediately inside the agent loop.
 * - MUTATING (booking_confirm/decline/move, order_set_status,
 *   product_update, email_send to non-owner recipients) are NEVER executed
 *   by the model directly. The agent loop intercepts them, stores a pending
 *   action on Blob, and Victoria gets a [Confirm | Cancel] inline keyboard.
 *   Only the callback handler calls `executeTool` for these.
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
    "Create a PDF document on the company letterhead and send it to Victoria in this chat. Body supports light markdown: '# Heading' lines and '- bullet' lines. Latin text only (built-in fonts).",
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
];

// --- Mutation gate ----------------------------------------------------------------

const MUTATING_TOOLS = new Set([
  "booking_confirm",
  "booking_decline",
  "booking_move",
  "order_set_status",
  "product_update",
  "email_send",
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

/** One-line human summary of a mutating call, shown above [Confirm|Cancel]. */
export function describeMutation(
  name: string,
  args: Record<string, unknown>
): string {
  const s = (k: string) => (typeof args[k] === "string" ? String(args[k]) : "");
  switch (name) {
    case "booking_confirm":
      return `Confirm booking ${s("uid")}`;
    case "booking_decline":
      return `Decline booking ${s("uid")} — reason: ${s("reason") || "(none)"}`;
    case "booking_move":
      return `Move booking ${s("uid")} to ${s("newStartISO")}`;
    case "order_set_status":
      return `Set order ${s("orderNumber")} to "${s("status")}"${
        s("reason") ? ` — reason: ${s("reason")}` : ""
      }`;
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
      return `Update product ${s("slug")}: ${changes.join(", ") || "(no changes)"}`;
    }
    case "email_send":
      return `Send email to ${s("to")} — "${s("subject")}"`;
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
      ? " Note: some non-Latin characters could not be rendered and were removed."
      : ""
  }`;
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
  catalog_list: () => execCatalogList(),
  product_update: (args) => execProductUpdate(args),
  daily_brief: () => execDailyBrief(),
  email_send: (args) => execEmailSend(args),
  document_create: (args, ctx) => execDocumentCreate(args, ctx),
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
