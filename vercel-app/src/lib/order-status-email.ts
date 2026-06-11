import { formatEgp, formatRub } from "@/lib/shop-products";
import type { StoredOrder, StoredOrderItem } from "@/lib/orders";

/**
 * Client-facing status emails for shop orders (shipped / delivered).
 *
 * Mirrors the buyer-confirmation email in /api/order: same dark logo band
 * header, same earthy palette, same Resend REST pattern. Lang-aware (en/ru)
 * from the order's stored `lang`. Sent from bookings@ with reply-to
 * victoria@ so replies land in Victoria's inbox.
 *
 * Failure model: `sendOrderStatusEmail` never throws — a mail failure must
 * never roll back or fail the status update. Callers get { sent, reason? }.
 */

const EMAIL_FROM =
  "Victoria Vasilyeva Holistic Beauty <bookings@victoriaholisticbeauty.com>";
const REPLY_TO = "victoria@victoriaholisticbeauty.com";

type EmailStatus = "shipped" | "delivered";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface StatusCopy {
  subject: string;
  heading: string;
  greeting: string;
  paragraphs: string[];
  recapTitle: string;
  product: string;
  qty: string;
  lineTotal: string;
  total: string;
  footnote: string | null;
  signoff: string;
}

function copyFor(order: StoredOrder, status: EmailStatus): StatusCopy {
  const ru = order.lang === "ru";
  const n = order.orderNumber;

  if (status === "shipped") {
    return ru
      ? {
          subject: `Ваш заказ ${n} в пути`,
          heading: "Заказ отправлен",
          greeting: `Здравствуйте, ${order.name}!`,
          paragraphs: [
            `Хорошие новости — ваш заказ ${n} отправлен. Наша команда свяжется с вами в WhatsApp, чтобы подтвердить время доставки. Оплата при получении (наличными).`,
          ],
          recapTitle: "Состав заказа",
          product: "Товар",
          qty: "Кол-во",
          lineTotal: "Сумма",
          total: "Итого",
          footnote: "Доставка по Египту в течение 24–72 часов.",
          signoff: "С теплом,",
        }
      : {
          subject: `Your order ${n} is on its way`,
          heading: "Your order has shipped",
          greeting: `Hello ${order.name},`,
          paragraphs: [
            `Good news — your order ${n} has been shipped. Our team will contact you via WhatsApp to confirm the delivery time. Payment cash on delivery.`,
          ],
          recapTitle: "Order recap",
          product: "Product",
          qty: "Qty",
          lineTotal: "Line total",
          total: "Total",
          footnote: "Delivery within 24–72 hours across Egypt.",
          signoff: "Warmly,",
        };
  }

  return ru
    ? {
        subject: `Ваш заказ ${n} доставлен`,
        heading: "Заказ доставлен",
        greeting: `Здравствуйте, ${order.name}!`,
        paragraphs: [
          `Спасибо за ваш заказ ${n} в Victoria Vasilyeva Holistic Beauty!`,
          "Надеемся, вам понравятся ваши средства. За советами по их использованию обращайтесь к Василию на нашем сайте или напишите нам.",
        ],
        recapTitle: "Состав заказа",
        product: "Товар",
        qty: "Кол-во",
        lineTotal: "Сумма",
        total: "Итого",
        footnote: null,
        signoff: "С теплом,",
      }
    : {
        subject: `Your order ${n} has been delivered`,
        heading: "Your order has been delivered",
        greeting: `Hello ${order.name},`,
        paragraphs: [
          `Thank you for your order ${n} with Victoria Vasilyeva Holistic Beauty!`,
          "We hope you love your products. For advice on using them, ask Vassili on our website or write to us.",
        ],
        recapTitle: "Order recap",
        product: "Product",
        qty: "Qty",
        lineTotal: "Line total",
        total: "Total",
        footnote: null,
        signoff: "Warmly,",
      };
}

export function buildOrderStatusEmail(
  order: StoredOrder,
  status: EmailStatus
): { subject: string; text: string; html: string } {
  const t = copyFor(order, status);
  const ru = order.lang === "ru";
  const itemName = (item: StoredOrderItem) =>
    ru ? item.names.ru : item.names.en;

  const textItems = order.items.map(
    (item) =>
      `- ${itemName(item)} × ${item.qty} = ${formatEgp(item.lineTotals.egp)} / ${formatRub(item.lineTotals.rub)}`
  );
  const text = [
    t.greeting,
    "",
    ...t.paragraphs,
    "",
    `${t.recapTitle}:`,
    ...textItems,
    "",
    `${t.total}: ${formatEgp(order.totals.egp)} / ${formatRub(order.totals.rub)}`,
    ...(t.footnote ? ["", t.footnote] : []),
    "",
    t.signoff,
    "Victoria Vasilyeva Holistic Beauty",
  ].join("\n");

  const itemRows = order.items
    .map(
      (item) =>
        `<tr>` +
        `<td style="padding:8px 12px 8px 0;color:#3A332C;font-size:14px;border-bottom:1px solid #E5DCCB;">${escapeHtml(itemName(item))}</td>` +
        `<td style="padding:8px 12px;color:#3A332C;font-size:14px;border-bottom:1px solid #E5DCCB;text-align:center;">${item.qty}</td>` +
        `<td style="padding:8px 0;color:#3A332C;font-size:14px;border-bottom:1px solid #E5DCCB;text-align:right;white-space:nowrap;">${escapeHtml(formatEgp(item.lineTotals.egp))}<br><span style="color:#847866;font-size:13px;">${escapeHtml(formatRub(item.lineTotals.rub))}</span></td>` +
        `</tr>`
    )
    .join("");

  const paragraphsHtml = t.paragraphs
    .map(
      (p) =>
        `<p style="margin:0 0 16px;color:#3A332C;font-size:15px;line-height:1.65;">${escapeHtml(p)}</p>`
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
      ${paragraphsHtml}
      <table style="border-collapse:collapse;width:100%;margin-top:8px;">
        <tr>
          <th style="padding:0 12px 8px 0;color:#847866;font-size:12px;text-transform:uppercase;letter-spacing:0.08em;text-align:left;">${escapeHtml(t.product)}</th>
          <th style="padding:0 12px 8px;color:#847866;font-size:12px;text-transform:uppercase;letter-spacing:0.08em;text-align:center;">${escapeHtml(t.qty)}</th>
          <th style="padding:0 0 8px;color:#847866;font-size:12px;text-transform:uppercase;letter-spacing:0.08em;text-align:right;">${escapeHtml(t.lineTotal)}</th>
        </tr>
        ${itemRows}
        <tr>
          <td colspan="2" style="padding:12px 12px 0 0;color:#3A332C;font-size:15px;font-weight:bold;">${escapeHtml(t.total)}</td>
          <td style="padding:12px 0 0;color:#3A332C;font-size:15px;font-weight:bold;text-align:right;white-space:nowrap;">${escapeHtml(formatEgp(order.totals.egp))}<br><span style="font-weight:normal;color:#847866;font-size:13px;">${escapeHtml(formatRub(order.totals.rub))}</span></td>
        </tr>
      </table>
      ${
        t.footnote
          ? `<div style="margin-top:28px;padding:14px 16px;border:1px solid #E5DCCB;border-radius:10px;background-color:#F4EFE7;"><p style="margin:0;color:#3A332C;font-size:14px;line-height:1.65;">${escapeHtml(t.footnote)}</p></div>`
          : ""
      }
      <p style="margin:28px 0 0;color:#847866;font-size:14px;">${escapeHtml(t.signoff)}<br>Victoria Vasilyeva Holistic Beauty</p>
    </div>
  </div>
</body>
</html>`;

  return { subject: t.subject, text, html };
}

/**
 * Send the status email to the order's buyer. Never throws.
 * Returns { sent: false, reason: "no-buyer-email" } for phone-only orders.
 */
export async function sendOrderStatusEmail(
  order: StoredOrder,
  status: EmailStatus
): Promise<{ sent: boolean; reason?: string }> {
  if (!order.email) {
    return { sent: false, reason: "no-buyer-email" };
  }

  const { subject, text, html } = buildOrderStatusEmail(order, status);
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    // Graceful no-op: never block status updates because email isn't configured.
    console.log(
      `[orders] RESEND_API_KEY not set — would email ${order.email}:\nSubject: ${subject}\n${text}`
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
        from: EMAIL_FROM,
        to: [order.email],
        reply_to: REPLY_TO,
        subject,
        text,
        html,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(
        `[orders] Status email (${status}) to ${order.email} failed (${res.status}): ${body.slice(0, 300)}`
      );
      return { sent: false, reason: `resend-${res.status}` };
    }
    console.log(
      `[orders] Status email (${status}) sent to ${order.email}: ${subject}`
    );
    return { sent: true };
  } catch (error) {
    console.error(`[orders] Status email (${status}) request error:`, error);
    return { sent: false, reason: "resend-network-error" };
  }
}
