/**
 * Server-only Cal.com v2 event-type helpers for the treatments admin.
 *
 * All calls go to api.cal.eu (the EU instance — CALCOM_API_URL) with
 * cal-api-version 2024-06-14, the version scripts/create-event-types.mjs
 * uses for /event-types.
 *
 * Every helper here is BEST-EFFORT from the caller's perspective: the admin
 * routes save the Blob catalog first and report `cal: { synced }` in the
 * response — a Cal failure must never fail the save.
 */

const EVENT_TYPES_API_VERSION = "2024-06-14";

/** Same policy as scripts/create-event-types.mjs — Victoria confirms every booking. */
const CONFIRMATION = {
  type: "always",
  blockUnconfirmedBookingsInBooker: false,
} as const;
const LOCATIONS = [{ type: "attendeeAddress" }] as const;

export interface CalSyncResult {
  synced: boolean;
  /** Cal event type id (on create success). */
  eventTypeId?: number;
  error?: string;
}

interface CalEnv {
  apiUrl: string;
  apiKey: string;
}

function getCalEnv(): CalEnv | null {
  const apiUrl = process.env.CALCOM_API_URL;
  const apiKey = process.env.CALCOM_API_KEY;
  if (!apiUrl || !apiKey) return null;
  return { apiUrl, apiKey };
}

function calHeaders(apiKey: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    "cal-api-version": EVENT_TYPES_API_VERSION,
  };
}

async function calRequest(
  method: "POST" | "PATCH",
  path: string,
  body: Record<string, unknown>
): Promise<{ ok: boolean; status: number; data?: { id?: number }; error?: string }> {
  const env = getCalEnv();
  if (!env) {
    return { ok: false, status: 0, error: "Cal.com API not configured" };
  }
  try {
    const res = await fetch(`${env.apiUrl}${path}`, {
      method,
      headers: calHeaders(env.apiKey),
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as {
      status?: string;
      data?: { id?: number };
      error?: unknown;
    };
    if (!res.ok || json.status !== "success") {
      return {
        ok: false,
        status: res.status,
        error: `Cal ${method} ${path} -> ${res.status}: ${JSON.stringify(json).slice(0, 300)}`,
      };
    }
    return { ok: true, status: res.status, data: json.data };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Create a Cal event type for a new treatment (confirmationPolicy "always",
 * attendee-address location — like create-event-types.mjs). Returns the new
 * event type id on success.
 */
export async function createCalEventType(input: {
  title: string;
  slug: string;
  lengthInMinutes: number;
  description?: string;
}): Promise<CalSyncResult> {
  const result = await calRequest("POST", "/event-types", {
    title: input.title,
    slug: input.slug,
    lengthInMinutes: input.lengthInMinutes,
    ...(input.description ? { description: input.description } : {}),
    locations: LOCATIONS,
    confirmationPolicy: CONFIRMATION,
  });
  if (!result.ok || typeof result.data?.id !== "number") {
    return { synced: false, error: result.error ?? "Cal create returned no id" };
  }
  return { synced: true, eventTypeId: result.data.id };
}

/**
 * Patch an existing Cal event type (title / lengthInMinutes / hidden).
 * `hidden: true` is verified to work on api.cal.eu — a hidden event type stays
 * GET-able via the API but disappears from public booking pages.
 */
export async function patchCalEventType(
  eventTypeId: number,
  patch: { title?: string; lengthInMinutes?: number; hidden?: boolean }
): Promise<CalSyncResult> {
  if (!eventTypeId || eventTypeId <= 0) {
    return { synced: false, error: "Treatment has no linked Cal event type" };
  }
  if (Object.keys(patch).length === 0) {
    return { synced: true };
  }
  const result = await calRequest("PATCH", `/event-types/${eventTypeId}`, patch);
  if (!result.ok) return { synced: false, error: result.error };
  return { synced: true, eventTypeId };
}
