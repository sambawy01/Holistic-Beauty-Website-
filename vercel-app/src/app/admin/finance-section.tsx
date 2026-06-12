"use client";

import { useEffect, useRef, useState } from "react";
import type { PnL } from "@/lib/finance-report";
import type { LedgerEntry, LedgerDirection } from "@/lib/finance";

/**
 * Finance manager — Victoria's private ledger + live P&L inside /admin.
 *
 * - Month selector drives a GET /api/admin/finance?month=YYYY-MM that returns
 *   the P&L (summary numbers AND the in-range manual entries) in one fetch.
 * - Summary cards: Revenue (split shop / treatments / manual) · Expenses · Net.
 * - Entries table with add / edit / delete; the add/edit form uploads a
 *   receipt photo via the existing /api/admin/media route.
 * - Export CSV + Generate P&L PDF download the current month's documents.
 *
 * Auth mirrors products-section: legacy ?key= flows down as x-admin-key;
 * Basic auth re-attaches automatically to same-origin fetches.
 *
 * The category constants are duplicated here (not imported from @/lib/finance)
 * because that module pulls in the Vercel Blob SDK — exactly the reason
 * products-section re-declares its sold-out rule locally.
 */

const EXPENSE_CATEGORIES = [
  "rent",
  "supplies",
  "product-stock",
  "marketing",
  "salaries",
  "utilities",
  "bank-fees",
  "other",
] as const;
const INCOME_CATEGORIES = ["treatment-cash", "gift-card", "other"] as const;
const PAYMENT_METHODS = ["cash", "bank-transfer", "card", "other"] as const;

const SITE_BASE = "https://victoriaholisticbeauty.com/";

/* ---------- helpers ---------- */

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

function egp(n: number): string {
  return `${Math.round(n).toLocaleString("en-US")} EGP`;
}

function categoriesFor(direction: LedgerDirection): readonly string[] {
  return direction === "expense" ? EXPENSE_CATEGORIES : INCOME_CATEGORIES;
}

function photoSrc(url: string): string {
  if (!url) return "";
  return /^https?:\/\//i.test(url) ? url : SITE_BASE + url;
}

/** Current Cairo month as YYYY-MM. */
function currentCairoMonth(): string {
  const key = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return key.slice(0, 7);
}

function labelCategory(c: string): string {
  return c.replace(/-/g, " ");
}

function labelMethod(m: string): string {
  return m.replace(/-/g, " ");
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

/* ---------- summary cards ---------- */

function SummaryCards({ pnl }: { pnl: PnL }) {
  const cards = [
    {
      label: "Revenue",
      value: egp(pnl.revenue.totalEgp),
      cls: "bg-[#6B7A4F]/10 border-[#6B7A4F]/25 text-[#55633D]",
      sub: [
        `Shop ${egp(pnl.revenue.shopEgp)}`,
        `Treatments ${egp(pnl.revenue.treatmentsEgp)}`,
        `Other ${egp(pnl.revenue.manualIncomeEgp)}`,
      ],
    },
    {
      label: "Expenses",
      value: egp(pnl.expenses.totalEgp),
      cls: "bg-[#B5483A]/10 border-[#B5483A]/25 text-[#B5483A]",
      sub: pnl.expenses.byCategory
        .slice(0, 3)
        .map((c) => `${labelCategory(c.category)} ${egp(c.amountEgp)}`),
    },
    {
      label: pnl.netEgp >= 0 ? "Net profit" : "Net loss",
      value: egp(Math.abs(pnl.netEgp)),
      cls:
        pnl.netEgp >= 0
          ? "bg-[#8A5238]/10 border-[#8A5238]/25 text-[#8A5238]"
          : "bg-[#B5483A]/10 border-[#B5483A]/25 text-[#B5483A]",
      sub: [`${pnl.counts.confirmedBookings} confirmed bookings`, `${pnl.counts.revenueOrders} paid orders`],
    },
  ];
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {cards.map((card) => (
        <div key={card.label} className={`rounded-2xl border px-4 py-4 ${card.cls}`}>
          <p className="text-xs font-medium uppercase tracking-[0.1em] opacity-80">
            {card.label}
          </p>
          <p className="mt-1 font-serif text-2xl">{card.value}</p>
          <div className="mt-2 space-y-0.5">
            {card.sub.map((s) => (
              <p key={s} className="text-xs opacity-80">
                {s}
              </p>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------- entry form (add / edit) ---------- */

interface FormState {
  date: string;
  direction: LedgerDirection;
  category: string;
  amountEgp: string;
  method: string;
  note: string;
  receiptUrl: string;
}

function toFormState(entry: LedgerEntry | null, month: string): FormState {
  if (entry) {
    return {
      date: entry.date,
      direction: entry.direction,
      category: entry.category,
      amountEgp: String(entry.amountEgp),
      method: entry.method,
      note: entry.note,
      receiptUrl: entry.receiptUrl ?? "",
    };
  }
  // Default new-entry date: today if it falls in the selected month, else the
  // first of that month.
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return {
    date: today.startsWith(month) ? today : `${month}-01`,
    direction: "expense",
    category: "supplies",
    amountEgp: "",
    method: "cash",
    note: "",
    receiptUrl: "",
  };
}

function EntryForm({
  entry,
  month,
  adminKey,
  onSaved,
  onCancel,
}: {
  entry: LedgerEntry | null;
  month: string;
  adminKey: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<FormState>(() => toFormState(entry, month));
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const set = (patch: Partial<FormState>) =>
    setForm((f) => ({ ...f, ...patch }));

  function changeDirection(direction: LedgerDirection) {
    // Keep the chosen category valid for the new direction.
    const cats = categoriesFor(direction);
    set({
      direction,
      category: cats.includes(form.category) ? form.category : cats[0],
    });
  }

  async function uploadReceipt(file: File) {
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
      set({ receiptUrl: payload.url });
    } catch {
      setError("Upload failed — network error.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function submit() {
    setError(null);
    const amount = Number(form.amountEgp);
    if (!form.amountEgp.trim() || !Number.isFinite(amount) || amount <= 0) {
      setError("Amount must be a positive number.");
      return;
    }

    const body = {
      date: form.date,
      direction: form.direction,
      category: form.category,
      amountEgp: amount,
      method: form.method,
      note: form.note.trim(),
      receiptUrl: form.receiptUrl.trim() || null,
    };

    setBusy(true);
    try {
      const res = await fetch(
        entry
          ? `/api/admin/finance/${encodeURIComponent(entry.id)}`
          : "/api/admin/finance",
        {
          method: entry ? "PUT" : "POST",
          headers: { "Content-Type": "application/json", ...authHeaders(adminKey) },
          body: JSON.stringify(body),
        }
      );
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      onSaved();
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  }

  const cats = categoriesFor(form.direction);

  return (
    <div className="rounded-2xl border border-[#8A5238]/25 bg-[#FFFDF9] px-5 py-5 shadow-sm">
      <h3 className="font-serif text-xl text-[#3A332C]">
        {entry ? "Edit entry" : "Add entry"}
      </h3>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className={labelCls}>Type</label>
          <select
            className={inputCls}
            value={form.direction}
            onChange={(e) => changeDirection(e.target.value as LedgerDirection)}
          >
            <option value="expense">Expense</option>
            <option value="income">Income (cash / off-platform)</option>
          </select>
        </div>
        <div>
          <label className={labelCls}>Category</label>
          <select
            className={inputCls}
            value={form.category}
            onChange={(e) => set({ category: e.target.value })}
          >
            {cats.map((c) => (
              <option key={c} value={c}>
                {labelCategory(c)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>Amount (EGP)</label>
          <input
            className={inputCls}
            inputMode="decimal"
            value={form.amountEgp}
            placeholder="0"
            onChange={(e) => set({ amountEgp: e.target.value })}
          />
        </div>
        <div>
          <label className={labelCls}>Method</label>
          <select
            className={inputCls}
            value={form.method}
            onChange={(e) => set({ method: e.target.value })}
          >
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {labelMethod(m)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>Date</label>
          <input
            className={inputCls}
            type="date"
            value={form.date}
            onChange={(e) => set({ date: e.target.value })}
          />
        </div>
        <div>
          <label className={labelCls}>Note (optional)</label>
          <input
            className={inputCls}
            value={form.note}
            placeholder="e.g. Onmacabim restock"
            onChange={(e) => set({ note: e.target.value })}
          />
        </div>
      </div>

      <div className="mt-4">
        <label className={labelCls}>Receipt photo (optional)</label>
        <div className="flex items-center gap-3">
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="text-sm text-[#847866] file:mr-3 file:rounded-full file:border-0 file:bg-[#3A332C]/10 file:px-4 file:py-2 file:text-sm file:font-medium file:text-[#3A332C]"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void uploadReceipt(file);
            }}
          />
          {uploading && <span className="text-sm text-[#847866]">Uploading…</span>}
        </div>
        {form.receiptUrl && (
          <div className="mt-3 flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photoSrc(form.receiptUrl)}
              alt="Receipt preview"
              className="h-20 w-20 rounded-xl border border-[#3A332C]/10 object-cover"
            />
            <button
              type="button"
              onClick={() => set({ receiptUrl: "" })}
              className="text-sm text-[#B5483A] underline"
            >
              Remove
            </button>
          </div>
        )}
      </div>

      {error && <p className="mt-3 text-sm text-[#B5483A]">{error}</p>}

      <div className="mt-5 flex flex-wrap gap-2">
        <button type="button" disabled={busy || uploading} onClick={() => void submit()} className={primaryBtn}>
          {busy ? "Saving…" : entry ? "Save changes" : "Add entry"}
        </button>
        <button type="button" disabled={busy} onClick={onCancel} className={subtleBtn}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ---------- entry row ---------- */

function EntryRow({
  entry,
  adminKey,
  onChanged,
  onEdit,
}: {
  entry: LedgerEntry;
  adminKey: string;
  onChanged: () => void;
  onEdit: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    if (
      !window.confirm(
        `Delete this ${entry.direction} of ${egp(entry.amountEgp)} on ${entry.date}? This permanently removes the ledger entry.`
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/finance/${encodeURIComponent(entry.id)}`,
        { method: "DELETE", headers: authHeaders(adminKey) }
      );
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      onChanged();
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  }

  const isExpense = entry.direction === "expense";
  return (
    <article className="rounded-2xl border border-[#3A332C]/10 bg-[#FFFDF9] px-4 py-3 shadow-sm">
      <div className="flex items-start gap-3">
        {entry.receiptUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={photoSrc(entry.receiptUrl)}
            alt="Receipt"
            className="h-12 w-12 shrink-0 rounded-lg border border-[#3A332C]/10 object-cover"
            loading="lazy"
          />
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span
              className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${
                isExpense
                  ? "bg-[#B5483A]/15 text-[#B5483A]"
                  : "bg-[#6B7A4F]/15 text-[#55633D]"
              }`}
            >
              {isExpense ? "−" : "+"} {egp(entry.amountEgp)}
            </span>
            <span className="text-sm font-medium text-[#3A332C]">
              {labelCategory(entry.category)}
            </span>
            <span className="text-xs text-[#847866]">
              {entry.date} · {labelMethod(entry.method)}
            </span>
          </div>
          {entry.note && (
            <p className="mt-0.5 truncate text-sm text-[#847866]">{entry.note}</p>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          <button type="button" disabled={busy} onClick={onEdit} className={subtleBtn}>
            Edit
          </button>
          <button type="button" disabled={busy} onClick={() => void remove()} className={dangerBtn}>
            Delete
          </button>
        </div>
      </div>
      {error && <p className="mt-2 text-sm text-[#B5483A]">{error}</p>}
    </article>
  );
}

/* ---------- section ---------- */

export default function FinanceSection({
  initialPnl,
  adminKey,
  loadError,
}: {
  initialPnl: PnL | null;
  adminKey: string;
  loadError: string | null;
}) {
  const [month, setMonth] = useState<string>(
    () => initialPnl?.period.tag ?? currentCairoMonth()
  );
  const [pnl, setPnl] = useState<PnL | null>(initialPnl);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(loadError);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<"csv" | "pdf" | null>(null);
  // Skip the very first fetch when the server already provided this month.
  const firstLoad = useRef(initialPnl !== null);

  async function load(targetMonth: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/finance?month=${encodeURIComponent(targetMonth)}`,
        { headers: authHeaders(adminKey) }
      );
      if (!res.ok) {
        setError(await readError(res));
        setPnl(null);
        return;
      }
      const payload = (await res.json()) as { pnl: PnL };
      setPnl(payload.pnl);
    } catch {
      setError("Network error — please try again.");
      setPnl(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (firstLoad.current) {
      firstLoad.current = false;
      return;
    }
    void load(month);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);

  function refresh() {
    setAdding(false);
    setEditingId(null);
    void load(month);
  }

  async function download(kind: "csv" | "pdf") {
    setDownloading(kind);
    setError(null);
    try {
      const path = kind === "csv" ? "export" : "pdf";
      const res = await fetch(
        `/api/admin/finance/${path}?month=${encodeURIComponent(month)}`,
        { headers: authHeaders(adminKey) }
      );
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `pnl-${month}.${kind}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError("Download failed — network error.");
    } finally {
      setDownloading(null);
    }
  }

  const editing =
    editingId && pnl ? pnl.entries.find((e) => e.id === editingId) ?? null : null;

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-serif text-2xl text-[#3A332C]">Finance</h2>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs font-medium uppercase tracking-[0.08em] text-[#847866]">
            Month
          </label>
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value || currentCairoMonth())}
            className="rounded-xl border border-[#3A332C]/15 bg-white px-3 py-1.5 text-sm text-[#3A332C] outline-none focus:border-[#8A5238]"
          />
        </div>
      </div>

      {pnl && (
        <div className="mb-4 space-y-4">
          <SummaryCards pnl={pnl} />
          {pnl.failures.length > 0 && (
            <div className="rounded-xl border border-[#E5DCCB] bg-[#F4EFE7] px-4 py-2 text-sm text-[#847866]">
              Heads up: couldn&apos;t load {pnl.failures.join(", ")} — some numbers may be incomplete.
            </div>
          )}
          {pnl.revenue.unmatchedBookings > 0 && (
            <div className="rounded-xl border border-[#E5DCCB] bg-[#F4EFE7] px-4 py-2 text-sm text-[#847866]">
              {pnl.revenue.unmatchedBookings} confirmed booking
              {pnl.revenue.unmatchedBookings === 1 ? "" : "s"} had no matching
              catalogue price and {pnl.revenue.unmatchedBookings === 1 ? "was" : "were"}{" "}
              excluded from treatment revenue. Link the service to a treatment so it
              counts.
            </div>
          )}
          {month === currentCairoMonth() && (
            <div className="rounded-xl border border-[#E5DCCB] bg-[#F4EFE7] px-4 py-2 text-sm text-[#847866]">
              Month-to-date: confirmed bookings still upcoming this month are counted
              as earned revenue (confirmed = earned).
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {!adding && !editing && (
              <button type="button" onClick={() => setAdding(true)} className={primaryBtn}>
                Add entry
              </button>
            )}
            <button
              type="button"
              disabled={downloading !== null}
              onClick={() => void download("csv")}
              className={subtleBtn}
            >
              {downloading === "csv" ? "Preparing…" : "Export CSV"}
            </button>
            <button
              type="button"
              disabled={downloading !== null}
              onClick={() => void download("pdf")}
              className={subtleBtn}
            >
              {downloading === "pdf" ? "Generating…" : "Generate P&L PDF"}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-2xl border border-[#B5483A]/30 bg-[#FFFDF9] px-6 py-4 text-sm text-[#B5483A]">
          {error}
        </div>
      )}

      <div className="space-y-4">
        {adding && (
          <EntryForm
            entry={null}
            month={month}
            adminKey={adminKey}
            onSaved={refresh}
            onCancel={() => setAdding(false)}
          />
        )}
        {editing && (
          <EntryForm
            key={editing.id}
            entry={editing}
            month={month}
            adminKey={adminKey}
            onSaved={refresh}
            onCancel={() => setEditingId(null)}
          />
        )}

        {loading ? (
          <p className="text-sm text-[#847866]">Loading…</p>
        ) : pnl && pnl.entries.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[#3A332C]/15 bg-[#FFFDF9]/60 px-6 py-8 text-center text-sm text-[#847866]">
            No manual entries this month. Platform income (shop &amp; treatments) is
            counted automatically in the summary above.
          </div>
        ) : (
          pnl?.entries.map((entry) => (
            <EntryRow
              key={entry.id}
              entry={entry}
              adminKey={adminKey}
              onChanged={refresh}
              onEdit={() => {
                setAdding(false);
                setEditingId(entry.id);
              }}
            />
          ))
        )}
      </div>
    </section>
  );
}
