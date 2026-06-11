import { get, list, put } from "@vercel/blob";

/**
 * Order persistence on Vercel Blob (private store `vv-orders`).
 *
 * Layout: one JSON document per order at `orders/<orderNumber>.json`.
 * The SDK authenticates with BLOB_READ_WRITE_TOKEN from the environment;
 * the store is private, so every read goes through `get(..., { access:
 * "private" })` — blob URLs are never exposed to clients.
 *
 * Design notes:
 * - Order volume is tiny (a handful per day), so `listOrders` reads every
 *   blob under the prefix and sorts by the order's own `createdAt`. We
 *   intentionally do NOT sort by blob `uploadedAt` — status updates rewrite
 *   the blob and would reshuffle the list.
 * - `useCache: false` on all reads: status transitions rewrite blobs, and a
 *   stale CDN-cached copy would let Victoria double-fire a transition.
 * - Status flow is ordered → confirmed → shipped → delivered, with
 *   `cancelled` reachable from ordered/confirmed (terminal, reason
 *   required). Enforced in `updateOrderStatus`; every transition is
 *   appended to `statusHistory`.
 * - LEGACY: blobs written before the confirm/cancel upgrade only ever hold
 *   ordered/shipped/delivered — all still valid statuses. An old "ordered"
 *   simply takes the new confirmed-first path; an old "shipped" can still
 *   go straight to delivered.
 */

export const ORDER_STATUSES = [
  "ordered",
  "confirmed",
  "shipped",
  "delivered",
  "cancelled",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Legal next steps for each status (terminal: delivered, cancelled). */
export const ALLOWED_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> =
  {
    ordered: ["confirmed", "cancelled"],
    confirmed: ["shipped", "cancelled"],
    shipped: ["delivered"],
    delivered: [],
    cancelled: [],
  };

/** Structured cancellation reason — `note` is required for code "other". */
export const CANCEL_REASON_CODES = [
  "out-of-stock",
  "unreachable",
  "client-request",
  "delivery-area",
  "other",
] as const;
export type CancelReasonCode = (typeof CANCEL_REASON_CODES)[number];

export interface CancelReason {
  code: CancelReasonCode;
  /** Free text — required when code is "other", optional extra otherwise. */
  note: string;
}

export interface StoredOrderItem {
  slug: string;
  qty: number;
  names: { en: string; ru: string };
  lineTotals: { egp: number; rub: number };
}

export interface StoredOrder {
  orderNumber: string;
  createdAt: string; // ISO 8601
  status: OrderStatus;
  items: StoredOrderItem[];
  totals: { egp: number; rub: number };
  name: string;
  phone: string;
  /** Optional — "" when the buyer left it blank. */
  email: string;
  address: string;
  note: string;
  lang: "en" | "ru";
  statusHistory: { status: OrderStatus; at: string; reason?: CancelReason }[];
}

export type UpdateStatusResult =
  | { ok: true; order: StoredOrder }
  | { ok: false; error: "not-found" }
  | {
      ok: false;
      error: "invalid-transition";
      current: OrderStatus;
      requested: OrderStatus;
    };

// Matches generateOrderNumber() in /api/order: "VV-" + 6 base36 uppercase.
const ORDER_NUMBER_RE = /^VV-[A-Z0-9]{6}$/;

export function isValidOrderNumber(orderNumber: string): boolean {
  return ORDER_NUMBER_RE.test(orderNumber);
}

function orderPathname(orderNumber: string): string {
  if (!isValidOrderNumber(orderNumber)) {
    // Defense in depth: order numbers reach this layer from URL params, so
    // never let an unexpected shape become a blob pathname.
    throw new Error(`Invalid order number: ${orderNumber}`);
  }
  return `orders/${orderNumber}.json`;
}

async function writeOrder(
  order: StoredOrder,
  { overwrite }: { overwrite: boolean }
): Promise<void> {
  await put(orderPathname(order.orderNumber), JSON.stringify(order, null, 2), {
    access: "private",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: overwrite,
  });
}

/**
 * Persist a freshly created order. Throws on failure — callers decide
 * whether persistence failure is fatal (the order route treats it as
 * non-fatal and reports `stored: false`).
 */
export async function saveOrder(order: StoredOrder): Promise<void> {
  await writeOrder(order, { overwrite: false });
}

/** Fetch a single order, or null when it does not exist. */
export async function getOrder(
  orderNumber: string
): Promise<StoredOrder | null> {
  if (!isValidOrderNumber(orderNumber)) return null;
  const result = await get(orderPathname(orderNumber), {
    access: "private",
    useCache: false,
  });
  if (!result || result.statusCode !== 200) return null;
  return (await new Response(result.stream).json()) as StoredOrder;
}

/** Hard cap on how many blobs a single list pass will hydrate. */
const LIST_SCAN_CAP = 200;

/**
 * List orders, newest first by the order's own `createdAt`.
 * Reads up to LIST_SCAN_CAP most recently *uploaded* blobs, hydrates them
 * concurrently, then sorts by createdAt — correct even though status
 * rewrites bump blob uploadedAt.
 */
export async function listOrders(
  { limit = 50 }: { limit?: number } = {}
): Promise<StoredOrder[]> {
  const { blobs } = await list({
    prefix: "orders/",
    limit: LIST_SCAN_CAP,
  });

  const orders = await Promise.all(
    blobs.map(async (blob): Promise<StoredOrder | null> => {
      try {
        const result = await get(blob.pathname, {
          access: "private",
          useCache: false,
        });
        if (!result || result.statusCode !== 200) return null;
        return (await new Response(result.stream).json()) as StoredOrder;
      } catch (error) {
        // One corrupt/racing blob must not take down the whole admin list.
        console.error(`[orders] Failed to read ${blob.pathname}:`, error);
        return null;
      }
    })
  );

  return orders
    .filter((o): o is StoredOrder => o !== null && typeof o.orderNumber === "string")
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )
    .slice(0, limit);
}

/**
 * Advance an order's status along the state machine
 * (ordered → confirmed → shipped → delivered, cancel from ordered/confirmed).
 * Anything else returns a typed `invalid-transition` error so the API layer
 * can answer 400. A `reason` (cancellations) is recorded in statusHistory.
 */
export async function updateOrderStatus(
  orderNumber: string,
  status: OrderStatus,
  reason?: CancelReason
): Promise<UpdateStatusResult> {
  const order = await getOrder(orderNumber);
  if (!order) return { ok: false, error: "not-found" };

  // `?? []` guards corrupt/unknown stored statuses — they become terminal.
  const allowed = ALLOWED_TRANSITIONS[order.status] ?? [];
  if (!allowed.includes(status)) {
    return {
      ok: false,
      error: "invalid-transition",
      current: order.status,
      requested: status,
    };
  }

  const updated: StoredOrder = {
    ...order,
    status,
    statusHistory: [
      ...(Array.isArray(order.statusHistory) ? order.statusHistory : []),
      {
        status,
        at: new Date().toISOString(),
        ...(reason ? { reason } : {}),
      },
    ],
  };

  await writeOrder(updated, { overwrite: true });
  return { ok: true, order: updated };
}
