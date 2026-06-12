import { listOwnerBookings, type CalBooking } from "./admin/cal";
import { listOrders, type StoredOrder } from "./orders";

/**
 * Shared data gathering for Victoria's daily brief — used by both the
 * 8am-Cairo cron email (/api/cron/daily-brief) and Vassili's `daily_brief`
 * Telegram tool, so the two views can never drift.
 *
 * Fail-soft per source: if Cal or Blob is down, the brief still renders with
 * a "couldn't load X" note instead of failing entirely.
 */

export interface DailyBriefData {
  bookings: CalBooking[];
  orders: StoredOrder[];
  failures: string[];
}

export async function gatherDailyBriefData(): Promise<DailyBriefData> {
  const failures: string[] = [];

  let bookings: CalBooking[] = [];
  try {
    bookings = await listOwnerBookings();
  } catch (error) {
    console.error("[daily-brief] Failed to load Cal bookings:", error);
    failures.push("today's bookings");
  }

  let orders: StoredOrder[] = [];
  try {
    orders = await listOrders();
  } catch (error) {
    console.error("[daily-brief] Failed to load shop orders:", error);
    failures.push("shop orders");
  }

  return { bookings, orders, failures };
}
