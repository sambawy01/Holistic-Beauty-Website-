import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Cal.com webhook receiver.
 *
 * Trust model (defense in depth):
 * 1. Preferred: HMAC-SHA256 signature check. Cal signs the raw request body
 *    with the webhook `secret` and sends the hex digest in the
 *    `x-cal-signature-256` header. We verify with a timing-safe compare.
 * 2. Fallback (secret unset, header missing, or mismatch): we do NOT trust the
 *    payload. Instead we fetch the booking by uid from the Cal API and build
 *    the notification from that canonical data. A forged payload can therefore
 *    at worst trigger an email about a real, existing booking.
 *
 * This route must NEVER break bookings: every handled outcome returns 200.
 * Only malformed JSON returns 400.
 */

const NOTIFY_EMAIL_DEFAULT = "victoria@victoriaholisticbeauty.com";
const ADMIN_URL_BASE = "https://book.victoriaholisticbeauty.com/admin";
const EMAIL_FROM =
  "Victoria Holistic Beauty <bookings@victoriaholisticbeauty.com>";

interface WebhookAttendee {
  name?: string;
  email?: string;
  timeZone?: string;
  phoneNumber?: string;
}

interface WebhookPayload {
  uid?: string;
  bookingId?: number;
  title?: string;
  eventTitle?: string;
  type?: string;
  status?: string;
  startTime?: string;
  endTime?: string;
  attendees?: WebhookAttendee[];
  responses?: Record<string, { label?: string; value?: unknown } | undefined>;
}

interface WebhookBody {
  triggerEvent?: string;
  createdAt?: string;
  payload?: WebhookPayload;
}

interface BookingDetails {
  uid: string;
  service: string;
  start: string;
  status: string;
  attendeeName: string;
  attendeeEmail: string;
  attendeePhone: string;
  /** Client notes incl. the "Treatments: …" line for combined sessions. */
  notes: string;
}

function verifySignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string
): boolean {
  if (!signatureHeader) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const provided = signatureHeader.trim().toLowerCase();
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Canonical booking lookup — used when the payload cannot be trusted. */
async function fetchBookingFromCal(
  uid: string
): Promise<BookingDetails | null> {
  const apiUrl = process.env.CALCOM_API_URL;
  const apiKey = process.env.CALCOM_API_KEY;
  if (!apiUrl || !apiKey) return null;
  try {
    const res = await fetch(`${apiUrl}/bookings/${encodeURIComponent(uid)}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "cal-api-version": "2024-08-13",
      },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: {
        uid: string;
        title?: string;
        status?: string;
        start?: string;
        eventType?: { slug?: string };
        attendees?: WebhookAttendee[];
        bookingFieldsResponses?: Record<string, unknown>;
      };
    };
    const b = json.data;
    if (!b?.uid) return null;
    const attendee = b.attendees?.[0] ?? {};
    const rawNotes = b.bookingFieldsResponses?.notes;
    return {
      uid: b.uid,
      service: b.title || b.eventType?.slug || "Booking",
      start: b.start || "",
      status: (b.status || "").toLowerCase(),
      attendeeName: attendee.name || "Unknown",
      attendeeEmail: attendee.email || "unknown",
      attendeePhone: attendee.phoneNumber || "not provided",
      notes: typeof rawNotes === "string" ? rawNotes : "",
    };
  } catch (error) {
    console.error("[cal-webhook] Cal API lookup failed:", error);
    return null;
  }
}

function detailsFromPayload(payload: WebhookPayload): BookingDetails {
  const attendee = payload.attendees?.[0] ?? {};
  const responsePhone = payload.responses?.attendeePhoneNumber?.value;
  const responseNotes = payload.responses?.notes?.value;
  return {
    uid: payload.uid || "",
    service: payload.eventTitle || payload.title || payload.type || "Booking",
    start: payload.startTime || "",
    status: (payload.status || "").toLowerCase(),
    attendeeName: attendee.name || "Unknown",
    attendeeEmail: attendee.email || "unknown",
    attendeePhone:
      attendee.phoneNumber ||
      (typeof responsePhone === "string" ? responsePhone : "") ||
      "not provided",
    notes: typeof responseNotes === "string" ? responseNotes : "",
  };
}

function formatCairoTime(iso: string): string {
  if (!iso) return "unknown time";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Cairo",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildEmail(details: BookingDetails): {
  subject: string;
  text: string;
  html: string;
} {
  const cairoTime = formatCairoTime(details.start);
  const adminToken = process.env.ADMIN_TOKEN || "";
  const reviewLink = adminToken
    ? `${ADMIN_URL_BASE}?key=${encodeURIComponent(adminToken)}`
    : ADMIN_URL_BASE;
  const subject = `New booking request — ${details.service} · ${cairoTime}`;

  const showNotes =
    details.notes && details.notes !== "No additional notes provided";

  const text = [
    "New booking request",
    "",
    `Service:  ${details.service}`,
    `Time:     ${cairoTime} (Cairo)`,
    `Name:     ${details.attendeeName}`,
    `Email:    ${details.attendeeEmail}`,
    `Phone:    ${details.attendeePhone}`,
    ...(showNotes ? [`Notes:    ${details.notes}`] : []),
    "",
    "Confirm, decline with a note, or suggest another time here:",
    reviewLink,
  ].join("\n");

  const row = (label: string, value: string) =>
    `<tr><td style="padding:6px 16px 6px 0;color:#847866;font-size:13px;text-transform:uppercase;letter-spacing:0.08em;white-space:nowrap;vertical-align:top;">${label}</td><td style="padding:6px 0;color:#3A332C;font-size:15px;">${escapeHtml(value)}</td></tr>`;

  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background-color:#F4EFE7;font-family:Georgia,'Times New Roman',serif;">
  <div style="max-width:560px;margin:0 auto;padding:32px 16px;">
    <div style="background-color:#FFFDF9;border:1px solid #E5DCCB;border-radius:16px;padding:32px;">
      <p style="margin:0 0 4px;color:#847866;font-size:12px;text-transform:uppercase;letter-spacing:0.2em;">Victoria Vasilyeva Holistic Beauty</p>
      <h1 style="margin:0 0 24px;color:#3A332C;font-size:26px;font-weight:normal;">New booking request</h1>
      <table style="border-collapse:collapse;width:100%;">
        ${row("Service", details.service)}
        ${row("Time", `${cairoTime} (Cairo)`)}
        ${row("Name", details.attendeeName)}
        ${row("Email", details.attendeeEmail)}
        ${row("Phone", details.attendeePhone)}
        ${showNotes ? row("Notes", details.notes) : ""}
      </table>
      <p style="margin:28px 0 16px;color:#3A332C;font-size:15px;">Confirm, decline with a note, or suggest another time here:</p>
      <a href="${reviewLink}" style="display:inline-block;background-color:#3A332C;color:#FFFDF9;text-decoration:none;padding:12px 28px;border-radius:9999px;font-size:15px;">Open booking inbox</a>
    </div>
    <p style="margin:16px 8px 0;color:#847866;font-size:12px;">Times shown in Cairo time (Africa/Cairo).</p>
  </div>
</body>
</html>`;

  return { subject, text, html };
}

async function sendNotificationEmail(
  details: BookingDetails
): Promise<{ sent: boolean; reason?: string }> {
  const { subject, text, html } = buildEmail(details);
  const apiKey = process.env.RESEND_API_KEY;
  const to = (process.env.NOTIFY_EMAIL || NOTIFY_EMAIL_DEFAULT)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!apiKey) {
    // Graceful no-op: never break the webhook because email isn't configured.
    console.log(
      `[cal-webhook] RESEND_API_KEY not set — would email ${to}:\nSubject: ${subject}\n${text}`
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
        `[cal-webhook] Resend send failed (${res.status}): ${body.slice(0, 300)}`
      );
      return { sent: false, reason: `resend-${res.status}` };
    }
    console.log(`[cal-webhook] Notification email sent to ${to}: ${subject}`);
    return { sent: true };
  } catch (error) {
    console.error("[cal-webhook] Resend request error:", error);
    return { sent: false, reason: "resend-network-error" };
  }
}

export async function POST(request: NextRequest) {
  let rawBody: string;
  let body: WebhookBody;
  try {
    rawBody = await request.text();
    body = JSON.parse(rawBody) as WebhookBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const triggerEvent = (body.triggerEvent || "").toUpperCase();
  const payload = body.payload ?? {};
  const uid = payload.uid || "";

  // --- authenticate the webhook -------------------------------------------
  const secret = process.env.CAL_WEBHOOK_SECRET;
  const signatureValid = secret
    ? verifySignature(rawBody, request.headers.get("x-cal-signature-256"), secret)
    : false;

  let details: BookingDetails | null = null;
  if (signatureValid) {
    details = detailsFromPayload(payload);
  } else if (uid) {
    // Untrusted payload: only the uid is used; everything in the email comes
    // from the canonical booking fetched from the Cal API.
    details = await fetchBookingFromCal(uid);
    if (!details) {
      console.warn(
        `[cal-webhook] Unverified payload and booking uid not found on Cal — ignoring (trigger=${triggerEvent}, uid=${uid})`
      );
      return NextResponse.json({ received: true, ignored: "unverified" });
    }
  } else {
    console.warn(
      `[cal-webhook] Unverified payload without booking uid — ignoring (trigger=${triggerEvent})`
    );
    return NextResponse.json({ received: true, ignored: "unverified" });
  }

  // --- route by trigger -----------------------------------------------------
  const shouldEmail =
    triggerEvent === "BOOKING_REQUESTED" ||
    (triggerEvent === "BOOKING_CREATED" && details.status.includes("pending"));

  if (shouldEmail) {
    const result = await sendNotificationEmail(details);
    return NextResponse.json({ received: true, emailed: result.sent });
  }

  console.log(
    `[cal-webhook] Received ${triggerEvent || "UNKNOWN"} for uid=${details.uid} (status=${details.status}) — no email needed`
  );
  return NextResponse.json({ received: true, emailed: false });
}
