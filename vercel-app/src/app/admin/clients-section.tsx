"use client";

import { useEffect, useRef, useState } from "react";
import type {
  ClientProfile,
  ClientSummary,
  RebookingClient,
  UnlinkedOverlay,
} from "@/lib/crm";

/**
 * Clients manager — Victoria's private CRM inside /admin (the 6th tab).
 *
 * Profiles are DERIVED from bookings + orders (no duplicate records); this
 * view adds the stored overlay (private notes + tags) on top. Two views:
 * - "Directory": searchable list (name · last visit · #bookings · spend ·
 *   tags). Click a client → a profile card with booking + order history,
 *   notes (add / delete) and tags (add / remove).
 * - "Re-booking radar": clients overdue for a check-in, each with a suggested
 *   branded DRAFT and a copy affordance (sending stays manual — paste into an
 *   email, or ask Vassili to send via the confirmed email tool).
 *
 * PRIVATE PII: this tab is admin-only and never exposed publicly. Notes are
 * owner-private. Auth mirrors finance-section: legacy ?key= flows down as
 * x-admin-key; Basic auth re-attaches automatically to same-origin fetches.
 */

/* ---------- helpers ---------- */

function authHeaders(adminKey: string): Record<string, string> {
  return adminKey ? { "x-admin-key": adminKey } : {};
}

async function readError(res: Response): Promise<string> {
  const payload = (await res.json().catch(() => null)) as {
    error?: string;
  } | null;
  return payload?.error ?? `Request failed (${res.status})`;
}

function egp(n: number): string {
  return `${Math.round(n).toLocaleString("en-US")} EGP`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Cairo",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  })
    .format(d)
    .replace(",", "");
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Cairo",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(d)
    .replace(",", "");
}

/* ---------- shared styles ---------- */

const inputCls =
  "w-full rounded-xl border border-[#3A332C]/15 bg-white px-3 py-2 text-sm text-[#3A332C] outline-none focus:border-[#8A5238]";
const buttonBase =
  "rounded-full px-4 py-2 text-sm font-medium transition-opacity disabled:opacity-50";
const primaryBtn = `${buttonBase} bg-[#8A5238] text-[#FDF9F3] hover:opacity-90`;
const subtleBtn = `${buttonBase} border border-[#3A332C]/15 bg-[#FFFDF9] text-[#3A332C] hover:bg-[#F4EFE7]`;
const dangerBtn = `${buttonBase} border border-[#B5483A]/30 bg-[#FFFDF9] text-[#B5483A] hover:bg-[#B5483A]/5`;

/**
 * Small hint shown on phone-only profiles. Their identity rests on the last-9-
 * digit phone fallback, which can merge family members / strangers who share a
 * number — so we make that visible rather than implying a verified identity.
 */
function MatchedByPhoneHint() {
  return (
    <span
      title="No email on file — grouped by phone number (last 9 digits). This can merge people who share a number."
      className="inline-flex items-center gap-1 rounded-full bg-[#C08A2D]/12 px-2 py-0.5 text-[11px] font-medium text-[#8A6418]"
    >
      matched by phone
    </span>
  );
}

/**
 * Hint shown on an EMAIL profile that ABSORBED a phone-redirected record — a
 * phone-only record folded in because its phone appeared on this email's
 * records. The merge rested on a PHONE match (not an email match), so the
 * "verify this is one person" signal must stay visible even though the profile
 * is email-keyed (and thus NOT flagged matched-by-phone).
 */
function MergedByPhoneHint() {
  return (
    <span
      title="This profile absorbed records matched only by phone number (last 9 digits). Verify this is one person before relying on the merged history."
      className="inline-flex items-center gap-1 rounded-full bg-[#C08A2D]/12 px-2 py-0.5 text-[11px] font-medium text-[#8A6418]"
    >
      merged by phone — verify
    </span>
  );
}

function TagPill({
  tag,
  onRemove,
}: {
  tag: string;
  onRemove?: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[#6B7A4F]/12 px-2.5 py-0.5 text-xs font-medium text-[#55633D]">
      {tag}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove tag ${tag}`}
          className="text-[#55633D]/70 hover:text-[#B5483A]"
        >
          ×
        </button>
      )}
    </span>
  );
}

/* ---------- profile card ---------- */

function ProfileCard({
  clientId,
  adminKey,
  onClose,
  onOverlayChanged,
  onDeleted,
}: {
  clientId: string;
  adminKey: string;
  onClose: () => void;
  onOverlayChanged: () => void;
  onDeleted: () => void;
}) {
  const [profile, setProfile] = useState<ClientProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [noteText, setNoteText] = useState("");
  const [tagText, setTagText] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/clients/${encodeURIComponent(clientId)}`,
        { headers: authHeaders(adminKey) }
      );
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      const payload = (await res.json()) as { client: ClientProfile };
      setProfile(payload.client);
    } catch {
      setError("Network error — please try again.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  async function addNote() {
    const text = noteText.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/clients/${encodeURIComponent(clientId)}/note`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders(adminKey) },
          body: JSON.stringify({ text }),
        }
      );
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      setNoteText("");
      await load();
      onOverlayChanged();
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteNote(noteId: string) {
    if (!window.confirm("Delete this private note?")) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/clients/${encodeURIComponent(clientId)}/note/${encodeURIComponent(noteId)}`,
        { method: "DELETE", headers: authHeaders(adminKey) }
      );
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      await load();
      onOverlayChanged();
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function saveTags(tags: string[]) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/clients/${encodeURIComponent(clientId)}/tags`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...authHeaders(adminKey) },
          body: JSON.stringify({ tags }),
        }
      );
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      await load();
      onOverlayChanged();
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  }

  function addTag() {
    const t = tagText.trim().toLowerCase();
    if (!t || !profile) return;
    if (profile.tags.includes(t)) {
      setTagText("");
      return;
    }
    setTagText("");
    void saveTags([...profile.tags, t]);
  }

  async function deleteClientRecords() {
    if (
      !window.confirm(
        "Delete ALL internal records for this client — every private note and tag? " +
          "Booking and order history is kept (it lives with the scheduler/shop). " +
          "This cannot be undone."
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/clients/${encodeURIComponent(clientId)}`,
        { method: "DELETE", headers: authHeaders(adminKey) }
      );
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      onDeleted();
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-[#8A5238]/25 bg-[#FFFDF9] px-5 py-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-serif text-2xl text-[#3A332C]">
            {profile?.displayName ?? "Client"}
          </h3>
          {profile?.matchedByPhone && <MatchedByPhoneHint />}
          {profile?.reconciledFromPhone && <MergedByPhoneHint />}
        </div>
        <button type="button" onClick={onClose} className={subtleBtn}>
          Close
        </button>
      </div>

      {loading && <p className="mt-3 text-sm text-[#847866]">Loading…</p>}
      {error && <p className="mt-3 text-sm text-[#B5483A]">{error}</p>}

      {profile && (
        <div className="mt-4 space-y-5">
          {/* contact + stats */}
          <div className="grid grid-cols-1 gap-2 text-sm text-[#3A332C] sm:grid-cols-2">
            <p>
              <span className="text-[#847866]">Email:</span>{" "}
              {profile.email || "—"}
            </p>
            <p>
              <span className="text-[#847866]">Phone:</span>{" "}
              {profile.phone || "—"}
            </p>
            <p>
              <span className="text-[#847866]">Last visit:</span>{" "}
              {fmtDate(profile.lastVisit)}
            </p>
            <p>
              <span className="text-[#847866]">Next visit:</span>{" "}
              {fmtDate(profile.nextVisit)}
            </p>
            <p>
              <span className="text-[#847866]">Total spend:</span>{" "}
              {egp(profile.totalSpendEgp)}
            </p>
            <p>
              <span className="text-[#847866]">Language:</span>{" "}
              {profile.lang.toUpperCase()}
            </p>
          </div>

          {/* tags */}
          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-[0.08em] text-[#847866]">
              Tags
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {profile.tags.length === 0 && (
                <span className="text-sm text-[#847866]">No tags yet.</span>
              )}
              {profile.tags.map((t) => (
                <TagPill
                  key={t}
                  tag={t}
                  onRemove={() =>
                    void saveTags(profile.tags.filter((x) => x !== t))
                  }
                />
              ))}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <input
                className={inputCls}
                value={tagText}
                placeholder="Add a tag, e.g. vip"
                disabled={busy}
                onChange={(e) => setTagText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addTag();
                  }
                }}
              />
              <button
                type="button"
                disabled={busy || !tagText.trim()}
                onClick={addTag}
                className={subtleBtn}
              >
                Add
              </button>
            </div>
          </div>

          {/* notes */}
          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-[0.08em] text-[#847866]">
              Private notes (only you see these)
            </p>
            <div className="space-y-2">
              {profile.notes.length === 0 && (
                <p className="text-sm text-[#847866]">No notes yet.</p>
              )}
              {profile.notes.map((n) => (
                <div
                  key={n.id}
                  className="flex items-start justify-between gap-3 rounded-xl border border-[#3A332C]/10 bg-white px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="text-sm text-[#3A332C]">{n.text}</p>
                    <p className="mt-0.5 text-xs text-[#847866]">
                      {fmtDateTime(n.createdAt)}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void deleteNote(n.id)}
                    className="shrink-0 text-sm text-[#B5483A] underline"
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
            <div className="mt-2 flex items-start gap-2">
              <textarea
                className={`${inputCls} min-h-[44px]`}
                value={noteText}
                placeholder="Add a private note…"
                disabled={busy}
                onChange={(e) => setNoteText(e.target.value)}
              />
              <button
                type="button"
                disabled={busy || !noteText.trim()}
                onClick={() => void addNote()}
                className={primaryBtn}
              >
                Add note
              </button>
            </div>
          </div>

          {/* booking history */}
          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-[0.08em] text-[#847866]">
              Booking history ({profile.bookings.length})
            </p>
            <div className="space-y-1">
              {profile.bookings.length === 0 && (
                <p className="text-sm text-[#847866]">No bookings.</p>
              )}
              {profile.bookings.slice(0, 30).map((b) => (
                <p key={b.uid} className="text-sm text-[#3A332C]">
                  {fmtDateTime(b.start)} · {b.treatment} ·{" "}
                  <span className="text-[#847866]">{b.status}</span>
                </p>
              ))}
            </div>
          </div>

          {/* order history */}
          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-[0.08em] text-[#847866]">
              Order history ({profile.orders.length})
            </p>
            <div className="space-y-1">
              {profile.orders.length === 0 && (
                <p className="text-sm text-[#847866]">No orders.</p>
              )}
              {profile.orders.slice(0, 30).map((o) => (
                <p key={o.orderNumber} className="text-sm text-[#3A332C]">
                  {o.orderNumber} · {fmtDate(o.createdAt)} · {egp(o.totalEgp)} ·{" "}
                  <span className="text-[#847866]">{o.status}</span>
                  {o.items.length ? ` — ${o.items.join(", ")}` : ""}
                </p>
              ))}
            </div>
          </div>

          {/* danger zone — right to erasure */}
          <div className="border-t border-[#3A332C]/10 pt-4">
            <p className="mb-2 text-xs text-[#847866]">
              Delete this client&apos;s internal records (private notes and
              tags). Their booking and order history is kept.
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => void deleteClientRecords()}
              className={dangerBtn}
            >
              Delete client records
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- re-booking radar ---------- */

function DraftBox({ client }: { client: RebookingClient }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const draft = client.suggestedDraft;
  const full = `Subject: ${draft.subject}\n\n${draft.body}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(full);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={subtleBtn}
      >
        {open ? "Hide draft" : "Draft check-in"}
      </button>
      {open && (
        <div className="mt-2 rounded-xl border border-[#3A332C]/10 bg-white px-3 py-3">
          <p className="text-sm font-medium text-[#3A332C]">
            Subject: {draft.subject}
          </p>
          <pre className="mt-2 whitespace-pre-wrap font-sans text-sm text-[#3A332C]">
            {draft.body}
          </pre>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void copy()} className={primaryBtn}>
              {copied ? "Copied!" : "Copy draft"}
            </button>
            {client.email ? (
              <a
                href={`mailto:${encodeURIComponent(client.email)}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`}
                className={subtleBtn}
              >
                Open in email
              </a>
            ) : (
              <span className="text-xs text-[#847866]">
                No email on file — copy and send another way.
              </span>
            )}
          </div>
          <p className="mt-2 text-xs text-[#847866]">
            This is a draft for you to review. Nothing is sent automatically.
          </p>
        </div>
      )}
    </div>
  );
}

function RadarView({
  adminKey,
  initial,
  onOpenClient,
}: {
  adminKey: string;
  initial: RebookingClient[];
  onOpenClient: (clientId: string) => void;
}) {
  const [weeks, setWeeks] = useState(6);
  const [clients, setClients] = useState<RebookingClient[]>(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstLoad = useRef(true);

  async function load(targetWeeks: number) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/clients/rebooking?weeks=${targetWeeks}`,
        { headers: authHeaders(adminKey) }
      );
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      const payload = (await res.json()) as { clients: RebookingClient[] };
      setClients(payload.clients);
    } catch {
      setError("Network error — please try again.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (firstLoad.current) {
      firstLoad.current = false;
      return;
    }
    void load(weeks);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weeks]);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label className="text-xs font-medium uppercase tracking-[0.08em] text-[#847866]">
          Overdue by
        </label>
        <select
          value={weeks}
          onChange={(e) => setWeeks(Number(e.target.value))}
          className="rounded-xl border border-[#3A332C]/15 bg-white px-3 py-1.5 text-sm text-[#3A332C] outline-none focus:border-[#8A5238]"
        >
          {[4, 6, 8, 12, 16].map((w) => (
            <option key={w} value={w}>
              {w}+ weeks
            </option>
          ))}
        </select>
      </div>

      {error && <p className="mb-3 text-sm text-[#B5483A]">{error}</p>}
      {loading ? (
        <p className="text-sm text-[#847866]">Loading…</p>
      ) : clients.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-[#3A332C]/15 bg-[#FFFDF9]/60 px-6 py-8 text-center text-sm text-[#847866]">
          No clients are overdue for a check-in right now. 🌿
        </div>
      ) : (
        <div className="space-y-3">
          {clients.map((c) => (
            <article
              key={c.clientId}
              className="rounded-2xl border border-[#3A332C]/10 bg-[#FFFDF9] px-4 py-3 shadow-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <button
                    type="button"
                    onClick={() => onOpenClient(c.clientId)}
                    className="text-left text-base font-medium text-[#3A332C] underline-offset-2 hover:underline"
                  >
                    {c.displayName}
                  </button>
                  <p className="text-sm text-[#847866]">
                    {c.email || c.phone || "no contact"} · last{" "}
                    {c.lastTreatment || "visit"} {fmtDate(c.lastVisit)}
                  </p>
                </div>
                <span className="inline-block rounded-full bg-[#B5483A]/12 px-3 py-0.5 text-xs font-semibold text-[#B5483A]">
                  {c.overdueWeeks}w overdue
                </span>
              </div>
              {c.tags.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {c.tags.map((t) => (
                    <TagPill key={t} tag={t} />
                  ))}
                </div>
              )}
              <DraftBox client={c} />
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- section ---------- */

export default function ClientsSection({
  initialClients,
  initialRebooking,
  initialUnlinked,
  adminKey,
  loadError,
}: {
  initialClients: ClientSummary[];
  initialRebooking: RebookingClient[];
  initialUnlinked: UnlinkedOverlay[];
  adminKey: string;
  loadError: string | null;
}) {
  const [view, setView] = useState<"directory" | "radar">("directory");
  const [clients, setClients] = useState<ClientSummary[]>(initialClients);
  const [unlinked, setUnlinked] = useState<UnlinkedOverlay[]>(initialUnlinked);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(loadError);
  const [selected, setSelected] = useState<string | null>(null);

  async function deleteUnlinked(clientId: string) {
    if (
      !window.confirm(
        "Delete this orphaned note record (it matches no current client)? This cannot be undone."
      )
    ) {
      return;
    }
    try {
      const res = await fetch(
        `/api/admin/clients/${encodeURIComponent(clientId)}`,
        { method: "DELETE", headers: authHeaders(adminKey) }
      );
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      setUnlinked((prev) => prev.filter((u) => u.clientId !== clientId));
    } catch {
      setError("Network error — please try again.");
    }
  }

  // Debounced search against the directory endpoint.
  useEffect(() => {
    const handle = setTimeout(() => {
      void load(search);
    }, 250);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  async function load(searchTerm: string) {
    setLoading(true);
    setError(null);
    try {
      const qs = searchTerm.trim()
        ? `?search=${encodeURIComponent(searchTerm.trim())}`
        : "";
      const res = await fetch(`/api/admin/clients${qs}`, {
        headers: authHeaders(adminKey),
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      const payload = (await res.json()) as { clients: ClientSummary[] };
      setClients(payload.clients);
    } catch {
      setError("Network error — please try again.");
    } finally {
      setLoading(false);
    }
  }

  function openClient(clientId: string) {
    setView("directory");
    setSelected(clientId);
  }

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-serif text-2xl text-[#3A332C]">Clients</h2>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setView("directory")}
            className={view === "directory" ? primaryBtn : subtleBtn}
          >
            Directory
          </button>
          <button
            type="button"
            onClick={() => setView("radar")}
            className={view === "radar" ? primaryBtn : subtleBtn}
          >
            Re-booking radar
          </button>
        </div>
      </div>

      <p className="mb-4 text-sm text-[#847866]">
        Profiles are built automatically from bookings and orders. Notes and
        tags are private — clients never see them.
      </p>

      {error && (
        <div className="mb-4 rounded-2xl border border-[#B5483A]/30 bg-[#FFFDF9] px-6 py-4 text-sm text-[#B5483A]">
          {error}
        </div>
      )}

      {unlinked.length > 0 && (
        <div className="mb-4 rounded-2xl border border-[#C08A2D]/35 bg-[#FFFDF9] px-5 py-4">
          <p className="text-sm font-medium text-[#8A6418]">
            {unlinked.length} note record
            {unlinked.length === 1 ? "" : "s"} not linked to any current client
          </p>
          <p className="mt-1 text-xs text-[#847866]">
            These hold notes/tags whose client no longer resolves (e.g. a
            phone-only client whose visits aged out). Nothing is lost — review,
            then delete if no longer needed.
          </p>
          <div className="mt-3 space-y-2">
            {unlinked.map((u) => (
              <div
                key={u.clientId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#3A332C]/10 bg-white px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="text-sm text-[#3A332C]">
                    {u.noteCount} note{u.noteCount === 1 ? "" : "s"}
                    {u.tags.length ? ` · tags: ${u.tags.join(", ")}` : ""}
                  </p>
                  <p className="font-mono text-xs text-[#847866]">{u.clientId}</p>
                </div>
                <button
                  type="button"
                  onClick={() => void deleteUnlinked(u.clientId)}
                  className={dangerBtn}
                >
                  Delete records
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {view === "radar" ? (
        <RadarView
          adminKey={adminKey}
          initial={initialRebooking}
          onOpenClient={openClient}
        />
      ) : selected ? (
        <ProfileCard
          clientId={selected}
          adminKey={adminKey}
          onClose={() => setSelected(null)}
          onOverlayChanged={() => void load(search)}
          onDeleted={() => {
            setSelected(null);
            void load(search);
          }}
        />
      ) : (
        <div className="space-y-4">
          <input
            className={inputCls}
            value={search}
            placeholder="Search by name, email or phone…"
            onChange={(e) => setSearch(e.target.value)}
          />

          {loading ? (
            <p className="text-sm text-[#847866]">Loading…</p>
          ) : clients.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-[#3A332C]/15 bg-[#FFFDF9]/60 px-6 py-8 text-center text-sm text-[#847866]">
              {search.trim()
                ? `No clients match "${search.trim()}".`
                : "No clients yet — they appear here after their first booking or order."}
            </div>
          ) : (
            <div className="space-y-2">
              {clients.map((c) => (
                <button
                  key={c.clientId}
                  type="button"
                  onClick={() => setSelected(c.clientId)}
                  className="block w-full rounded-2xl border border-[#3A332C]/10 bg-[#FFFDF9] px-4 py-3 text-left shadow-sm transition-colors hover:bg-[#F4EFE7]"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-base font-medium text-[#3A332C]">
                        {c.displayName}
                      </span>
                      {c.matchedByPhone && <MatchedByPhoneHint />}
                      {c.reconciledFromPhone && <MergedByPhoneHint />}
                    </span>
                    <span className="text-sm text-[#847866]">
                      {egp(c.totalSpendEgp)}
                    </span>
                  </div>
                  <p className="text-sm text-[#847866]">
                    {c.bookingsCount} booking{c.bookingsCount === 1 ? "" : "s"} ·{" "}
                    {c.ordersCount} order{c.ordersCount === 1 ? "" : "s"} · last
                    visit {fmtDate(c.lastVisit)}
                    {c.nextVisit ? ` · next ${fmtDate(c.nextVisit)}` : ""}
                  </p>
                  {(c.tags.length > 0 || c.noteCount > 0) && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      {c.tags.map((t) => (
                        <TagPill key={t} tag={t} />
                      ))}
                      {c.noteCount > 0 && (
                        <span className="text-xs text-[#847866]">
                          {c.noteCount} note{c.noteCount === 1 ? "" : "s"}
                        </span>
                      )}
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
