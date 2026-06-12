import { NextRequest, NextResponse } from "next/server";
import {
  isAuthorizedAdminRequest,
  unauthorizedResponse,
} from "@/lib/admin/auth";
import {
  validateTreatmentInput,
  type TreatmentInput,
} from "@/lib/admin/treatments-input";
import {
  createCalEventType,
  type CalSyncResult,
} from "@/lib/admin/treatments-cal";
import {
  getTreatmentsCatalog,
  saveTreatmentsCatalog,
  generateTreatmentSlug,
  type Treatment,
} from "@/lib/treatments";

export const runtime = "nodejs";

/**
 * /api/admin/treatments — Victoria's treatments manager.
 *
 * GET  → the FULL catalog (inactive treatments and timestamps included).
 * POST → create a treatment. The slug is auto-generated from the EN name
 *        (kebab-case, unique) and immutable afterwards. A Cal.com event type
 *        is created for it (confirmationPolicy "always") and its id stored —
 *        BEST-EFFORT: if Cal fails the treatment is still saved with
 *        eventTypeId 0 and the response reports cal.synced=false.
 *
 * Auth: Basic (ADMIN_USER/ADMIN_PASS) or the legacy admin key — enforced by
 * the proxy AND re-checked here (defense in depth).
 *
 * The first successful save lazily persists the SEED catalog to the blob.
 */

export async function GET(request: NextRequest) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedResponse();

  try {
    const treatments = await getTreatmentsCatalog();
    return NextResponse.json({ treatments });
  } catch (error) {
    console.error("[admin/treatments] Read failed:", error);
    return NextResponse.json(
      { error: "Couldn't load the treatments. Please try again." },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedResponse();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const result = validateTreatmentInput(body, "create");
  if (!result.ok) {
    return NextResponse.json(
      { error: "Validation failed", fields: result.fields },
      { status: 400 }
    );
  }
  const input = result.value as Required<
    Pick<TreatmentInput, "name" | "durationMinutes" | "priceEgp" | "priceRub">
  > &
    TreatmentInput;

  try {
    const catalog = await getTreatmentsCatalog();
    const slug = generateTreatmentSlug(
      input.name.en,
      new Set(catalog.map((t) => t.slug))
    );

    // Create the linked Cal event type first so we can store its id.
    // Best-effort: a Cal failure still saves the treatment (eventTypeId 0)
    // and is reported in `cal` so Victoria can retry / link manually.
    const cal: CalSyncResult = await createCalEventType({
      title: input.name.en,
      slug,
      lengthInMinutes: input.durationMinutes,
      ...(input.description?.en ? { description: input.description.en } : {}),
    });

    const now = new Date().toISOString();
    const treatment: Treatment = {
      slug,
      eventTypeId: cal.synced && cal.eventTypeId ? cal.eventTypeId : 0,
      name: input.name,
      description: input.description ?? { en: "", ru: "" },
      durationMinutes: input.durationMinutes,
      priceEgp: input.priceEgp,
      priceRub: input.priceRub,
      active: input.active ?? true,
      createdAt: now,
      updatedAt: now,
    };
    catalog.push(treatment);
    await saveTreatmentsCatalog(catalog);
    return NextResponse.json(
      { treatment, cal: { synced: cal.synced, ...(cal.error ? { error: cal.error } : {}) } },
      { status: 201 }
    );
  } catch (error) {
    console.error("[admin/treatments] Create failed:", error);
    return NextResponse.json(
      { error: "Couldn't save the treatment. Please try again." },
      { status: 500 }
    );
  }
}
