import { NextRequest, NextResponse } from "next/server";
import {
  isAuthorizedAdminRequest,
  unauthorizedResponse,
} from "@/lib/admin/auth";
import {
  applyTreatmentInput,
  validateTreatmentInput,
} from "@/lib/admin/treatments-input";
import {
  patchCalEventType,
  type CalSyncResult,
} from "@/lib/admin/treatments-cal";
import {
  getTreatmentsCatalog,
  saveTreatmentsCatalog,
  type Treatment,
} from "@/lib/treatments";

export const runtime = "nodejs";

/**
 * /api/admin/treatments/<slug> — update or soft-remove one treatment.
 *
 * PUT    → partial update (any of: name, description, durationMinutes,
 *          priceEgp, priceRub, active). The slug and the Cal event type link
 *          are immutable. After a successful save, changed name/duration/
 *          visibility are BEST-EFFORT synced to the linked Cal event type
 *          (title / lengthInMinutes / hidden) — a Cal failure never fails the
 *          save; the response reports `cal: { synced }`.
 * DELETE → SOFT remove: sets active=false (the treatment stays in the catalog
 *          and can be re-activated) and best-effort hides the Cal event type.
 *
 * Price changes never touch Cal — Cal event types carry no price and that
 * stays the case (price lives only in our catalog).
 */

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

function calPatchFor(
  before: Treatment,
  after: Treatment
): { title?: string; lengthInMinutes?: number; hidden?: boolean } {
  const patch: { title?: string; lengthInMinutes?: number; hidden?: boolean } =
    {};
  if (after.name.en !== before.name.en) patch.title = after.name.en;
  if (after.durationMinutes !== before.durationMinutes) {
    patch.lengthInMinutes = after.durationMinutes;
  }
  if (after.active !== before.active) patch.hidden = !after.active;
  return patch;
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedResponse();

  const { slug } = await params;
  if (!slug || !SLUG_RE.test(slug)) {
    return NextResponse.json({ error: "Invalid slug" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const result = validateTreatmentInput(body, "update");
  if (!result.ok) {
    return NextResponse.json(
      { error: "Validation failed", fields: result.fields },
      { status: 400 }
    );
  }

  try {
    const catalog = await getTreatmentsCatalog();
    const index = catalog.findIndex((t) => t.slug === slug);
    if (index === -1) {
      return NextResponse.json(
        { error: "Treatment not found" },
        { status: 404 }
      );
    }
    const before = catalog[index];
    const treatment = applyTreatmentInput(before, result.value);
    catalog[index] = treatment;
    await saveTreatmentsCatalog(catalog);

    // Best-effort Cal sync — only when something Cal carries actually changed.
    const patch = calPatchFor(before, treatment);
    const cal: CalSyncResult =
      Object.keys(patch).length > 0
        ? await patchCalEventType(treatment.eventTypeId, patch)
        : { synced: true };
    if (!cal.synced) {
      console.error(
        `[admin/treatments] Cal sync failed (${slug} → event type ${treatment.eventTypeId}):`,
        cal.error
      );
    }

    return NextResponse.json({
      treatment,
      cal: { synced: cal.synced, ...(cal.error ? { error: cal.error } : {}) },
    });
  } catch (error) {
    console.error(`[admin/treatments] Update failed (${slug}):`, error);
    return NextResponse.json(
      { error: "Couldn't save the treatment. Please try again." },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedResponse();

  const { slug } = await params;
  if (!slug || !SLUG_RE.test(slug)) {
    return NextResponse.json({ error: "Invalid slug" }, { status: 400 });
  }

  try {
    const catalog = await getTreatmentsCatalog();
    const index = catalog.findIndex((t) => t.slug === slug);
    if (index === -1) {
      return NextResponse.json(
        { error: "Treatment not found" },
        { status: 404 }
      );
    }
    const wasActive = catalog[index].active;
    const treatment: Treatment = {
      ...catalog[index],
      active: false,
      updatedAt: new Date().toISOString(),
    };
    catalog[index] = treatment;
    await saveTreatmentsCatalog(catalog);

    // Best-effort: hide the Cal event type so it can't be booked directly.
    const cal: CalSyncResult = wasActive
      ? await patchCalEventType(treatment.eventTypeId, { hidden: true })
      : { synced: true };
    if (!cal.synced) {
      console.error(
        `[admin/treatments] Cal hide failed (${slug} → event type ${treatment.eventTypeId}):`,
        cal.error
      );
    }

    return NextResponse.json({
      ok: true,
      treatment,
      cal: { synced: cal.synced, ...(cal.error ? { error: cal.error } : {}) },
    });
  } catch (error) {
    console.error(`[admin/treatments] Deactivate failed (${slug}):`, error);
    return NextResponse.json(
      { error: "Couldn't deactivate the treatment. Please try again." },
      { status: 500 }
    );
  }
}
