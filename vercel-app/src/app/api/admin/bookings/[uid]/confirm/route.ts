import { NextRequest, NextResponse } from "next/server";
import {
  isAuthorizedAdminRequest,
  unauthorizedResponse,
} from "@/lib/admin/auth";
import { confirmBooking } from "@/lib/admin/cal";

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

  try {
    const result = await confirmBooking(uid);
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    console.error("Admin confirm error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
