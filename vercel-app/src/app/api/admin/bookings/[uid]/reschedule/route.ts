import { NextRequest, NextResponse } from "next/server";
import {
  isAuthorizedAdminRequest,
  unauthorizedResponse,
} from "@/lib/admin/auth";
import { rescheduleBooking } from "@/lib/admin/cal";

/**
 * Rebooks the booking to a new start time IMMEDIATELY (Cal v2
 * POST /bookings/{uid}/reschedule). The attendee is notified by Cal.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ uid: string }> }
) {
  if (!isAuthorizedAdminRequest(request)) {
    return unauthorizedResponse();
  }

  const { uid } = await params;
  if (!uid) {
    return NextResponse.json({ error: "Missing booking uid" }, { status: 400 });
  }

  let start: unknown;
  let reason: unknown;
  try {
    const body = await request.json();
    start = body?.start;
    reason = body?.reason;
  } catch {
    // fall through to validation below
  }
  if (
    typeof start !== "string" ||
    Number.isNaN(new Date(start).getTime())
  ) {
    return NextResponse.json(
      { error: "A valid ISO start time is required" },
      { status: 400 }
    );
  }

  try {
    const result = await rescheduleBooking(
      uid,
      new Date(start).toISOString(),
      typeof reason === "string" && reason.trim() ? reason.trim() : undefined
    );
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    console.error("Admin reschedule error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
