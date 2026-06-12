import { NextRequest, NextResponse } from "next/server";
import {
  isAuthorizedAdminRequest,
  unauthorizedResponse,
} from "@/lib/admin/auth";
import { addNote, isValidClientId } from "@/lib/crm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/clients/<id>/note — add a private, owner-only note.
 * Notes are never shown to the client. Admin-only; auth re-checked.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedResponse();

  const { id } = await params;
  if (!isValidClientId(id)) {
    return NextResponse.json({ error: "Invalid client id" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const text =
    typeof (body as { text?: unknown })?.text === "string"
      ? (body as { text: string }).text.trim()
      : "";
  if (!text) {
    return NextResponse.json(
      { error: "Note text is required." },
      { status: 400 }
    );
  }

  try {
    const note = await addNote(id, text);
    return NextResponse.json({ note }, { status: 201 });
  } catch (error) {
    console.error(`[admin/clients] Add note failed (${id}):`, error);
    return NextResponse.json(
      { error: "Couldn't save the note. Please try again." },
      { status: 500 }
    );
  }
}
