import { NextRequest, NextResponse } from "next/server";
import {
  isAuthorizedAdminRequest,
  unauthorizedResponse,
} from "@/lib/admin/auth";
import { isValidClientId, removeNote } from "@/lib/crm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * DELETE /api/admin/clients/<id>/note/<noteId> — remove one private note.
 * Admin-only; auth re-checked.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; noteId: string }> }
) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedResponse();

  const { id, noteId } = await params;
  if (!isValidClientId(id)) {
    return NextResponse.json({ error: "Invalid client id" }, { status: 400 });
  }
  if (!noteId) {
    return NextResponse.json({ error: "Invalid note id" }, { status: 400 });
  }

  try {
    const removed = await removeNote(id, noteId);
    if (!removed) {
      return NextResponse.json({ error: "Note not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, id, noteId });
  } catch (error) {
    console.error(`[admin/clients] Remove note failed (${id}/${noteId}):`, error);
    return NextResponse.json(
      { error: "Couldn't remove the note. Please try again." },
      { status: 500 }
    );
  }
}
