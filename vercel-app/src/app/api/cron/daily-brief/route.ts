import { NextRequest, NextResponse } from "next/server";
import {
  buildDailyBriefEmail,
  cairoHourNow,
  sendDailyBriefEmail,
} from "@/lib/daily-brief-email";
import { gatherDailyBriefData } from "@/lib/daily-brief-data";
import { cronAuthError } from "@/lib/reports/shared";
import { getOwnerChatId } from "@/lib/assistant/state";
import { sendMessage, telegramConfigured } from "@/lib/telegram";

/**
 * Daily 8am-Cairo brief to Victoria — GET, triggered by Vercel Cron.
 *
 * Auth: Vercel invokes cron routes with `Authorization: Bearer ${CRON_SECRET}`
 * whenever the CRON_SECRET env var exists on the project. We require it and
 * fail closed (401 when CRON_SECRET is unset or the header mismatches).
 *
 * DST-proofing: Cairo flips between UTC+2 and UTC+3, but Vercel cron schedules
 * are fixed UTC. vercel.json therefore fires this route at BOTH 05:00 and
 * 06:00 UTC, and this guard only proceeds when the current Africa/Cairo hour
 * is exactly 8 — one firing sends, the other returns {skipped}.
 *
 * Testing escape hatch: `?force=1` bypasses the hour guard, but ONLY outside
 * production (NODE_ENV check) — the schedule can never be forced in prod.
 *
 * Data failures are soft: if Cal or Blob is down the brief still goes out
 * with a "couldn't load X" note, so Victoria always gets her morning email.
 */

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  // --- auth: fail closed, constant-time (shared cron helper) ---------------
  const unauthorized = cronAuthError(request);
  if (unauthorized) return unauthorized;

  // --- 8am-Cairo guard ------------------------------------------------------
  const force =
    process.env.NODE_ENV !== "production" &&
    request.nextUrl.searchParams.get("force") === "1";
  const cairoHour = cairoHourNow();
  if (!force && cairoHour !== 8) {
    return NextResponse.json({ skipped: "not 8am Cairo", cairoHour });
  }

  // --- gather data (fail-soft per source, shared with Vassili's daily_brief) --
  const { bookings, orders, rebookingDue, failures } =
    await gatherDailyBriefData();

  // --- build + send -----------------------------------------------------------
  const brief = buildDailyBriefEmail({
    bookings,
    orders,
    rebookingDue,
    failures,
  });
  const result = await sendDailyBriefEmail(brief);

  // --- Telegram push (best effort, never fatal) --------------------------------
  // When the bot is configured AND Victoria has bound her chat, the same
  // brief text lands in Telegram. Any failure here must not affect the email
  // path that has already completed.
  let telegram: { sent: boolean; reason?: string } = { sent: false };
  if (telegramConfigured()) {
    try {
      const ownerChatId = await getOwnerChatId();
      if (ownerChatId !== null) {
        const sent = await sendMessage(ownerChatId, brief.text);
        telegram = sent.ok
          ? { sent: true }
          : { sent: false, reason: `telegram-${sent.status}` };
      } else {
        telegram = { sent: false, reason: "no-owner-bound" };
      }
    } catch (error) {
      console.error("[daily-brief] Telegram push failed:", error);
      telegram = { sent: false, reason: "telegram-error" };
    }
  } else {
    telegram = { sent: false, reason: "telegram-not-configured" };
  }

  return NextResponse.json({
    ok: true,
    cairoHour,
    forced: force,
    subject: brief.subject,
    counts: brief.counts,
    failures,
    email: result,
    telegram,
  });
}
