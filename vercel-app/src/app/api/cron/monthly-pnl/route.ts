import { NextRequest, NextResponse } from "next/server";
import { cairoDateKey, cairoHourNow } from "@/lib/daily-brief-email";
import {
  claimDailySend,
  cronAuthError,
  isForced,
  pushOwnerTelegram,
  sendReportEmail,
} from "@/lib/reports/shared";
import {
  buildPnL,
  pnlFilename,
  pnlToLetterheadBody,
  previousMonthPeriod,
} from "@/lib/finance-report";
import { renderLetterheadPdf } from "@/lib/assistant/letterhead-pdf";
import { brandedEmailHtml } from "@/lib/branded-email";
import { getOwnerChatId } from "@/lib/assistant/state";
import { sendDocument, telegramConfigured } from "@/lib/telegram";

/**
 * Monthly Profit & Loss — 1st of the month, 09:00 Africa/Cairo
 * (.github/workflows/cron-monthly-pnl.yml).
 *
 * Auth: Bearer CRON_SECRET, fail closed.
 *
 * DST-proofing: the workflow fires on the 1st at BOTH 06:00 and 07:00 UTC;
 * this guard only proceeds when the Cairo wall clock is day-of-month 1 AND
 * hour 9 — normally one firing runs, the other returns {skipped}. The guard
 * alone is not airtight (60-minute-plus Actions delays, a prod dispatch), so
 * the route ALSO claims a per-day sent marker before sending. `?force=1`
 * bypasses the guard outside production only.
 *
 * Content: the PREVIOUS calendar month's P&L (revenue = shop orders +
 * treatments + cash/other income; expenses by category; net), rendered on the
 * company letterhead and (a) emailed to NOTIFY_EMAIL as an attachment and
 * (b) pushed to Victoria's Telegram as a short summary + the PDF document.
 */

export const dynamic = "force-dynamic";

function summaryText(label: string, net: number, revenue: number, expenses: number): string {
  return [
    `Monthly P&L — ${label} (Cairo time).`,
    "",
    `Revenue: ${revenue} EGP`,
    `Expenses: ${expenses} EGP`,
    `Net ${net >= 0 ? "profit" : "loss"}: ${Math.abs(net)} EGP`,
    "",
    "The full statement is attached as a PDF.",
    "— your booking assistant",
  ].join("\n");
}

export async function GET(request: NextRequest) {
  const unauthorized = cronAuthError(request);
  if (unauthorized) return unauthorized;

  const force = isForced(request);
  const cairoDay = cairoDateKey(new Date()).slice(8, 10);
  const cairoHour = cairoHourNow();
  if (!force && !(cairoDay === "01" && cairoHour === 9)) {
    return NextResponse.json({
      skipped: "not the 1st at 09:00 Cairo",
      cairoDay,
      cairoHour,
    });
  }

  // Double-fire guard: claim today's marker (fail closed; force bypasses).
  if (!force) {
    const claim = await claimDailySend("monthly-pnl", cairoDateKey(new Date()));
    if (claim === "already-sent") {
      return NextResponse.json({
        ok: true,
        cairoDay,
        cairoHour,
        skipped: "already sent today (day marker)",
      });
    }
    if (claim === "error") {
      return NextResponse.json(
        {
          ok: false,
          cairoDay,
          cairoHour,
          error:
            "day-marker claim failed (Blob error, not a conflict) — P&L NOT sent this firing; retry via workflow_dispatch once Blob recovers",
        },
        { status: 500 }
      );
    }
  }

  const period = previousMonthPeriod();
  const pnl = await buildPnL(period);

  // Render the letterhead PDF (never fatal to the rest of the job).
  let pdf: Buffer | null = null;
  try {
    const rendered = await renderLetterheadPdf({
      title: `Profit & Loss — ${period.label}`,
      body: pnlToLetterheadBody(pnl),
    });
    pdf = rendered.pdf;
  } catch (error) {
    console.error("[monthly-pnl] PDF render failed:", error);
  }

  const text = summaryText(
    period.label,
    pnl.netEgp,
    pnl.revenue.totalEgp,
    pnl.expenses.totalEgp
  );
  const html = brandedEmailHtml({
    heading: `Monthly P&L — ${period.label}`,
    contentHtml: text
      .split("\n")
      .map(
        (line) =>
          `<p style="margin:0 0 8px;color:#3A332C;font-size:15px;line-height:1.6;">${line || "&nbsp;"}</p>`
      )
      .join(""),
    belowCardHtml:
      "Revenue counts confirmed/shipped/delivered shop orders and confirmed treatment bookings, plus any cash/other income you logged.",
  });

  const filename = `${pnlFilename(pnl)}.pdf`;
  const email = await sendReportEmail(
    {
      subject: `Monthly P&L — ${period.label}`,
      text,
      html,
      ...(pdf
        ? {
            attachments: [
              { filename, contentBase64: pdf.toString("base64") },
            ],
          }
        : {}),
    },
    "monthly-pnl"
  );

  // Telegram: short summary text + the PDF document to the bound owner.
  const telegram = await pushOwnerTelegram(text, "monthly-pnl");
  let documentSent = false;
  if (pdf && telegramConfigured()) {
    try {
      const ownerChatId = await getOwnerChatId();
      if (ownerChatId !== null) {
        const sent = await sendDocument(ownerChatId, filename, pdf, {
          caption: `P&L — ${period.label}`,
        });
        documentSent = sent.ok;
      }
    } catch (error) {
      console.error("[monthly-pnl] Telegram document send failed:", error);
    }
  }

  // Delivered on NO channel → loud 500 (the workflow's jq filter surfaces
  // `error` and the run goes red). The day marker stands either way.
  if (email.sentCount === 0 && !telegram.sent && !documentSent) {
    return NextResponse.json(
      {
        ok: false,
        cairoDay,
        cairoHour,
        forced: force,
        period: period.label,
        email,
        telegram,
        error:
          "monthly P&L delivered on NO channel (email and telegram both failed); day marker stands — no automatic retry",
      },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    cairoDay,
    cairoHour,
    forced: force,
    period: period.label,
    net: pnl.netEgp,
    revenue: pnl.revenue.totalEgp,
    expenses: pnl.expenses.totalEgp,
    failures: pnl.failures,
    email,
    telegram,
    documentSent,
  });
}
