import { NextRequest, NextResponse } from "next/server";
import {
  isAuthorizedAdminRequest,
  unauthorizedResponse,
} from "@/lib/admin/auth";
import { isValidClientId, setTags } from "@/lib/crm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PUT /api/admin/clients/<id>/tags — replace the whole tag set for a client.
 * Body: { tags: string[] }. Tags are normalized (lowercased, deduped) and
 * length-capped server-side. Admin-only; auth re-checked.
 */
export async function PUT(
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

  const raw = (body as { tags?: unknown })?.tags;
  if (!Array.isArray(raw) || !raw.every((t) => typeof t === "string")) {
    return NextResponse.json(
      { error: "tags must be an array of strings" },
      { status: 400 }
    );
  }

  try {
    const tags = await setTags(id, raw as string[]);
    return NextResponse.json({ tags });
  } catch (error) {
    console.error(`[admin/clients] Set tags failed (${id}):`, error);
    return NextResponse.json(
      { error: "Couldn't save the tags. Please try again." },
      { status: 500 }
    );
  }
}
