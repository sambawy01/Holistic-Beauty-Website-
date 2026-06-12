import { NextRequest, NextResponse } from "next/server";
import {
  isAuthorizedAdminRequest,
  unauthorizedResponse,
} from "@/lib/admin/auth";
import { validateLedgerInput } from "@/lib/admin/finance-input";
import {
  removeLedgerEntry,
  updateLedgerEntry,
  type LedgerPatch,
} from "@/lib/finance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /api/admin/finance/<id> — update or hard-delete one ledger entry.
 *
 * PUT    → partial update (date, direction, category, amount, method, note,
 *          receiptUrl). id / createdAt / source are immutable.
 * DELETE → remove the entry. Ledger entries are user-owned records, so a hard
 *          delete is correct — the admin UI/assistant gate it behind a confirm.
 *
 * Auth: Basic or legacy admin key (proxy + per-route, defense in depth).
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedResponse();

  const { id } = await params;
  if (!id || !UUID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid entry id" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const result = validateLedgerInput(body, "update");
  if (!result.ok) {
    return NextResponse.json(
      { error: "Validation failed", fields: result.fields },
      { status: 400 }
    );
  }

  try {
    const entry = await updateLedgerEntry(id, result.value as LedgerPatch);
    if (!entry) {
      return NextResponse.json({ error: "Entry not found" }, { status: 404 });
    }
    return NextResponse.json({ entry });
  } catch (error) {
    console.error(`[admin/finance] Update failed (${id}):`, error);
    return NextResponse.json(
      { error: "Couldn't save the entry. Please try again." },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedResponse();

  const { id } = await params;
  if (!id || !UUID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid entry id" }, { status: 400 });
  }

  try {
    const removed = await removeLedgerEntry(id);
    if (!removed) {
      return NextResponse.json({ error: "Entry not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, id });
  } catch (error) {
    console.error(`[admin/finance] Delete failed (${id}):`, error);
    return NextResponse.json(
      { error: "Couldn't delete the entry. Please try again." },
      { status: 500 }
    );
  }
}
