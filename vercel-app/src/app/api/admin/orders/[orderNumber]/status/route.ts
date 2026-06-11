import { NextRequest, NextResponse } from "next/server";
import {
  isAuthorizedAdminRequest,
  unauthorizedResponse,
} from "@/lib/admin/auth";
import {
  isValidOrderNumber,
  updateOrderStatus,
  type OrderStatus,
} from "@/lib/orders";
import { sendOrderStatusEmail } from "@/lib/order-status-email";

export const runtime = "nodejs";

/**
 * POST /api/admin/orders/<orderNumber>/status — advance an order's status.
 *
 * Body: { status: "shipped" | "delivered" }
 * Auth: HTTP Basic (ADMIN_USER/ADMIN_PASS) or the legacy admin key via
 * x-admin-key / ?key= (same combined check as every /api/admin/* route).
 *
 * Behavior:
 * - Only forward transitions are allowed (ordered→shipped→delivered);
 *   anything else is 400 with the current status.
 * - When the order has a buyer email, a lang-aware status email is sent.
 *   Email failure never fails the update — the response carries
 *   `emailed: boolean` so the admin UI can surface it.
 */

const EMAILABLE_STATUSES = new Set<OrderStatus>(["shipped", "delivered"]);

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

  const status = (body as { status?: unknown })?.status;
  if (status !== "shipped" && status !== "delivered") {
    return NextResponse.json(
      { error: "status must be 'shipped' or 'delivered'" },
      { status: 400 }
    );
  }

  try {
    const result = await updateOrderStatus(orderNumber, status);

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

    // Status email only for orders that captured a buyer email; failure is
    // reported, never fatal — the blob update above has already succeeded.
    let emailed = false;
    if (EMAILABLE_STATUSES.has(status)) {
      const emailResult = await sendOrderStatusEmail(result.order, status);
      emailed = emailResult.sent;
    }

    return NextResponse.json({
      ok: true,
      orderNumber: result.order.orderNumber,
      status: result.order.status,
      emailed,
    });
  } catch (error) {
    console.error(`Admin order status error (${orderNumber}):`, error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
