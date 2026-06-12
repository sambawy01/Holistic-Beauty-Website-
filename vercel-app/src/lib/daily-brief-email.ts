import { brandedEmailHtml, escapeHtml } from "./branded-email";
import type { CalBooking } from "./admin/cal";
import type { StoredOrder } from "./orders";

/**
 * Victoria's 8am-Cairo daily brief, sent from /api/cron/daily-brief.
 *
 * One branded email (English — Victoria's ops language, matching /admin):
 * - "Today's appointments": confirmed bookings starting TODAY in Cairo,
 *   sorted by time — time · service · client · phone (+ notes/treatments).
 * - "Pending booking requests": ALL upcoming pending requests (not just
 *   today's — each is date-stamped and flagged "awaiting your confirmation";
 *   a request for tomorrow still needs action this morning), with the
 *   /admin inbox link.
 * - "Shop orders needing action": orders still in ordered/confirmed status.
 *
 * Sent even when everything is empty ("Nothing scheduled today — enjoy the
 * calm.") so a missing brief always means a delivery problem, never an empty
 * day. Per-recipient Resend sends, same as the other owner emails.
 */

const NOTIFY_EMAIL_DEFAULT = "victoria@victoriaholisticbeauty.com";
const ADMIN_URL_BASE = "https://book.victoriaholisticbeauty.com/admin";
const EMAIL_FROM = "Victoria Holistic Beauty <bookings@victoriaholisticbeauty.com>";
const CAIRO_TZ = "Africa/Cairo";

// --- Cairo time helpers ------------------------------------------------------

/** "YYYY-MM-DD" calendar date of an instant, in Cairo. */
export function cairoDateKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CAIRO_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Current hour-of-day (0–23) in Cairo — the DST-proof cron guard. */
export function cairoHourNow(now: Date = new Date()): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: CAIRO_TZ,
      hour: "numeric",
      hourCycle: "h23",
    }).format(now)
  );
}

/** "Thu 12 Jun" — subject-line date in Cairo. */
function cairoSubjectDate(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: CAIRO_TZ,
    weekday: "short",
    day: "numeric",
    month: "short",
  })
    .format(date)
    .replace(",", "");
}

/** "15:00" in Cairo. */
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

/** "Thu 18 Jun 15:00" in Cairo — for pending requests on other days. */
function cairoDayAndClock(iso: string): string {
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

// --- booking field extraction --------------------------------------------------

/**
 * Cal booking titles read "Facial Massage between Victoria Vasilyeva and X" —
 * the brief line already shows the client, so keep just the service part.
 */
function serviceTitle(booking: CalBooking): string {
  const title = booking.title || "Booking";
  const idx = title.indexOf(" between ");
  return idx > 0 ? title.slice(0, idx) : title;
}

function bookingField(booking: CalBooking, field: string): string {
  const value = booking.bookingFieldsResponses?.[field];
  return typeof value === "string" ? value.trim() : "";
}

function bookingPhone(booking: CalBooking): string {
  return bookingField(booking, "attendeePhoneNumber") || "no phone";
}

function bookingNotes(booking: CalBooking): string {
  const notes = bookingField(booking, "notes");
  return notes === "No additional notes provided" ? "" : notes;
}

// --- brief assembly -----------------------------------------------------------

/**
 * A client surfaced by the re-booking radar (CRM) — kept as a minimal local
 * shape so this email module never imports the CRM (and its Blob SDK).
 */
export interface BriefRebookingClient {
  displayName: string;
  lastTreatment: string;
  overdueWeeks: number;
}

export interface DailyBriefInput {
  /** All bookings from GET /bookings?status=upcoming,unconfirmed. */
  bookings: CalBooking[];
  /** All stored shop orders (any status — filtered here). */
  orders: StoredOrder[];
  /**
   * Clients due for a re-booking check-in (CRM radar) — ADDITIVE: when absent
   * or empty the brief renders exactly as before. Surfaced like pending
   * requests (a gentle nudge), never noise — only shown when non-empty.
   */
  rebookingDue?: BriefRebookingClient[];
  /** Data sources that failed to load — surfaced in the email. */
  failures: string[];
  /** "Now" — injectable for tests. */
  now?: Date;
}

export interface DailyBrief {
  subject: string;
  text: string;
  html: string;
  counts: {
    appointments: number;
    pending: number;
    orders: number;
    rebooking: number;
  };
}

export function buildDailyBriefEmail(input: DailyBriefInput): DailyBrief {
  const now = input.now ?? new Date();
  const todayKey = cairoDateKey(now);

  const confirmedToday = input.bookings
    .filter(
      (b) =>
        (b.status || "").toLowerCase() === "accepted" &&
        cairoDateKey(new Date(b.start)) === todayKey
    )
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  const pending = input.bookings
    .filter((b) => (b.status || "").toLowerCase() === "pending")
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  const openOrders = input.orders.filter(
    (o) => o.status === "ordered" || o.status === "confirmed"
  );

  // Re-booking radar (CRM) — top few, most overdue first. Additive: an empty
  // list renders nothing and never changes the existing brief.
  const rebookingDue = (input.rebookingDue ?? [])
    .slice()
    .sort((a, b) => b.overdueWeeks - a.overdueWeeks);
  const topRebooking = rebookingDue.slice(0, 5);

  const adminToken = process.env.ADMIN_TOKEN || "";
  const adminLink = adminToken
    ? `${ADMIN_URL_BASE}?key=${encodeURIComponent(adminToken)}`
    : ADMIN_URL_BASE;

  const subjectDate = cairoSubjectDate(now);
  const apptCount = confirmedToday.length;
  const subject =
    apptCount > 0
      ? `Your day — ${subjectDate}: ${apptCount} appointment${apptCount === 1 ? "" : "s"}`
      : `Your day — ${subjectDate}: no appointments today`;

  const emptyDay =
    apptCount === 0 &&
    pending.length === 0 &&
    openOrders.length === 0 &&
    topRebooking.length === 0;

  // --- text part -------------------------------------------------------------
  const textLines: string[] = [`Good morning! Your day — ${subjectDate}.`, ""];

  if (input.failures.length) {
    textLines.push(
      `Heads up: couldn't load ${input.failures.join(" and ")} — the sections below may be incomplete.`,
      ""
    );
  }

  if (emptyDay) {
    textLines.push("Nothing scheduled today — enjoy the calm.");
  } else {
    textLines.push("Today's appointments");
    if (apptCount === 0) {
      textLines.push("  A quiet day — no confirmed appointments today.");
    } else {
      for (const b of confirmedToday) {
        const notes = bookingNotes(b);
        textLines.push(
          `  ${cairoClock(b.start)} · ${serviceTitle(b)} · ${b.attendees?.[0]?.name || "Unknown"} · ${bookingPhone(b)}`
        );
        if (notes) textLines.push(`         ${notes}`);
      }
    }

    textLines.push("", `Pending booking requests (${pending.length})`);
    if (pending.length === 0) {
      textLines.push("  None — your inbox is clear.");
    } else {
      for (const b of pending) {
        textLines.push(
          `  ${cairoDayAndClock(b.start)} · ${serviceTitle(b)} · ${b.attendees?.[0]?.name || "Unknown"} — awaiting your confirmation`
        );
      }
      textLines.push(`  Review them here: ${adminLink}`);
    }

    textLines.push("", `Shop orders needing action (${openOrders.length})`);
    if (openOrders.length === 0) {
      textLines.push("  None — all orders are on their way or delivered.");
    } else {
      for (const o of openOrders) {
        const items = o.items
          .map((i) => `${i.qty}× ${i.names.en}`)
          .join(", ");
        textLines.push(
          `  ${o.orderNumber} (${o.status}) · ${o.name} · ${o.phone} · ${o.totals.egp} EGP — ${items}`
        );
      }
      textLines.push(`  Manage orders here: ${adminLink}`);
    }

    if (topRebooking.length > 0) {
      textLines.push(
        "",
        `Clients due for a check-in (${rebookingDue.length})`
      );
      for (const c of topRebooking) {
        const last = c.lastTreatment ? `last ${c.lastTreatment}, ` : "";
        textLines.push(
          `  ${c.displayName} — ${last}${c.overdueWeeks}+ weeks since last visit, nothing booked`
        );
      }
      if (rebookingDue.length > topRebooking.length) {
        textLines.push(
          `  …and ${rebookingDue.length - topRebooking.length} more — see the Clients tab: ${adminLink}`
        );
      } else {
        textLines.push(`  See the Clients tab: ${adminLink}`);
      }
    }
  }

  textLines.push("", "Have a wonderful day!", "— your booking assistant");
  const text = textLines.join("\n");

  // --- html part ---------------------------------------------------------------
  const sectionTitle = (title: string) =>
    `<p style="margin:28px 0 8px;color:#847866;font-size:13px;text-transform:uppercase;letter-spacing:0.12em;">${escapeHtml(title)}</p>`;

  const line = (content: string, muted = false) =>
    `<p style="margin:0 0 8px;color:${muted ? "#847866" : "#3A332C"};font-size:15px;line-height:1.6;">${content}</p>`;

  const adminButton = (label: string) =>
    `<p style="margin:12px 0 0;"><a href="${adminLink}" style="display:inline-block;background-color:#3A332C;color:#FFFDF9;text-decoration:none;padding:10px 24px;border-radius:9999px;font-size:14px;">${escapeHtml(label)}</a></p>`;

  let contentHtml = "";

  if (input.failures.length) {
    contentHtml += `<div style="margin:0 0 16px;padding:12px 16px;border:1px solid #E5DCCB;border-radius:10px;background-color:#F4EFE7;"><p style="margin:0;color:#3A332C;font-size:14px;">Heads up: couldn't load ${escapeHtml(input.failures.join(" and "))} — the sections below may be incomplete.</p></div>`;
  }

  if (emptyDay) {
    contentHtml += line("Nothing scheduled today — enjoy the calm.");
  } else {
    contentHtml += sectionTitle("Today's appointments");
    if (apptCount === 0) {
      contentHtml += line("A quiet day — no confirmed appointments today.", true);
    } else {
      for (const b of confirmedToday) {
        const notes = bookingNotes(b);
        contentHtml += line(
          `<strong>${escapeHtml(cairoClock(b.start))}</strong> · ${escapeHtml(serviceTitle(b))} · ${escapeHtml(b.attendees?.[0]?.name || "Unknown")} · ${escapeHtml(bookingPhone(b))}` +
            (notes
              ? `<br><span style="color:#847866;font-size:14px;">${escapeHtml(notes)}</span>`
              : "")
        );
      }
    }

    contentHtml += sectionTitle(`Pending booking requests (${pending.length})`);
    if (pending.length === 0) {
      contentHtml += line("None — your inbox is clear.", true);
    } else {
      for (const b of pending) {
        contentHtml += line(
          `${escapeHtml(cairoDayAndClock(b.start))} · ${escapeHtml(serviceTitle(b))} · ${escapeHtml(b.attendees?.[0]?.name || "Unknown")} — <em>awaiting your confirmation</em>`
        );
      }
      contentHtml += adminButton("Open booking inbox");
    }

    contentHtml += sectionTitle(`Shop orders needing action (${openOrders.length})`);
    if (openOrders.length === 0) {
      contentHtml += line("None — all orders are on their way or delivered.", true);
    } else {
      for (const o of openOrders) {
        const items = o.items.map((i) => `${i.qty}× ${i.names.en}`).join(", ");
        contentHtml += line(
          `<strong>${escapeHtml(o.orderNumber)}</strong> (${escapeHtml(o.status)}) · ${escapeHtml(o.name)} · ${escapeHtml(o.phone)} · ${escapeHtml(String(o.totals.egp))} EGP<br><span style="color:#847866;font-size:14px;">${escapeHtml(items)}</span>`
        );
      }
      contentHtml += adminButton("Open admin");
    }

    if (topRebooking.length > 0) {
      contentHtml += sectionTitle(
        `Clients due for a check-in (${rebookingDue.length})`
      );
      for (const c of topRebooking) {
        const last = c.lastTreatment
          ? `${escapeHtml(c.lastTreatment)}, `
          : "";
        contentHtml += line(
          `<strong>${escapeHtml(c.displayName)}</strong> — ${last}<span style="color:#847866;">${c.overdueWeeks}+ weeks since last visit, nothing booked</span>`
        );
      }
      contentHtml += adminButton("Open clients");
    }
  }

  contentHtml += `<p style="margin:28px 0 0;color:#847866;font-size:14px;">Have a wonderful day!<br>— your booking assistant</p>`;

  const html = brandedEmailHtml({
    heading: `Your day — ${subjectDate}`,
    contentHtml,
    belowCardHtml: "Times shown in Cairo time (Africa/Cairo).",
  });

  return {
    subject,
    text,
    html,
    counts: {
      appointments: apptCount,
      pending: pending.length,
      orders: openOrders.length,
      rebooking: rebookingDue.length,
    },
  };
}

// --- sender (never throws) ------------------------------------------------------

export async function sendDailyBriefEmail(brief: DailyBrief): Promise<{
  sent: boolean;
  sentCount: number;
  failedCount: number;
  reason?: string;
}> {
  const apiKey = process.env.RESEND_API_KEY;
  const recipients = (process.env.NOTIFY_EMAIL || NOTIFY_EMAIL_DEFAULT)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!apiKey) {
    // Graceful no-op — log one entry per recipient, mirroring the real sends.
    for (const recipient of recipients) {
      console.log(
        `[daily-brief] RESEND_API_KEY not set — would email ${recipient}:\nSubject: ${brief.subject}\n${brief.text}`
      );
    }
    return { sent: false, sentCount: 0, failedCount: 0, reason: "email-not-configured" };
  }

  // One Resend call per recipient so a single bounced inbox can't block the
  // other owner address (same pattern as the order notification emails).
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
            subject: brief.subject,
            text: brief.text,
            html: brief.html,
          }),
        });
        if (!res.ok) {
          const body = await res.text();
          console.error(
            `[daily-brief] Resend send to ${recipient} failed (${res.status}): ${body.slice(0, 300)}`
          );
          return false;
        }
        console.log(`[daily-brief] Sent to ${recipient}: ${brief.subject}`);
        return true;
      } catch (error) {
        console.error(`[daily-brief] Resend request error for ${recipient}:`, error);
        return false;
      }
    })
  );

  const sentCount = outcomes.filter(Boolean).length;
  return {
    sent: sentCount > 0,
    sentCount,
    failedCount: outcomes.length - sentCount,
  };
}
