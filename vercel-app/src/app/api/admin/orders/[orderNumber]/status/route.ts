import { NextRequest, NextResponse } from "next/server";
import {
  isAuthorizedAdminRequest,
  unauthorizedResponse,
} from "@/lib/admin/auth";
import {
  CANCEL_REASON_CODES,
  isValidOrderNumber,
  updateOrderStatus,
  type CancelReason,
  type CancelReasonCode,
  type OrderStatus,
} from "@/lib/orders";
import { restoreQuantities } from "@/lib/catalog";
import {
  sendOrderStatusEmail,
  type EmailStatus,
} from "@/lib/order-status-email";

export const runtime = "nodejs";

/**
 * POST /api/admin/orders/<orderNumber>/status — advance an order's status.
 *
 * Body: { status: "confirmed" | "shipped" | "delivered" | "cancelled",
 *         reason?: { code: CancelReasonCode, note?: string } }
 * Auth: HTTP Basic (ADMIN_USER/ADMIN_PASS) or the legacy admin key via
 * x-admin-key / ?key= (same combined check as every /api/admin/* route).
 *
 * Behavior:
 * - Transitions follow the state machine in @/lib/orders
 *   (ordered → confirmed → shipped → delivered; cancel from
 *   ordered/confirmed); anything else is 400 with the current status.
 * - Cancelling REQUIRES a reason: a known code, with free text mandatory
 *   for "other". The reason lands in statusHistory and in the client email.
 * - Cancelling restores the order's quantities to the catalog
 *   (read-modify-write; only items still in the catalog and still tracking
 *   stock). A restore failure never rolls back the cancel — it is logged
 *   and reported via `stockRestored: false`.
 * - When the order has a buyer email, a lang-aware status email is sent for
 *   every transition. Email failure never fails the update — the response
 *   carries `emailed: boolean` so the admin UI can surface it.
 */

const REQUESTABLE_STATUSES = new Set<OrderStatus>([
  "confirmed",
  "shipped",
  "delivered",
  "cancelled",
]);

const MAX_REASON_NOTE = 300;

function parseCancelReason(
  raw: unknown
): { ok: true; reason: CancelReason } | { ok: false; error: string } {
  const o = (raw ?? {}) as { code?: unknown; note?: unknown };
  const code = o.code;
  if (
    typeof code !== "string" ||
    !(CANCEL_REASON_CODES as readonly string[]).includes(code)
  ) {
    return {
      ok: false,
      error: `reason.code must be one of: ${CANCEL_REASON_CODES.join(", ")}`,
    };
  }
  let note = "";
  if (o.note !== undefined) {
    if (typeof o.note !== "string" || o.note.length > MAX_REASON_NOTE) {
      return {
        ok: false,
        error: `reason.note must be a string of at most ${MAX_REASON_NOTE} characters`,
      };
    }
    note = o.note.trim();
  }
  if (code === "other" && note.length === 0) {
    return {
      ok: false,
      error: "reason.note is required when reason.code is 'other'",
    };
  }
  return { ok: true, reason: { code: code as CancelReasonCode, note } };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ orderNumber: string }> }
) {
  if (!isAuthorizedAdminRequest(request)) {
    return unauthorizedResponse();
  }

  const { orderNumber } = await params;
  if (!orderNumber || !isValidOrderNumber(orderNumber)) {
    return NextResponse.json(
      { error: "Invalid order number" },
      { status: 400 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { status, reason: rawReason } = (body ?? {}) as {
    status?: unknown;
    reason?: unknown;
  };
  if (
    typeof status !== "string" ||
    !REQUESTABLE_STATUSES.has(status as OrderStatus)
  ) {
    return NextResponse.json(
      {
        error:
          "status must be 'confirmed', 'shipped', 'delivered' or 'cancelled'",
      },
      { status: 400 }
    );
  }
  // EmailStatus is exactly the requestable subset of OrderStatus.
  const nextStatus = status as EmailStatus;

  // Cancellation requires a structured reason; other transitions ignore it.
  let cancelReason: CancelReason | undefined;
  if (nextStatus === "cancelled") {
    if (rawReason === undefined || rawReason === null) {
      return NextResponse.json(
        { error: "Cancelling requires a reason ({ code, note? })" },
        { status: 400 }
      );
    }
    const parsed = parseCancelReason(rawReason);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    cancelReason = parsed.reason;
  }

  try {
    const result = await updateOrderStatus(orderNumber, nextStatus, cancelReason);

    if (!result.ok) {
      if (result.error === "not-found") {
        return NextResponse.json({ error: "Order not found" }, { status: 404 });
      }
      return NextResponse.json(
        {
          error: `Invalid transition: ${result.current} → ${result.requested}`,
          current: result.current,
        },
        { status: 400 }
      );
    }

    // Cancelled orders give their stock back to the catalog. Never fatal —
    // the order is already cancelled; Victoria can fix counts in /admin.
    let stockRestored = false;
    if (nextStatus === "cancelled") {
      try {
        await restoreQuantities(
          result.order.items.map(({ slug, qty }) => ({ slug, qty }))
        );
        stockRestored = true;
      } catch (error) {
        console.error(
          `[orders] Stock restore failed after cancelling ${orderNumber}:`,
          error
        );
      }
    }

    // Status email only for orders that captured a buyer email; failure is
    // reported, never fatal — the blob update above has already succeeded.
    const emailResult = await sendOrderStatusEmail(
      result.order,
      nextStatus,
      cancelReason
    );

    return NextResponse.json({
      ok: true,
      orderNumber: result.order.orderNumber,
      status: result.order.status,
      emailed: emailResult.sent,
      ...(nextStatus === "cancelled" ? { stockRestored } : {}),
    });
  } catch (error) {
    console.error(`Admin order status error (${orderNumber}):`, error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
