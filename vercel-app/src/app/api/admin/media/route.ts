import { NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";
import {
  isAuthorizedAdminRequest,
  unauthorizedResponse,
} from "@/lib/admin/auth";

export const runtime = "nodejs";

/**
 * POST /api/admin/media — product photo upload.
 *
 * Multipart form with a single `file` field. Uploads to the PUBLIC blob
 * store `vv-media` (its own token, MEDIA_READ_WRITE_TOKEN — never the
 * private orders store) and returns the public URL for the catalog's
 * `photo` field.
 *
 * Accepts jpg/png/webp up to 4 MB. No server-side resizing — Victoria's
 * photos are product shots, and the shop already lazy-loads images.
 */

const MAX_BYTES = 4 * 1024 * 1024; // 4 MB

const ALLOWED_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** Safe basename from the original filename (extension re-derived from type). */
function safeBaseName(filename: string): string {
  const stem = filename.replace(/\.[^.]*$/, "");
  return (
    stem
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "photo"
  );
}

export async function POST(request: NextRequest) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedResponse();

  const token = process.env.MEDIA_READ_WRITE_TOKEN;
  if (!token) {
    return NextResponse.json(
      { error: "Media uploads are not configured (MEDIA_READ_WRITE_TOKEN missing)." },
      { status: 503 }
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Expected a multipart form with a `file` field." },
      { status: 400 }
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "Missing `file` field." },
      { status: 400 }
    );
  }

  const ext = ALLOWED_TYPES[file.type];
  if (!ext) {
    return NextResponse.json(
      { error: "Only JPEG, PNG or WebP images are allowed." },
      { status: 400 }
    );
  }
  if (file.size === 0 || file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: "Image must be between 1 byte and 4 MB." },
      { status: 400 }
    );
  }

  try {
    const blob = await put(`products/${safeBaseName(file.name)}.${ext}`, file, {
      access: "public",
      token,
      contentType: file.type,
      addRandomSuffix: true, // never overwrite a previous photo
    });
    return NextResponse.json({ url: blob.url }, { status: 201 });
  } catch (error) {
    console.error("[admin/media] Upload failed:", error);
    return NextResponse.json(
      { error: "Upload failed. Please try again." },
      { status: 500 }
    );
  }
}
