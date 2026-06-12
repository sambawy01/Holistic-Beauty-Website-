import { listOwnerBookings, type CalBooking } from "./admin/cal";
import { listOrders, type StoredOrder } from "./orders";
import { rebookingRadar } from "./crm";
import type { BriefRebookingClient } from "./daily-brief-email";

/**
 * Shared data gathering for Victoria's daily brief — used by both the
 * 8am-Cairo cron email (/api/cron/daily-brief) and Vassili's `daily_brief`
 * Telegram tool, so the two views can never drift.
 *
 * Fail-soft per source: if Cal or Blob is down, the brief still renders with
 * a "couldn't load X" note instead of failing entirely. The CRM re-booking
 * radar is additive — a failure there only drops the "due for a check-in"
 * section, never the rest of the brief.
 *
 * The re-booking radar builds the WHOLE CRM directory (an extra Cal + Blob
 * scan). Callers that don't render it — the evening digest discards
 * `rebookingDue` — pass `{ includeRebooking: false }` to skip that work
 * entirely rather than build a directory only to throw it away.
 */

export interface DailyBriefData {
  bookings: CalBooking[];
  orders: StoredOrder[];
  rebookingDue: BriefRebookingClient[];
  failures: string[];
}

export interface GatherOptions {
  /** Build the CRM re-booking radar (extra Cal/Blob load). Default true. */
  includeRebooking?: boolean;
}

export async function gatherDailyBriefData(
  options: GatherOptions = {}
): Promise<DailyBriefData> {
  const includeRebooking = options.includeRebooking ?? true;
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

  let rebookingDue: BriefRebookingClient[] = [];
  if (includeRebooking) {
    try {
      const due = await rebookingRadar({ weeks: 6 });
      rebookingDue = due.map((c) => ({
        displayName: c.displayName,
        lastTreatment: c.lastTreatment,
        overdueWeeks: c.overdueWeeks,
      }));
    } catch (error) {
      console.error("[daily-brief] Failed to load re-booking radar:", error);
      // Additive section — omit it on failure rather than degrade the brief.
    }
  }

  return { bookings, orders, rebookingDue, failures };
}
