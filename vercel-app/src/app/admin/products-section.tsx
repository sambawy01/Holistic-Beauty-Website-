"use client";

import { useRef, useState } from "react";
import type { Product } from "@/lib/catalog";

/**
 * Products manager — Victoria's catalog CRUD inside /admin.
 *
 * - List: photo thumb, EN name, prices, inline-editable quantity, status
 *   chips, Edit / Sold-out toggle / Delete, plus "Add product".
 * - Form (add/edit): EN+RU copy, prices, quantity (empty = untracked),
 *   photo as pasted URL OR file upload via /api/admin/media, alt texts.
 *   Slug auto-generates server-side on create and is immutable on edit.
 *
 * Auth: when Victoria came through the legacy ?key= link the key is passed
 * down and sent as x-admin-key; with Basic auth the browser re-attaches the
 * Authorization header to these same-origin fetches automatically.
 */

const SITE_BASE = "https://victoriaholisticbeauty.com/";

/* ---------- helpers ---------- */

/** Mirrors effectiveSoldOut() in @/lib/catalog (kept local — the lib pulls in the Blob SDK). */
function isSoldOut(p: Product): boolean {
  return p.soldOut || p.quantity === 0;
}

/** Resolve site-relative photo paths against the public site for thumbnails. */
function photoSrc(photo: string): string {
  if (!photo) return "";
  return /^https?:\/\//i.test(photo) ? photo : SITE_BASE + photo;
}

function authHeaders(adminKey: string): Record<string, string> {
  return adminKey ? { "x-admin-key": adminKey } : {};
}

async function readError(res: Response): Promise<string> {
  const payload = (await res.json().catch(() => null)) as {
    error?: string;
    fields?: Record<string, string>;
  } | null;
  if (payload?.fields) {
    const first = Object.values(payload.fields)[0];
    if (first) return first;
  }
  if (payload?.error) return payload.error;
  return `Request failed (${res.status})`;
}

/* ---------- status chips (earthy palette) ---------- */

function statusChips(p: Product): { label: string; cls: string }[] {
  const chips: { label: string; cls: string }[] = [];
  if (!p.active) {
    chips.push({ label: "Hidden", cls: "bg-[#3A332C]/10 text-[#3A332C]" });
  }
  if (p.soldOut) {
    chips.push({
      label: "Sold out (manual)",
      cls: "bg-[#B5483A]/15 text-[#B5483A]",
    });
  } else if (p.quantity === 0) {
    chips.push({
      label: "Sold out (0 qty)",
      cls: "bg-[#B5483A]/15 text-[#B5483A]",
    });
  }
  if (p.active && chips.length === 0) {
    chips.push({ label: "Active", cls: "bg-[#6B7A4F]/15 text-[#55633D]" });
  }
  return chips;
}

/* ---------- shared styles ---------- */

const inputCls =
  "w-full rounded-xl border border-[#3A332C]/15 bg-white px-3 py-2 text-sm text-[#3A332C] outline-none focus:border-[#8A5238]";
const labelCls =
  "mb-1 block text-xs font-medium uppercase tracking-[0.08em] text-[#847866]";
const buttonBase =
  "rounded-full px-4 py-2 text-sm font-medium transition-opacity disabled:opacity-50";
const primaryBtn = `${buttonBase} bg-[#8A5238] text-[#FDF9F3] hover:opacity-90`;
const subtleBtn = `${buttonBase} border border-[#3A332C]/15 bg-[#FFFDF9] text-[#3A332C] hover:bg-[#F4EFE7]`;
const dangerBtn = `${buttonBase} border border-[#B5483A]/30 bg-[#FFFDF9] text-[#B5483A] hover:bg-[#B5483A]/5`;

/* ---------- product form (add / edit) ---------- */

interface FormState {
  enName: string;
  enSub: string;
  enDesc: string;
  ruName: string;
  ruSub: string;
  ruDesc: string;
  priceEgp: string;
  priceRub: string;
  quantity: string; // "" = untracked
  photo: string;
  altEn: string;
  altRu: string;
  active: boolean;
}

function toFormState(p: Product | null): FormState {
  return {
    enName: p?.en.name ?? "",
    enSub: p?.en.sub ?? "",
    enDesc: p?.en.desc ?? "",
    ruName: p?.ru.name ?? "",
    ruSub: p?.ru.sub ?? "",
    ruDesc: p?.ru.desc ?? "",
    priceEgp: p ? String(p.priceEgp) : "",
    priceRub: p ? String(p.priceRub) : "",
    quantity: p && p.quantity !== null ? String(p.quantity) : "",
    photo: p?.photo ?? "",
    altEn: p?.alt.en ?? "",
    altRu: p?.alt.ru ?? "",
    active: p?.active ?? true,
  };
}

function ProductForm({
  product,
  adminKey,
  onSaved,
  onCancel,
}: {
  product: Product | null; // null = create
  adminKey: string;
  onSaved: (saved: Product) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<FormState>(() => toFormState(product));
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const set = (patch: Partial<FormState>) =>
    setForm((f) => ({ ...f, ...patch }));

  async function uploadPhoto(file: File) {
    setError(null);
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      setError("Only JPEG, PNG or WebP images are allowed.");
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      setError("Image must be at most 4 MB.");
      return;
    }
    setUploading(true);
    try {
      const data = new FormData();
      data.append("file", file);
      const res = await fetch("/api/admin/media", {
        method: "POST",
        headers: authHeaders(adminKey),
        body: data,
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      const payload = (await res.json()) as { url: string };
      set({ photo: payload.url });
    } catch {
      setError("Upload failed — network error.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function submit() {
    setError(null);
    const priceEgp = Number(form.priceEgp);
    const priceRub = Number(form.priceRub);
    if (!form.enName.trim() || !form.ruName.trim()) {
      setError("Both EN and RU names are required.");
      return;
    }
    if (!Number.isInteger(priceEgp) || priceEgp < 0 || form.priceEgp === "") {
      setError("Price (EGP) must be a whole number.");
      return;
    }
    if (!Number.isInteger(priceRub) || priceRub < 0 || form.priceRub === "") {
      setError("Price (RUB) must be a whole number.");
      return;
    }
    let quantity: number | null = null;
    if (form.quantity.trim() !== "") {
      quantity = Number(form.quantity);
      if (!Number.isInteger(quantity) || quantity < 0) {
        setError("Quantity must be a whole number (or empty for untracked).");
        return;
      }
    }

    const body = {
      en: { name: form.enName.trim(), sub: form.enSub.trim(), desc: form.enDesc.trim() },
      ru: { name: form.ruName.trim(), sub: form.ruSub.trim(), desc: form.ruDesc.trim() },
      priceEgp,
      priceRub,
      quantity,
      photo: form.photo.trim(),
      alt: { en: form.altEn.trim(), ru: form.altRu.trim() },
      active: form.active,
    };

    setBusy(true);
    try {
      const res = await fetch(
        product
          ? `/api/admin/catalog/${encodeURIComponent(product.slug)}`
          : "/api/admin/catalog",
        {
          method: product ? "PUT" : "POST",
          headers: { "Content-Type": "application/json", ...authHeaders(adminKey) },
          body: JSON.stringify(body),
        }
      );
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      const payload = (await res.json()) as { product: Product };
      onSaved(payload.product);
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-[#8A5238]/25 bg-[#FFFDF9] px-5 py-5 shadow-sm">
      <h3 className="font-serif text-xl text-[#3A332C]">
        {product ? `Edit — ${product.en.name}` : "Add product"}
      </h3>
      {product && (
        <p className="mt-1 text-xs text-[#847866]">
          Slug: <code>{product.slug}</code> (permanent)
        </p>
      )}

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-3">
          <div>
            <label className={labelCls}>Name (EN)</label>
            <input className={inputCls} value={form.enName} onChange={(e) => set({ enName: e.target.value })} />
          </div>
          <div>
            <label className={labelCls}>Subtitle (EN)</label>
            <input className={inputCls} value={form.enSub} placeholder="DM line · 150 ml" onChange={(e) => set({ enSub: e.target.value })} />
          </div>
          <div>
            <label className={labelCls}>Description (EN)</label>
            <textarea className={inputCls} rows={3} value={form.enDesc} onChange={(e) => set({ enDesc: e.target.value })} />
          </div>
        </div>
        <div className="space-y-3">
          <div>
            <label className={labelCls}>Name (RU)</label>
            <input className={inputCls} value={form.ruName} onChange={(e) => set({ ruName: e.target.value })} />
          </div>
          <div>
            <label className={labelCls}>Subtitle (RU)</label>
            <input className={inputCls} value={form.ruSub} placeholder="линия DM · 150 мл" onChange={(e) => set({ ruSub: e.target.value })} />
          </div>
          <div>
            <label className={labelCls}>Description (RU)</label>
            <textarea className={inputCls} rows={3} value={form.ruDesc} onChange={(e) => set({ ruDesc: e.target.value })} />
          </div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label className={labelCls}>Price (EGP)</label>
          <input className={inputCls} inputMode="numeric" value={form.priceEgp} onChange={(e) => set({ priceEgp: e.target.value })} />
        </div>
        <div>
          <label className={labelCls}>Price (RUB)</label>
          <input className={inputCls} inputMode="numeric" value={form.priceRub} onChange={(e) => set({ priceRub: e.target.value })} />
        </div>
        <div>
          <label className={labelCls}>Quantity (empty = untracked)</label>
          <input className={inputCls} inputMode="numeric" value={form.quantity} placeholder="—" onChange={(e) => set({ quantity: e.target.value })} />
        </div>
      </div>

      <div className="mt-4 space-y-3">
        <div>
          <label className={labelCls}>Photo — paste a URL or upload</label>
          <input
            className={inputCls}
            value={form.photo}
            placeholder="https://… or assets/img/shop/x.jpg"
            onChange={(e) => set({ photo: e.target.value })}
          />
          <div className="mt-2 flex items-center gap-3">
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="text-sm text-[#847866] file:mr-3 file:rounded-full file:border-0 file:bg-[#3A332C]/10 file:px-4 file:py-2 file:text-sm file:font-medium file:text-[#3A332C]"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void uploadPhoto(file);
              }}
            />
            {uploading && <span className="text-sm text-[#847866]">Uploading…</span>}
          </div>
          {form.photo && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={photoSrc(form.photo)}
              alt="Product preview"
              className="mt-3 h-24 w-24 rounded-xl border border-[#3A332C]/10 object-cover"
            />
          )}
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className={labelCls}>Photo alt text (EN)</label>
            <input className={inputCls} value={form.altEn} onChange={(e) => set({ altEn: e.target.value })} />
          </div>
          <div>
            <label className={labelCls}>Photo alt text (RU)</label>
            <input className={inputCls} value={form.altRu} onChange={(e) => set({ altRu: e.target.value })} />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-[#3A332C]">
          <input
            type="checkbox"
            checked={form.active}
            onChange={(e) => set({ active: e.target.checked })}
            className="h-4 w-4 accent-[#8A5238]"
          />
          Visible in the shop
        </label>
      </div>

      {error && <p className="mt-3 text-sm text-[#B5483A]">{error}</p>}

      <div className="mt-5 flex flex-wrap gap-2">
        <button type="button" disabled={busy || uploading} onClick={() => void submit()} className={primaryBtn}>
          {busy ? "Saving…" : product ? "Save changes" : "Create product"}
        </button>
        <button type="button" disabled={busy} onClick={onCancel} className={subtleBtn}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ---------- inline quantity editor ---------- */

function QuantityEditor({
  product,
  adminKey,
  onUpdated,
  onError,
}: {
  product: Product;
  adminKey: string;
  onUpdated: (p: Product) => void;
  onError: (message: string) => void;
}) {
  const [value, setValue] = useState(
    product.quantity === null ? "" : String(product.quantity)
  );
  const [busy, setBusy] = useState(false);
  const saved = product.quantity === null ? "" : String(product.quantity);
  const dirty = value.trim() !== saved;

  async function save() {
    const trimmed = value.trim();
    let quantity: number | null = null;
    if (trimmed !== "") {
      quantity = Number(trimmed);
      if (!Number.isInteger(quantity) || quantity < 0) {
        onError("Quantity must be a whole number (or empty for untracked).");
        return;
      }
    }
    setBusy(true);
    try {
      const res = await fetch(
        `/api/admin/catalog/${encodeURIComponent(product.slug)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...authHeaders(adminKey) },
          body: JSON.stringify({ quantity }),
        }
      );
      if (!res.ok) {
        onError(await readError(res));
        return;
      }
      const payload = (await res.json()) as { product: Product };
      onUpdated(payload.product);
    } catch {
      onError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <label className="text-xs text-[#847866]">Qty</label>
      <input
        className="w-16 rounded-lg border border-[#3A332C]/15 bg-white px-2 py-1 text-center text-sm text-[#3A332C] outline-none focus:border-[#8A5238]"
        inputMode="numeric"
        value={value}
        placeholder="—"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && dirty && !busy) void save();
        }}
        aria-label={`Quantity of ${product.en.name}`}
      />
      {dirty && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void save()}
          className="rounded-full bg-[#8A5238] px-2.5 py-1 text-xs font-medium text-[#FDF9F3] disabled:opacity-50"
        >
          {busy ? "…" : "Save"}
        </button>
      )}
    </span>
  );
}

/* ---------- product row ---------- */

function ProductRow({
  product,
  adminKey,
  onUpdated,
  onDeleted,
  onEdit,
}: {
  product: Product;
  adminKey: string;
  onUpdated: (p: Product) => void;
  onDeleted: (slug: string) => void;
  onEdit: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/catalog/${encodeURIComponent(product.slug)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...authHeaders(adminKey) },
          body: JSON.stringify(body),
        }
      );
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      const payload = (await res.json()) as { product: Product };
      onUpdated(payload.product);
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (
      !window.confirm(
        `Delete “${product.en.name}”? This removes it from the shop permanently. Past orders are not affected.`
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/catalog/${encodeURIComponent(product.slug)}`,
        { method: "DELETE", headers: authHeaders(adminKey) }
      );
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      onDeleted(product.slug);
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="rounded-2xl border border-[#3A332C]/10 bg-[#FFFDF9] px-4 py-4 shadow-sm sm:px-5">
      <div className="flex items-start gap-3">
        {product.photo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={photoSrc(product.photo)}
            alt={product.alt.en || product.en.name}
            className="h-16 w-16 shrink-0 rounded-xl border border-[#3A332C]/10 object-cover"
            loading="lazy"
          />
        ) : (
          <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl bg-[#E0D8CE] font-serif text-xl text-[#3A332C]">
            {product.en.name.charAt(0)}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="font-serif text-lg leading-snug text-[#3A332C]">
              {product.en.name}
            </h3>
            {statusChips(product).map((chip) => (
              <span
                key={chip.label}
                className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${chip.cls}`}
              >
                {chip.label}
              </span>
            ))}
          </div>
          <p className="mt-0.5 text-sm text-[#847866]">
            {product.priceEgp.toLocaleString("en-EG")} EGP ·{" "}
            {product.priceRub.toLocaleString("ru-RU")} RUB
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <QuantityEditor
              key={`${product.slug}-${product.quantity}`}
              product={product}
              adminKey={adminKey}
              onUpdated={onUpdated}
              onError={setError}
            />
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={onEdit} className={subtleBtn}>
          Edit
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void patch({ soldOut: !product.soldOut })}
          className={subtleBtn}
        >
          {product.soldOut ? "Mark in stock" : "Mark sold out"}
        </button>
        <button type="button" disabled={busy} onClick={() => void remove()} className={dangerBtn}>
          Delete
        </button>
      </div>

      {error && <p className="mt-3 text-sm text-[#B5483A]">{error}</p>}
    </article>
  );
}

/* ---------- section ---------- */

export default function ProductsSection({
  initialProducts,
  adminKey,
  loadError,
}: {
  initialProducts: Product[];
  adminKey: string;
  loadError: string | null;
}) {
  const [products, setProducts] = useState<Product[]>(initialProducts);
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  function handleUpdated(updated: Product) {
    setProducts((list) =>
      list.map((p) => (p.slug === updated.slug ? updated : p))
    );
    setEditingSlug(null);
  }

  function handleCreated(created: Product) {
    setProducts((list) => [...list, created]);
    setAdding(false);
  }

  function handleDeleted(slug: string) {
    setProducts((list) => list.filter((p) => p.slug !== slug));
  }

  const editing = editingSlug
    ? products.find((p) => p.slug === editingSlug) ?? null
    : null;

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-serif text-2xl text-[#3A332C]">
          Products
          {products.length > 0 && (
            <span className="ml-2 align-middle font-sans text-sm text-[#8A5238]">
              {products.length}
            </span>
          )}
        </h2>
        {!adding && !editing && (
          <button type="button" onClick={() => setAdding(true)} className={primaryBtn}>
            Add product
          </button>
        )}
      </div>

      {loadError ? (
        <div className="rounded-2xl border border-[#B5483A]/30 bg-[#FFFDF9] px-6 py-5 text-sm text-[#B5483A]">
          {loadError}
        </div>
      ) : (
        <div className="space-y-4">
          {adding && (
            <ProductForm
              product={null}
              adminKey={adminKey}
              onSaved={handleCreated}
              onCancel={() => setAdding(false)}
            />
          )}
          {editing && (
            <ProductForm
              key={editing.slug}
              product={editing}
              adminKey={adminKey}
              onSaved={handleUpdated}
              onCancel={() => setEditingSlug(null)}
            />
          )}
          {products.length === 0 && !adding ? (
            <div className="rounded-2xl border border-dashed border-[#3A332C]/15 bg-[#FFFDF9]/60 px-6 py-8 text-center text-sm text-[#847866]">
              No products yet — add the first one.
            </div>
          ) : (
            products.map((product) => (
              <ProductRow
                key={product.slug}
                product={product}
                adminKey={adminKey}
                onUpdated={handleUpdated}
                onDeleted={handleDeleted}
                onEdit={() => {
                  setAdding(false);
                  setEditingSlug(product.slug);
                }}
              />
            ))
          )}
        </div>
      )}
    </section>
  );
}
