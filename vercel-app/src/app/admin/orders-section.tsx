"use client";

import { useState } from "react";
import type {
  CancelReason,
  CancelReasonCode,
  OrderStatus,
  StoredOrder,
} from "@/lib/orders";

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

function formatEgp(amount: number): string {
  return `${amount.toLocaleString("en-EG")} EGP`;
}

/** One-line items recap, e.g. "2× Vitamin C Mask · 1× NoMela Serum". */
function itemsSummary(order: StoredOrder): string {
  return order.items
    .map((item) => `${item.qty}× ${item.names.en}`)
    .join(" · ");
}

/* ---------- status chip (earthy palette) ---------- */

const CHIP_STYLES: Record<OrderStatus, string> = {
  ordered: "bg-[#A9745A]/15 text-[#8A5238]", // clay — same family as pending
  confirmed: "bg-[#4F7A72]/15 text-[#3D6359]", // teal/sage — accepted
  shipped: "bg-[#C2A14D]/20 text-[#8A6E2F]", // amber/gold — in transit
  delivered: "bg-[#6B7A4F]/15 text-[#55633D]", // olive — done
  cancelled: "bg-[#6E5A52]/15 text-[#6E5A52]", // muted grey/red-brown — terminal
};

function OrderStatusChip({ status }: { status: OrderStatus }) {
  return (
    <span
      className={`inline-block rounded-full px-3 py-1 text-xs font-medium capitalize ${CHIP_STYLES[status] ?? "bg-[#3A332C]/10 text-[#3A332C]"}`}
    >
      {status}
    </span>
  );
}

/* ---------- order card ---------- */

const buttonBase =
  "rounded-full px-4 py-2.5 text-sm font-medium transition-opacity disabled:opacity-50";

/** Forward action per status; Cancel is rendered separately where allowed. */
const NEXT_ACTION: Partial<
  Record<OrderStatus, { next: OrderStatus; label: string; busyLabel: string }>
> = {
  ordered: {
    next: "confirmed",
    label: "Mark confirmed",
    busyLabel: "Marking…",
  },
  confirmed: { next: "shipped", label: "Mark shipped", busyLabel: "Marking…" },
  shipped: {
    next: "delivered",
    label: "Mark delivered",
    busyLabel: "Marking…",
  },
};

/** Statuses from which Victoria may cancel (mirrors @/lib/orders). */
const CANCELLABLE = new Set<OrderStatus>(["ordered", "confirmed"]);

const CANCEL_REASON_OPTIONS: { code: CancelReasonCode; label: string }[] = [
  { code: "out-of-stock", label: "Out of stock" },
  { code: "unreachable", label: "Could not reach the client" },
  { code: "client-request", label: "Cancelled at client's request" },
  { code: "delivery-area", label: "Delivery area not covered" },
  { code: "other", label: "Other" },
];

/* ---------- cancel reason picker ---------- */

function CancelReasonPicker({
  busy,
  onConfirm,
  onClose,
}: {
  busy: boolean;
  onConfirm: (reason: CancelReason) => void;
  onClose: () => void;
}) {
  const [code, setCode] = useState<CancelReasonCode | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  function confirm() {
    setError(null);
    if (!code) {
      setError("Please pick a reason.");
      return;
    }
    const trimmed = note.trim();
    if (code === "other" && trimmed.length === 0) {
      setError("Please describe the reason.");
      return;
    }
    onConfirm({ code, note: trimmed });
  }

  return (
    <div className="mt-4 rounded-xl border border-[#6E5A52]/25 bg-[#6E5A52]/5 px-4 py-4">
      <p className="text-sm font-medium text-[#3A332C]">
        Why is this order being cancelled?
      </p>
      <div className="mt-2 space-y-1.5">
        {CANCEL_REASON_OPTIONS.map((option) => (
          <label
            key={option.code}
            className="flex items-center gap-2 text-sm text-[#3A332C]"
          >
            <input
              type="radio"
              name="cancel-reason"
              checked={code === option.code}
              onChange={() => setCode(option.code)}
              className="h-4 w-4 accent-[#6E5A52]"
            />
            {option.label}
          </label>
        ))}
      </div>
      <input
        className="mt-3 w-full rounded-xl border border-[#3A332C]/15 bg-white px-3 py-2 text-sm text-[#3A332C] outline-none focus:border-[#6E5A52]"
        value={note}
        maxLength={300}
        placeholder={
          code === "other" ? "Reason (required)" : "Details (optional)"
        }
        onChange={(e) => setNote(e.target.value)}
      />
      {error && <p className="mt-2 text-sm text-[#B5483A]">{error}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={confirm}
          className={`${buttonBase} bg-[#6E5A52] text-[#FDF9F3] hover:opacity-90`}
        >
          {busy ? "Cancelling…" : "Cancel order"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onClose}
          className={`${buttonBase} border border-[#3A332C]/15 bg-[#FFFDF9] text-[#3A332C] hover:bg-[#F4EFE7]`}
        >
          Keep order
        </button>
      </div>
    </div>
  );
}

function OrderCard({
  order,
  adminKey,
}: {
  order: StoredOrder;
  adminKey: string;
}) {
  // Optimistic local status — the blob is the source of truth, but we
  // advance the chip/buttons immediately on a 200 so Victoria isn't left
  // waiting for a server roundtrip on her phone.
  const [status, setStatus] = useState<OrderStatus>(order.status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  async function transition(next: OrderStatus, reason?: CancelReason) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(
        `/api/admin/orders/${encodeURIComponent(order.orderNumber)}/status`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-admin-key": adminKey,
          },
          body: JSON.stringify({ status: next, ...(reason ? { reason } : {}) }),
        }
      );
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        const message =
          (payload && typeof payload.error === "string" && payload.error) ||
          `Request failed (${res.status})`;
        setError(message);
        return;
      }
      setStatus(next);
      setCancelling(false);
      const stockNote =
        next === "cancelled"
          ? payload?.stockRestored
            ? " Stock returned to the catalog."
            : " Stock could NOT be returned — check product quantities."
          : "";
      if (order.email) {
        setNotice(
          (payload?.emailed
            ? `Client notified by email (${next}).`
            : "Status updated — but the client email could not be sent.") +
            stockNote
        );
      } else {
        setNotice(`Status updated. No client email on this order.${stockNote}`);
      }
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  }

  const action = NEXT_ACTION[status];
  const cancellable = CANCELLABLE.has(status);

  return (
    <article className="rounded-2xl border border-[#3A332C]/10 bg-[#FFFDF9] px-5 py-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-serif text-xl text-[#3A332C]">
            {order.orderNumber}
            <span className="ml-2 align-middle font-sans text-sm font-medium text-[#8A5238]">
              {formatEgp(order.totals.egp)}
            </span>
          </h3>
          <p className="mt-1 text-sm text-[#3A332C]">
            {order.name}
            <span className="text-[#847866]"> · {order.phone}</span>
            {order.email ? (
              <span className="text-[#847866]"> · {order.email}</span>
            ) : null}
          </p>
          <p className="mt-1 text-sm text-[#847866]">
            {formatCairo(order.createdAt)} · Cairo time
          </p>
          <p className="mt-2 rounded-xl bg-[#3A332C]/5 px-3 py-2 text-sm text-[#3A332C]">
            {itemsSummary(order)}
          </p>
          {order.note ? (
            <p className="mt-2 text-sm italic text-[#847866]">
              “{order.note}”
            </p>
          ) : null}
        </div>
        <OrderStatusChip status={status} />
      </div>

      {(action || cancellable) && !cancelling && (
        <div className="mt-4 flex flex-wrap gap-2">
          {action && (
            <button
              type="button"
              disabled={busy}
              onClick={() => transition(action.next)}
              className={`${buttonBase} bg-[#8A5238] text-[#FDF9F3] hover:opacity-90`}
            >
              {busy ? action.busyLabel : action.label}
            </button>
          )}
          {cancellable && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setError(null);
                setNotice(null);
                setCancelling(true);
              }}
              className={`${buttonBase} border border-[#6E5A52]/30 bg-[#FFFDF9] text-[#6E5A52] hover:bg-[#6E5A52]/5`}
            >
              Cancel
            </button>
          )}
        </div>
      )}

      {cancelling && (
        <CancelReasonPicker
          busy={busy}
          onConfirm={(reason) => void transition("cancelled", reason)}
          onClose={() => setCancelling(false)}
        />
      )}

      {notice && <p className="mt-3 text-sm text-[#55633D]">{notice}</p>}
      {error && <p className="mt-3 text-sm text-[#B5483A]">{error}</p>}
    </article>
  );
}

/* ---------- section ---------- */

export default function OrdersSection({
  orders,
  adminKey,
  loadError,
}: {
  orders: StoredOrder[];
  adminKey: string;
  loadError: string | null;
}) {
  return (
    <section>
      <h2 className="mb-4 font-serif text-2xl text-[#3A332C]">
        Shop orders
        {orders.length > 0 && (
          <span className="ml-2 align-middle font-sans text-sm text-[#8A5238]">
            {orders.length}
          </span>
        )}
      </h2>
      {loadError ? (
        <div className="rounded-2xl border border-[#B5483A]/30 bg-[#FFFDF9] px-6 py-5 text-sm text-[#B5483A]">
          {loadError}
        </div>
      ) : orders.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-[#3A332C]/15 bg-[#FFFDF9]/60 px-6 py-8 text-center text-sm text-[#847866]">
          No shop orders yet — they will appear here as soon as a client
          orders from the shop.
        </div>
      ) : (
        <div className="space-y-4">
          {orders.map((order) => (
            <OrderCard
              key={order.orderNumber}
              order={order}
              adminKey={adminKey}
            />
          ))}
        </div>
      )}
    </section>
  );
}
