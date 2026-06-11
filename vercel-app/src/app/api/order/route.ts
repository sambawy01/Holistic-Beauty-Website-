import { NextRequest, NextResponse } from "next/server";
import { corsHeaders, isAllowedOrigin } from "@/lib/cors";
import { saveOrder, type StoredOrder } from "@/lib/orders";
import {
  getCatalog,
  effectiveSoldOut,
  decrementQuantities,
  formatEgp,
  formatRub,
  type Product,
} from "@/lib/catalog";

export const runtime = "nodejs";

/**
 * POST /api/order — cash-on-delivery product orders from the static shop.
 *
 * Trust model:
 * - The catalog (names + prices + stock) is the DYNAMIC catalog in
 *   @/lib/catalog (Vercel Blob, falling back to its built-in seed). Totals
 *   are always computed here; any client-supplied totals are ignored.
 * - Sold-out products (manual flag or quantity 0) and quantities exceeding
 *   tracked stock are rejected with a 400 whose `fields.items` message is
 *   bilingual (EN / RU) so the static shop can show it verbatim.
 * - On success, tracked quantities are decremented (read-modify-write;
 *   races are tolerable at this volume). Hitting 0 makes the product auto
 *   sold-out for subsequent catalog fetches.
 * - Same CORS allowlist as /api/chat; per-IP in-memory rate limit.
 * - Owner notification via Resend (same pattern as /api/cal/webhook), with a
 *   graceful console-log no-op when RESEND_API_KEY is unset. A mailer failure
 *   never 500s the order — the client still gets { received: true }.
 * - Optional buyer `email`: when present, a second confirmation email is sent
 *   to the buyer. Buyer-email failures never affect the response success or
 *   Victoria's notification — both outcomes are reported separately in
 *   { received, orderNumber, emailed, ownerEmails, buyerEmailed }.
 * - Every order gets a server-generated order number (VV-XXXXXX) included in
 *   the response and in both emails so it can be quoted over the phone.
 * - Owner notifications go out as one Resend call PER recipient so a single
 *   bounced inbox can't take down the other; `emailed` stays true when at
 *   least one recipient succeeded, with per-recipient counts in
 *   `ownerEmails: { sent, failed }`.
 * - Every order is persisted to Vercel Blob (private store) at
 *   `orders/<orderNumber>.json` so /admin can track its status
 *   (ordered → shipped → delivered). A Blob failure must NEVER fail the
 *   order — it is caught and logged, and the response reports
 *   `stored: boolean`.
 */

const NOTIFY_EMAIL_DEFAULT = "victoria@victoriaholisticbeauty.com";
const EMAIL_FROM =
  "Victoria Holistic Beauty <orders@victoriaholisticbeauty.com>";
const BUYER_EMAIL_FROM =
  "Victoria Vasilyeva Holistic Beauty <bookings@victoriaholisticbeauty.com>";
const BUYER_REPLY_TO = "victoria@victoriaholisticbeauty.com";

const MAX_DISTINCT_ITEMS = 8;
const MAX_QTY = 10;
const PHONE_RE = /^\+?[0-9\s\-()]{8,17}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LEN = 120;

// --- CORS preflight --------------------------------------------------------

export async function OPTIONS(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!isAllowedOrigin(origin)) {
    return new NextResponse(null, { status: 403 });
  }
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
}

// --- Rate limiting -----------------------------------------------------------
// Simple in-memory per-IP sliding window (mirrors /api/chat). Per-instance,
// best-effort only — on serverless each instance keeps its own counters.

const RATE_LIMIT = 5; // requests
const RATE_WINDOW_MS = 60_000; // per minute
const hits = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const windowStart = now - RATE_WINDOW_MS;
  const recent = (hits.get(ip) ?? []).filter((t) => t > windowStart);
  if (recent.length >= RATE_LIMIT) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  // Opportunistic cleanup so the map doesn't grow unbounded.
  if (hits.size > 5000) {
    for (const [key, times] of hits) {
      if (times.every((t) => t <= windowStart)) hits.delete(key);
    }
  }
  return false;
}

function clientIp(request: NextRequest): string {
  const fwd = request.headers.get("x-forwarded-for");
  return fwd ? fwd.split(",")[0].trim() : "unknown";
}

// --- Validation --------------------------------------------------------------

interface OrderLine {
  product: Product;
  qty: number;
  lineEgp: number;
  lineRub: number;
}

interface ValidatedOrder {
  lines: OrderLine[];
  totalEgp: number;
  totalRub: number;
  name: string;
  phone: string; // normalized (spaces/dashes/parens stripped)
  email: string; // optional — "" when the buyer left it blank
  address: string;
  note: string;
  lang: "en" | "ru";
}

function validateOrder(
  body: unknown,
  catalog: Product[]
): { ok: true; order: ValidatedOrder } | { ok: false; fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  const b = (body ?? {}) as Record<string, unknown>;

  // Only active products are orderable — hidden products behave like unknown
  // slugs, exactly as the public /api/products presents the world.
  const productsBySlug = new Map(
    catalog.filter((p) => p.active).map((p) => [p.slug, p])
  );

  // items -------------------------------------------------------------------
  const lines: OrderLine[] = [];
  if (!Array.isArray(b.items) || b.items.length === 0) {
    fields.items = "items must be a non-empty array";
  } else if (b.items.length > MAX_DISTINCT_ITEMS) {
    fields.items = `items must contain at most ${MAX_DISTINCT_ITEMS} distinct products`;
  } else {
    const seen = new Set<string>();
    for (const [i, raw] of b.items.entries()) {
      const item = (raw ?? {}) as { slug?: unknown; qty?: unknown };
      if (typeof item.slug !== "string" || !productsBySlug.has(item.slug)) {
        fields.items = `items[${i}].slug is not a known product`;
        break;
      }
      if (seen.has(item.slug)) {
        fields.items = `items[${i}].slug is a duplicate — merge quantities per product`;
        break;
      }
      if (
        typeof item.qty !== "number" ||
        !Number.isInteger(item.qty) ||
        item.qty < 1 ||
        item.qty > MAX_QTY
      ) {
        fields.items = `items[${i}].qty must be an integer between 1 and ${MAX_QTY}`;
        break;
      }
      const product = productsBySlug.get(item.slug)!;
      // Stock checks — bilingual messages the static shop shows verbatim.
      if (effectiveSoldOut(product)) {
        fields.items = `“${product.en.name}” is sold out / «${product.ru.name}» нет в наличии`;
        break;
      }
      if (typeof product.quantity === "number" && item.qty > product.quantity) {
        fields.items = `Only ${product.quantity} left of “${product.en.name}” / Осталось только ${product.quantity}: «${product.ru.name}»`;
        break;
      }
      seen.add(item.slug);
      lines.push({
        product,
        qty: item.qty,
        lineEgp: product.priceEgp * item.qty,
        lineRub: product.priceRub * item.qty,
      });
    }
  }

  // name ----------------------------------------------------------------------
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (name.length < 2 || name.length > 80) {
    fields.name = "name must be 2-80 characters";
  }

  // phone — validate the raw shape, then normalize like the booking route
  // (strip spaces/dashes/parens) for storage in the notification email.
  const rawPhone = typeof b.phone === "string" ? b.phone.trim() : "";
  const normalizedPhone = rawPhone.replace(/[\s\-()]/g, "");
  if (!PHONE_RE.test(rawPhone) || !/^\+?[0-9]{8,17}$/.test(normalizedPhone)) {
    fields.phone = "phone must be 8-17 digits, optionally starting with +";
  }

  // email (optional) ------------------------------------------------------------
  let email = "";
  if (b.email !== undefined && b.email !== null && b.email !== "") {
    if (
      typeof b.email !== "string" ||
      b.email.trim().length > MAX_EMAIL_LEN ||
      !EMAIL_RE.test(b.email.trim())
    ) {
      fields.email = `email must be a valid address of at most ${MAX_EMAIL_LEN} characters`;
    } else {
      email = b.email.trim();
    }
  }

  // address -------------------------------------------------------------------
  const address = typeof b.address === "string" ? b.address.trim() : "";
  if (address.length < 5 || address.length > 400) {
    fields.address = "address must be 5-400 characters";
  }

  // note (optional) -----------------------------------------------------------
  let note = "";
  if (b.note !== undefined && b.note !== null) {
    if (typeof b.note !== "string" || b.note.length > 500) {
      fields.note = "note must be a string of at most 500 characters";
    } else {
      note = b.note.trim();
    }
  }

  // lang ----------------------------------------------------------------------
  if (b.lang !== "en" && b.lang !== "ru") {
    fields.lang = "lang must be 'en' or 'ru'";
  }

  if (Object.keys(fields).length > 0) {
    return { ok: false, fields };
  }

  return {
    ok: true,
    order: {
      lines,
      totalEgp: lines.reduce((sum, l) => sum + l.lineEgp, 0),
      totalRub: lines.reduce((sum, l) => sum + l.lineRub, 0),
      name,
      phone: normalizedPhone,
      email,
      address,
      note,
      lang: b.lang as "en" | "ru",
    },
  };
}

// --- Order number ----------------------------------------------------------------

/**
 * Human-readable order number: `VV-` + 6 uppercase base36 chars.
 * Last 4 base36 digits of the ms timestamp (cycles ~28 min) + 2 random
 * base36 chars — collisions are vanishingly unlikely at this shop's volume,
 * and the result is short enough to read over the phone.
 */
function generateOrderNumber(): string {
  const ts = Date.now().toString(36).slice(-4);
  const rand = Math.floor(Math.random() * 36 * 36)
    .toString(36)
    .padStart(2, "0");
  return `VV-${(ts + rand).toUpperCase()}`;
}

// --- Notification email --------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildEmail(
  order: ValidatedOrder,
  orderNumber: string
): {
  subject: string;
  text: string;
  html: string;
} {
  const subject = `New shop order ${orderNumber} — ${order.name} · ${order.totalEgp} EGP (COD)`;

  const textItems = order.lines.map(
    (l) =>
      `- ${l.product.en.name} / ${l.product.ru.name} × ${l.qty} = ${formatEgp(l.lineEgp)} / ${formatRub(l.lineRub)}`
  );
  const text = [
    "New shop order (cash on delivery)",
    "",
    `Order number: ${orderNumber}`,
    "",
    "Items:",
    ...textItems,
    "",
    `Total:    ${formatEgp(order.totalEgp)} / ${formatRub(order.totalRub)}`,
    "",
    `Name:     ${order.name}`,
    `Phone:    ${order.phone}`,
    `Email:    ${order.email || "—"}`,
    `Address:  ${order.address}`,
    `Note:     ${order.note || "—"}`,
    `Language: ${order.lang}`,
    "",
    "Cash on delivery — contact the client on WhatsApp to confirm delivery time.",
  ].join("\n");

  const itemRows = order.lines
    .map(
      (l) =>
        `<tr>` +
        `<td style="padding:8px 12px 8px 0;color:#3A332C;font-size:14px;border-bottom:1px solid #E5DCCB;">${escapeHtml(l.product.en.name)}<br><span style="color:#847866;font-size:13px;">${escapeHtml(l.product.ru.name)}</span></td>` +
        `<td style="padding:8px 12px;color:#3A332C;font-size:14px;border-bottom:1px solid #E5DCCB;text-align:center;">${l.qty}</td>` +
        `<td style="padding:8px 0;color:#3A332C;font-size:14px;border-bottom:1px solid #E5DCCB;text-align:right;white-space:nowrap;">${escapeHtml(formatEgp(l.lineEgp))}<br><span style="color:#847866;font-size:13px;">${escapeHtml(formatRub(l.lineRub))}</span></td>` +
        `</tr>`
    )
    .join("");

  const row = (label: string, value: string) =>
    `<tr><td style="padding:6px 16px 6px 0;color:#847866;font-size:13px;text-transform:uppercase;letter-spacing:0.08em;white-space:nowrap;vertical-align:top;">${label}</td><td style="padding:6px 0;color:#3A332C;font-size:15px;">${escapeHtml(value)}</td></tr>`;

  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background-color:#F4EFE7;font-family:Georgia,'Times New Roman',serif;">
  <div style="max-width:560px;margin:0 auto;padding:32px 16px;">
    <div style="background-color:#FFFDF9;border:1px solid #E5DCCB;border-radius:16px;padding:32px;">
      <p style="margin:0 0 4px;color:#847866;font-size:12px;text-transform:uppercase;letter-spacing:0.2em;">Victoria Vasilyeva Holistic Beauty</p>
      <h1 style="margin:0 0 8px;color:#3A332C;font-size:26px;font-weight:normal;">New shop order</h1>
      <p style="margin:0 0 24px;color:#3A332C;font-size:16px;font-weight:bold;">Order number: ${escapeHtml(orderNumber)}</p>
      <table style="border-collapse:collapse;width:100%;">
        <tr>
          <th style="padding:0 12px 8px 0;color:#847866;font-size:12px;text-transform:uppercase;letter-spacing:0.08em;text-align:left;">Product</th>
          <th style="padding:0 12px 8px;color:#847866;font-size:12px;text-transform:uppercase;letter-spacing:0.08em;text-align:center;">Qty</th>
          <th style="padding:0 0 8px;color:#847866;font-size:12px;text-transform:uppercase;letter-spacing:0.08em;text-align:right;">Line total</th>
        </tr>
        ${itemRows}
        <tr>
          <td colspan="2" style="padding:12px 12px 0 0;color:#3A332C;font-size:15px;font-weight:bold;">Total</td>
          <td style="padding:12px 0 0;color:#3A332C;font-size:15px;font-weight:bold;text-align:right;white-space:nowrap;">${escapeHtml(formatEgp(order.totalEgp))}<br><span style="font-weight:normal;color:#847866;font-size:13px;">${escapeHtml(formatRub(order.totalRub))}</span></td>
        </tr>
      </table>
      <table style="border-collapse:collapse;width:100%;margin-top:24px;">
        ${row("Name", order.name)}
        ${row("Phone", order.phone)}
        ${row("Email", order.email || "—")}
        ${row("Address", order.address)}
        ${row("Note", order.note || "—")}
        ${row("Language", order.lang)}
      </table>
      <p style="margin:28px 0 0;color:#3A332C;font-size:15px;">Cash on delivery — contact the client on WhatsApp to confirm delivery time.</p>
    </div>
  </div>
</body>
</html>`;

  return { subject, text, html };
}

async function sendNotificationEmail(
  order: ValidatedOrder,
  orderNumber: string
): Promise<{ sent: boolean; sentCount: number; failedCount: number; reason?: string }> {
  const { subject, text, html } = buildEmail(order, orderNumber);
  const apiKey = process.env.RESEND_API_KEY;
  const recipients = (process.env.NOTIFY_EMAIL || NOTIFY_EMAIL_DEFAULT)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!apiKey) {
    // Graceful no-op: never break orders because email isn't configured.
    // Log one entry per recipient — mirrors the per-recipient real sends.
    for (const recipient of recipients) {
      console.log(
        `[order] RESEND_API_KEY not set — would email ${recipient}:\nSubject: ${subject}\n${text}`
      );
    }
    return {
      sent: false,
      sentCount: 0,
      failedCount: 0,
      reason: "email-not-configured",
    };
  }

  // One Resend call per recipient so a single bounced/rejected inbox can't
  // prevent the other owner address from being notified.
  const outcomes = await Promise.all(
    recipients.map(async (recipient): Promise<boolean> => {
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: EMAIL_FROM,
            to: [recipient],
            subject,
            text,
            html,
          }),
        });
        if (!res.ok) {
          const body = await res.text();
          console.error(
            `[order] Resend send to ${recipient} failed (${res.status}): ${body.slice(0, 300)}`
          );
          return false;
        }
        console.log(
          `[order] Notification email sent to ${recipient}: ${subject}`
        );
        return true;
      } catch (error) {
        console.error(`[order] Resend request error for ${recipient}:`, error);
        return false;
      }
    })
  );

  const sentCount = outcomes.filter(Boolean).length;
  const failedCount = outcomes.length - sentCount;
  return {
    sent: sentCount > 0,
    sentCount,
    failedCount,
    ...(sentCount === 0 ? { reason: "resend-failed-all-recipients" } : {}),
  };
}

// --- Buyer confirmation email ----------------------------------------------------

function buildBuyerEmail(
  order: ValidatedOrder,
  orderNumber: string
): {
  subject: string;
  text: string;
  html: string;
} {
  const ru = order.lang === "ru";
  const subject = ru
    ? `Ваш заказ ${orderNumber} — Victoria Vasilyeva Holistic Beauty`
    : `Your order ${orderNumber} — Victoria Vasilyeva Holistic Beauty`;

  const t = ru
    ? {
        greeting: `Здравствуйте, ${order.name}!`,
        orderNumber: `Номер заказа: ${orderNumber}`,
        thanks:
          "Спасибо за ваш заказ в Victoria Vasilyeva Holistic Beauty. Вот его детали:",
        heading: "Ваш заказ",
        product: "Товар",
        qty: "Кол-во",
        lineTotal: "Сумма",
        total: "Итого",
        cod: "Оплата при получении (наличными).",
        call: "Наша команда свяжется с вами в WhatsApp, чтобы подтвердить время доставки.",
        delivery: "Доставка по Египту в течение 24–72 часов.",
        signoff: "С теплом,",
      }
    : {
        greeting: `Hello ${order.name},`,
        orderNumber: `Order number: ${orderNumber}`,
        thanks:
          "Thank you for your order with Victoria Vasilyeva Holistic Beauty. Here are the details:",
        heading: "Your order",
        product: "Product",
        qty: "Qty",
        lineTotal: "Line total",
        total: "Total",
        cod: "Payment: cash on delivery.",
        call: "Our team will get in touch via WhatsApp to confirm your delivery time.",
        delivery: "Delivery within 24–72 hours across Egypt.",
        signoff: "Warmly,",
      };

  const productName = (l: OrderLine) =>
    ru ? l.product.ru.name : l.product.en.name;

  const textItems = order.lines.map(
    (l) =>
      `- ${productName(l)} × ${l.qty} = ${formatEgp(l.lineEgp)} / ${formatRub(l.lineRub)}`
  );
  const text = [
    t.greeting,
    "",
    t.orderNumber,
    "",
    t.thanks,
    "",
    ...textItems,
    "",
    `${t.total}: ${formatEgp(order.totalEgp)} / ${formatRub(order.totalRub)}`,
    "",
    t.cod,
    t.call,
    t.delivery,
    "",
    t.signoff,
    "Victoria Vasilyeva Holistic Beauty",
  ].join("\n");

  const itemRows = order.lines
    .map(
      (l) =>
        `<tr>` +
        `<td style="padding:8px 12px 8px 0;color:#3A332C;font-size:14px;border-bottom:1px solid #E5DCCB;">${escapeHtml(productName(l))}</td>` +
        `<td style="padding:8px 12px;color:#3A332C;font-size:14px;border-bottom:1px solid #E5DCCB;text-align:center;">${l.qty}</td>` +
        `<td style="padding:8px 0;color:#3A332C;font-size:14px;border-bottom:1px solid #E5DCCB;text-align:right;white-space:nowrap;">${escapeHtml(formatEgp(l.lineEgp))}<br><span style="color:#847866;font-size:13px;">${escapeHtml(formatRub(l.lineRub))}</span></td>` +
        `</tr>`
    )
    .join("");

  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background-color:#F4EFE7;font-family:Georgia,'Times New Roman',serif;">
  <div style="max-width:560px;margin:0 auto;padding:32px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;width:100%;">
      <tr>
        <td align="center" bgcolor="#100D0B" style="background-color:#100D0B;padding:24px;border-radius:16px 16px 0 0;">
          <img src="https://victoriaholisticbeauty.com/assets/logo-white.png" width="220" alt="Victoria Vasilyeva — Holistic Beauty" style="display:block;width:220px;max-width:100%;height:auto;border:0;margin:0 auto;" />
        </td>
      </tr>
    </table>
    <div style="background-color:#FFFDF9;border:1px solid #E5DCCB;border-top:0;border-radius:0 0 16px 16px;padding:32px;">
      <p style="margin:0 0 4px;color:#847866;font-size:12px;text-transform:uppercase;letter-spacing:0.2em;">Victoria Vasilyeva Holistic Beauty</p>
      <h1 style="margin:0 0 24px;color:#3A332C;font-size:26px;font-weight:normal;">${escapeHtml(t.heading)}</h1>
      <p style="margin:0 0 8px;color:#3A332C;font-size:15px;">${escapeHtml(t.greeting)}</p>
      <p style="margin:0 0 16px;color:#3A332C;font-size:16px;font-weight:bold;">${escapeHtml(t.orderNumber)}</p>
      <p style="margin:0 0 24px;color:#3A332C;font-size:15px;">${escapeHtml(t.thanks)}</p>
      <table style="border-collapse:collapse;width:100%;">
        <tr>
          <th style="padding:0 12px 8px 0;color:#847866;font-size:12px;text-transform:uppercase;letter-spacing:0.08em;text-align:left;">${escapeHtml(t.product)}</th>
          <th style="padding:0 12px 8px;color:#847866;font-size:12px;text-transform:uppercase;letter-spacing:0.08em;text-align:center;">${escapeHtml(t.qty)}</th>
          <th style="padding:0 0 8px;color:#847866;font-size:12px;text-transform:uppercase;letter-spacing:0.08em;text-align:right;">${escapeHtml(t.lineTotal)}</th>
        </tr>
        ${itemRows}
        <tr>
          <td colspan="2" style="padding:12px 12px 0 0;color:#3A332C;font-size:15px;font-weight:bold;">${escapeHtml(t.total)}</td>
          <td style="padding:12px 0 0;color:#3A332C;font-size:15px;font-weight:bold;text-align:right;white-space:nowrap;">${escapeHtml(formatEgp(order.totalEgp))}<br><span style="font-weight:normal;color:#847866;font-size:13px;">${escapeHtml(formatRub(order.totalRub))}</span></td>
        </tr>
      </table>
      <div style="margin-top:28px;padding:14px 16px;border:1px solid #E5DCCB;border-radius:10px;background-color:#F4EFE7;">
        <p style="margin:0;color:#3A332C;font-size:14px;line-height:1.65;">${escapeHtml(t.cod)}<br>${escapeHtml(t.call)}<br>${escapeHtml(t.delivery)}</p>
      </div>
      <p style="margin:28px 0 0;color:#847866;font-size:14px;">${escapeHtml(t.signoff)}<br>Victoria Vasilyeva Holistic Beauty</p>
    </div>
  </div>
</body>
</html>`;

  return { subject, text, html };
}

async function sendBuyerConfirmationEmail(
  order: ValidatedOrder,
  orderNumber: string
): Promise<{ sent: boolean; reason?: string }> {
  if (!order.email) {
    return { sent: false, reason: "no-buyer-email" };
  }
  const { subject, text, html } = buildBuyerEmail(order, orderNumber);
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    // Graceful no-op: never break orders because email isn't configured.
    console.log(
      `[order] RESEND_API_KEY not set — would email buyer ${order.email}:\nSubject: ${subject}\n${text}`
    );
    return { sent: false, reason: "email-not-configured" };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: BUYER_EMAIL_FROM,
        to: [order.email],
        reply_to: BUYER_REPLY_TO,
        subject,
        text,
        html,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(
        `[order] Buyer confirmation send failed (${res.status}): ${body.slice(0, 300)}`
      );
      return { sent: false, reason: `resend-${res.status}` };
    }
    console.log(
      `[order] Buyer confirmation email sent to ${order.email}: ${subject}`
    );
    return { sent: true };
  } catch (error) {
    console.error("[order] Buyer confirmation request error:", error);
    return { sent: false, reason: "resend-network-error" };
  }
}

// --- Handler --------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!isAllowedOrigin(origin)) {
    return NextResponse.json({ error: "Origin not allowed" }, { status: 403 });
  }
  const cors = corsHeaders(origin);

  if (isRateLimited(clientIp(request))) {
    return NextResponse.json(
      { error: "Too many requests. Please try again in a minute." },
      { status: 429, headers: cors }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400, headers: cors }
    );
  }

  // Dynamic catalog — names, prices and stock all come from here. A read
  // failure is a hard error: validating prices/stock against stale guesses
  // would be worse than asking the buyer to retry.
  let catalog: Product[];
  try {
    catalog = await getCatalog();
  } catch (error) {
    console.error("[order] Catalog read failed:", error);
    return NextResponse.json(
      { error: "The shop is temporarily unavailable. Please try again shortly." },
      { status: 503, headers: cors }
    );
  }

  const result = validateOrder(body, catalog);
  if (!result.ok) {
    return NextResponse.json(
      { error: "Validation failed", fields: result.fields },
      { status: 400, headers: cors }
    );
  }

  const orderNumber = generateOrderNumber();

  // Decrement tracked stock now that the order is accepted. Read-modify-write
  // with tolerable races at this volume; a failure here must never fail the
  // order — Victoria reconciles stock from the admin panel if it ever drifts.
  try {
    await decrementQuantities(
      result.order.lines.map((l) => ({ slug: l.product.slug, qty: l.qty }))
    );
  } catch (error) {
    console.error(`[order] Stock decrement failed for ${orderNumber}:`, error);
  }

  // Persist to Vercel Blob FIRST so the admin inbox sees the order even if
  // both mailers fail. A Blob failure must never fail the order either —
  // Victoria still gets the notification email with all details.
  let stored = false;
  try {
    const createdAt = new Date().toISOString();
    const record: StoredOrder = {
      orderNumber,
      createdAt,
      status: "ordered",
      items: result.order.lines.map((l) => ({
        slug: l.product.slug,
        qty: l.qty,
        names: { en: l.product.en.name, ru: l.product.ru.name },
        lineTotals: { egp: l.lineEgp, rub: l.lineRub },
      })),
      totals: { egp: result.order.totalEgp, rub: result.order.totalRub },
      name: result.order.name,
      phone: result.order.phone,
      email: result.order.email,
      address: result.order.address,
      note: result.order.note,
      lang: result.order.lang,
      statusHistory: [{ status: "ordered", at: createdAt }],
    };
    await saveOrder(record);
    stored = true;
  } catch (error) {
    console.error(`[order] Blob persistence failed for ${orderNumber}:`, error);
  }

  // Mailer failures must never fail the order — respond 200 with emailed:false.
  // The buyer confirmation is fully independent of Victoria's notification:
  // each has its own try/catch, and both outcomes are reported separately.
  const emailResult = await sendNotificationEmail(result.order, orderNumber);
  const buyerEmailResult = await sendBuyerConfirmationEmail(
    result.order,
    orderNumber
  );

  return NextResponse.json(
    {
      received: true,
      orderNumber,
      stored,
      emailed: emailResult.sent,
      ownerEmails: {
        sent: emailResult.sentCount,
        failed: emailResult.failedCount,
      },
      buyerEmailed: buyerEmailResult.sent,
    },
    { headers: cors }
  );
}
