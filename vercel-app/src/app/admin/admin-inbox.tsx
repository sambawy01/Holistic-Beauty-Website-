"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { CalBooking } from "@/lib/admin/cal";
import { COMBINED_SESSION, SERVICES } from "@/lib/services";

const PUBLIC_BOOKING_BASE = "https://book.victoriaholisticbeauty.com/book";
const CAIRO_TZ = "Africa/Cairo";

/* ---------- helpers ---------- */

function formatCairo(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: CAIRO_TZ,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

/** UTC offset (ms) of `tz` at the given UTC instant. */
function tzOffsetMs(utcMs: number, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
      .formatToParts(new Date(utcMs))
      .map((p) => [p.type, p.value])
  );
  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour === "24" ? "0" : parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return asIfUtc - utcMs;
}

/** Interpret a datetime-local value ("YYYY-MM-DDTHH:mm") as Cairo wall time → UTC ISO. */
function cairoWallTimeToUtcIso(local: string): string | null {
  const m = local.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.slice(0).map(Number);
  const naiveUtc = Date.UTC(y, mo - 1, d, h, mi);
  // Two-pass to handle DST transitions.
  let utc = naiveUtc - tzOffsetMs(naiveUtc, CAIRO_TZ);
  utc = naiveUtc - tzOffsetMs(utc, CAIRO_TZ);
  return new Date(utc).toISOString();
}

function serviceForBooking(booking: CalBooking) {
  return SERVICES.find((s) => s.eventTypeId === booking.eventTypeId);
}

function bookingLink(booking: CalBooking): string {
  const slug = serviceForBooking(booking)?.slug ?? booking.eventType?.slug;
  // Combined sessions have no public per-service page — link to the picker.
  return slug && slug !== COMBINED_SESSION.slug
    ? `${PUBLIC_BOOKING_BASE}?service=${slug}`
    : PUBLIC_BOOKING_BASE;
}

function serviceTitle(booking: CalBooking): string {
  return serviceForBooking(booking)?.en.title ?? booking.title;
}

/** Client notes (incl. the "Treatments: …" line for combined sessions). */
function bookingNotes(booking: CalBooking): string | null {
  const notes = booking.bookingFieldsResponses?.notes;
  if (typeof notes !== "string") return null;
  const trimmed = notes.trim();
  if (!trimmed || trimmed === "No additional notes provided") return null;
  return trimmed;
}

function suggestTemplate(booking: CalBooking): string {
  return (
    "I can't make this time. Could we try one of these instead?\n" +
    "• \n" +
    "• \n" +
    `Book here: ${bookingLink(booking)}`
  );
}

/* ---------- small UI pieces ---------- */

function StatusChip({ status }: { status: string }) {
  const styles =
    status === "pending"
      ? "bg-[#A9745A]/15 text-[#8A5238]"
      : status === "accepted"
        ? "bg-[#6B7A4F]/15 text-[#55633D]"
        : "bg-[#3A332C]/10 text-[#3A332C]";
  const label = status === "accepted" ? "confirmed" : status;
  return (
    <span
      className={`inline-block rounded-full px-3 py-1 text-xs font-medium capitalize ${styles}`}
    >
      {label}
    </span>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-[#3A332C]/15 bg-[#FFFDF9]/60 px-6 py-8 text-center text-sm text-[#847866]">
      {text}
    </div>
  );
}

const buttonBase =
  "rounded-full px-4 py-2.5 text-sm font-medium transition-opacity disabled:opacity-50";

/* ---------- pending booking card ---------- */

type Mode = "decline" | "suggest" | "move" | null;

function PendingCard({
  booking,
  adminKey,
  onChanged,
}: {
  booking: CalBooking;
  adminKey: string;
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<Mode>(null);
  const [note, setNote] = useState("");
  const [moveStart, setMoveStart] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function callAction(
    action: "confirm" | "decline" | "reschedule",
    body?: Record<string, unknown>,
    doneLabel?: string
  ) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/bookings/${booking.uid}/${action}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-key": adminKey,
        },
        body: JSON.stringify(body ?? {}),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        const message =
          (payload && (payload.error?.message || payload.error)) ||
          `Request failed (${res.status})`;
        setError(typeof message === "string" ? message : `Request failed (${res.status})`);
        return;
      }
      setDone(doneLabel ?? "Done");
      onChanged();
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  }

  function openMode(next: Exclude<Mode, null>) {
    setError(null);
    setMode(next);
    if (next === "suggest") setNote(suggestTemplate(booking));
    if (next === "decline") setNote("");
  }

  const attendee = booking.attendees[0];

  if (done) {
    return (
      <article className="rounded-2xl border border-[#3A332C]/10 bg-[#FFFDF9] px-5 py-4 shadow-sm">
        <p className="text-sm text-[#55633D]">{done}</p>
      </article>
    );
  }

  return (
    <article className="rounded-2xl border border-[#3A332C]/10 bg-[#FFFDF9] px-5 py-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-serif text-xl text-[#3A332C]">
            {serviceTitle(booking)}
          </h3>
          <p className="mt-1 text-sm text-[#3A332C]">
            {attendee?.name}
            {attendee?.email ? (
              <span className="text-[#847866]"> · {attendee.email}</span>
            ) : null}
          </p>
          <p className="mt-1 text-sm font-medium text-[#8A5238]">
            {formatCairo(booking.start)} · {booking.duration} min
          </p>
          {bookingNotes(booking) && (
            <p className="mt-2 whitespace-pre-line rounded-xl bg-[#3A332C]/5 px-3 py-2 text-sm text-[#3A332C]">
              {bookingNotes(booking)}
            </p>
          )}
        </div>
        <StatusChip status={booking.status} />
      </div>

      {mode === null && (
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => callAction("confirm", undefined, "Booking confirmed.")}
            className={`${buttonBase} bg-[#8A5238] text-[#FDF9F3] hover:opacity-90`}
          >
            {busy ? "Working…" : "Confirm"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => openMode("decline")}
            className={`${buttonBase} border border-[#B5483A]/40 text-[#B5483A] hover:bg-[#B5483A]/5`}
          >
            Decline with note
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => openMode("suggest")}
            className={`${buttonBase} border border-[#8A5238]/40 text-[#8A5238] hover:bg-[#8A5238]/5`}
          >
            Suggest reschedule
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => openMode("move")}
            className={`${buttonBase} border border-[#3A332C]/20 text-[#3A332C] hover:bg-[#3A332C]/5`}
          >
            Move to new time
          </button>
        </div>
      )}

      {(mode === "decline" || mode === "suggest") && (
        <div className="mt-4 space-y-3">
          <label className="block text-sm font-medium text-[#3A332C]">
            {mode === "decline"
              ? "Note to the client (required — sent in the decline email)"
              : "Reschedule invitation (sent in the decline email — add your suggested times)"}
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={mode === "suggest" ? 6 : 4}
              className="mt-2 w-full rounded-xl border border-[#3A332C]/20 bg-white px-3 py-2 text-sm text-[#3A332C] focus:border-[#8A5238] focus:outline-none"
              placeholder={
                mode === "decline" ? "e.g. I'm fully booked that day…" : undefined
              }
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || note.trim().length === 0}
              onClick={() =>
                callAction(
                  "decline",
                  { reason: note.trim() },
                  mode === "suggest"
                    ? "Declined with reschedule invitation."
                    : "Declined — your note was sent to the client."
                )
              }
              className={`${buttonBase} bg-[#B5483A] text-[#FDF9F3] hover:opacity-90`}
            >
              {busy
                ? "Working…"
                : mode === "suggest"
                  ? "Decline & send invitation"
                  : "Decline & send note"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setMode(null)}
              className={`${buttonBase} text-[#847866] hover:bg-[#3A332C]/5`}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {mode === "move" && (
        <div className="mt-4 space-y-3">
          <p className="rounded-xl bg-[#A9745A]/10 px-3 py-2 text-xs text-[#8A5238]">
            This rebooks the appointment to the new time immediately — the
            client is notified by Cal.com, not asked.
          </p>
          <label className="block text-sm font-medium text-[#3A332C]">
            New start time (Cairo time)
            <input
              type="datetime-local"
              value={moveStart}
              onChange={(e) => setMoveStart(e.target.value)}
              className="mt-2 w-full rounded-xl border border-[#3A332C]/20 bg-white px-3 py-2 text-sm text-[#3A332C] focus:border-[#8A5238] focus:outline-none"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || !cairoWallTimeToUtcIso(moveStart)}
              onClick={() => {
                const startIso = cairoWallTimeToUtcIso(moveStart);
                if (!startIso) return;
                callAction(
                  "reschedule",
                  { start: startIso, reason: "Moved by Victoria" },
                  "Booking moved to the new time."
                );
              }}
              className={`${buttonBase} bg-[#8A5238] text-[#FDF9F3] hover:opacity-90`}
            >
              {busy ? "Working…" : "Move booking now"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setMode(null)}
              className={`${buttonBase} text-[#847866] hover:bg-[#3A332C]/5`}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <p className="mt-3 text-sm text-[#B5483A]">{error}</p>}
    </article>
  );
}

/* ---------- confirmed booking card ---------- */

function ConfirmedCard({ booking }: { booking: CalBooking }) {
  const attendee = booking.attendees[0];
  return (
    <article className="rounded-2xl border border-[#3A332C]/10 bg-[#FFFDF9] px-5 py-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-serif text-lg text-[#3A332C]">
            {serviceTitle(booking)}
          </h3>
          <p className="mt-1 text-sm text-[#3A332C]">
            {attendee?.name}
            {attendee?.email ? (
              <span className="text-[#847866]"> · {attendee.email}</span>
            ) : null}
          </p>
          <p className="mt-1 text-sm text-[#847866]">
            {formatCairo(booking.start)} · {booking.duration} min
          </p>
          {bookingNotes(booking) && (
            <p className="mt-2 whitespace-pre-line rounded-xl bg-[#3A332C]/5 px-3 py-2 text-sm text-[#3A332C]">
              {bookingNotes(booking)}
            </p>
          )}
        </div>
        <StatusChip status={booking.status} />
      </div>
    </article>
  );
}

/* ---------- inbox ---------- */

export default function AdminInbox({
  pending,
  confirmed,
  adminKey,
}: {
  pending: CalBooking[];
  confirmed: CalBooking[];
  adminKey: string;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const refresh = () => startTransition(() => router.refresh());

  return (
    <div className="space-y-10">
      <section>
        <h2 className="mb-4 font-serif text-2xl text-[#3A332C]">
          Pending requests
          {pending.length > 0 && (
            <span className="ml-2 align-middle text-sm font-sans text-[#8A5238]">
              {pending.length}
            </span>
          )}
        </h2>
        {pending.length === 0 ? (
          <EmptyState text="No pending requests — all caught up." />
        ) : (
          <div className="space-y-4">
            {pending.map((b) => (
              <PendingCard
                key={b.uid}
                booking={b}
                adminKey={adminKey}
                onChanged={refresh}
              />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-4 font-serif text-2xl text-[#3A332C]">
          Upcoming confirmed
        </h2>
        {confirmed.length === 0 ? (
          <EmptyState text="No upcoming confirmed bookings yet." />
        ) : (
          <div className="space-y-4">
            {confirmed.map((b) => (
              <ConfirmedCard key={b.uid} booking={b} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
