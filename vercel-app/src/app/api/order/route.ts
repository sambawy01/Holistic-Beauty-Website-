import { NextRequest, NextResponse } from "next/server";
import { corsHeaders, isAllowedOrigin } from "@/lib/cors";
import {
  PRODUCTS_BY_SLUG,
  formatEgp,
  formatRub,
  type ShopProduct,
} from "@/lib/shop-products";

export const runtime = "nodejs";

/**
 * POST /api/order — cash-on-delivery product orders from the static shop.
 *
 * Trust model:
 * - The catalog (names + prices) lives server-side in @/lib/shop-products.
 *   Totals are always computed here; any client-supplied totals are ignored.
 * - Same CORS allowlist as /api/chat; per-IP in-memory rate limit.
 * - Owner notification via Resend (same pattern as /api/cal/webhook), with a
 *   graceful console-log no-op when RESEND_API_KEY is unset. A mailer failure
 *   never 500s the order — the client still gets { received: true }.
 */

const NOTIFY_EMAIL_DEFAULT = "victoria@victoriaholisticbeauty.com";
const EMAIL_FROM =
  "Victoria Holistic Beauty <orders@victoriaholisticbeauty.com>";

const MAX_DISTINCT_ITEMS = 8;
const MAX_QTY = 10;
const PHONE_RE = /^\+?[0-9\s\-()]{8,17}$/;

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
  product: ShopProduct;
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
  address: string;
  note: string;
  lang: "en" | "ru";
}

function validateOrder(
  body: unknown
): { ok: true; order: ValidatedOrder } | { ok: false; fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  const b = (body ?? {}) as Record<string, unknown>;

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
      if (typeof item.slug !== "string" || !PRODUCTS_BY_SLUG.has(item.slug)) {
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
      seen.add(item.slug);
      const product = PRODUCTS_BY_SLUG.get(item.slug)!;
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
      address,
      note,
      lang: b.lang as "en" | "ru",
    },
  };
}

// --- Notification email --------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildEmail(order: ValidatedOrder): {
  subject: string;
  text: string;
  html: string;
} {
  const subject = `New shop order — ${order.name} · ${order.totalEgp} EGP (COD)`;

  const textItems = order.lines.map(
    (l) =>
      `- ${l.product.nameEn} / ${l.product.nameRu} × ${l.qty} = ${formatEgp(l.lineEgp)} / ${formatRub(l.lineRub)}`
  );
  const text = [
    "New shop order (cash on delivery)",
    "",
    "Items:",
    ...textItems,
    "",
    `Total:    ${formatEgp(order.totalEgp)} / ${formatRub(order.totalRub)}`,
    "",
    `Name:     ${order.name}`,
    `Phone:    ${order.phone}`,
    `Address:  ${order.address}`,
    `Note:     ${order.note || "—"}`,
    `Language: ${order.lang}`,
    "",
    "Cash on delivery — call the client to confirm.",
  ].join("\n");

  const itemRows = order.lines
    .map(
      (l) =>
        `<tr>` +
        `<td style="padding:8px 12px 8px 0;color:#3A332C;font-size:14px;border-bottom:1px solid #E5DCCB;">${escapeHtml(l.product.nameEn)}<br><span style="color:#847866;font-size:13px;">${escapeHtml(l.product.nameRu)}</span></td>` +
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
      <h1 style="margin:0 0 24px;color:#3A332C;font-size:26px;font-weight:normal;">New shop order</h1>
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
        ${row("Address", order.address)}
        ${row("Note", order.note || "—")}
        ${row("Language", order.lang)}
      </table>
      <p style="margin:28px 0 0;color:#3A332C;font-size:15px;">Cash on delivery — call the client to confirm.</p>
    </div>
  </div>
</body>
</html>`;

  return { subject, text, html };
}

async function sendNotificationEmail(
  order: ValidatedOrder
): Promise<{ sent: boolean; reason?: string }> {
  const { subject, text, html } = buildEmail(order);
  const apiKey = process.env.RESEND_API_KEY;
  const to = (process.env.NOTIFY_EMAIL || NOTIFY_EMAIL_DEFAULT)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!apiKey) {
    // Graceful no-op: never break orders because email isn't configured.
    console.log(
      `[order] RESEND_API_KEY not set — would email ${to}:\nSubject: ${subject}\n${text}`
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
      body: JSON.stringify({ from: EMAIL_FROM, to, subject, text, html }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(
        `[order] Resend send failed (${res.status}): ${body.slice(0, 300)}`
      );
      return { sent: false, reason: `resend-${res.status}` };
    }
    console.log(`[order] Notification email sent to ${to}: ${subject}`);
    return { sent: true };
  } catch (error) {
    console.error("[order] Resend request error:", error);
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

  const result = validateOrder(body);
  if (!result.ok) {
    return NextResponse.json(
      { error: "Validation failed", fields: result.fields },
      { status: 400, headers: cors }
    );
  }

  // Mailer failures must never fail the order — respond 200 with emailed:false.
  const emailResult = await sendNotificationEmail(result.order);

  return NextResponse.json(
    { received: true, emailed: emailResult.sent },
    { headers: cors }
  );
}
