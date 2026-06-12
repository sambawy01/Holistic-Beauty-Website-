import { createHash } from "node:crypto";
import { del, get, list, put } from "@vercel/blob";
import { listBookingsInRange, type CalBooking } from "./admin/cal";
import { listOrders, type StoredOrder } from "./orders";
import { getTreatmentsCatalog, type Treatment } from "./treatments";
import { orderRevenueEgp } from "./reports/weekly-report";
import { listAllBlobPathnames, type BlobListPage } from "./finance";

/**
 * CRM for Victoria Vasilyeva Holistic Beauty — client profiles DERIVED from
 * existing data (Cal bookings + shop orders) plus a small STORED overlay for
 * notes and tags. There are NO duplicate client records: a profile is computed
 * on demand by merging every booking and order that resolves to the same
 * canonical identity, then merging in the per-client overlay.
 *
 * IDENTITY (the whole CRM hinges on this):
 * - Canonical key = normalized lowercase EMAIL. When a record carries no email
 *   we fall back to the normalized PHONE (digits only, last 9). Email is
 *   authoritative; the phone fallback only groups records that have no email.
 * - `clientId` = a stable 16-hex hash of the canonical key — used for Blob
 *   overlay paths and admin URLs (so a client's email never appears in a URL).
 *
 * OVERLAY STORAGE (mirrors @/lib/finance's one-blob-per-entry model):
 * - One blob per client at `crm/clients/<clientId>.json` holding
 *   `{ clientId, notes, tags, updatedAt }`. Distinct clients write distinct
 *   blobs, so two clients' overlays can never clobber each other.
 * - Within a SINGLE client, note/tag mutations are a read-modify-write on that
 *   one blob, so concurrent edits to the SAME client are serialized through an
 *   in-process per-client async lock (`withOverlayLock`) — no lost updates.
 * - Read-error semantics match the ledger EXACTLY: a missing blob (fresh
 *   client) yields an EMPTY overlay; any transient read failure THROWS (never
 *   read as "no notes" by a writer); a corrupt blob THROWS (loud corruption).
 * - All Blob I/O goes through an injectable `CrmStore` (`__setCrmStore`) and
 *   the derived sources through `__setCrmSources`, so the whole module is
 *   verifiable offline against in-memory mocks (the local BLOB token 403s on
 *   private reads — same constraint the finance harness works around).
 *
 * PRIVACY: this is PII (names, emails, phones, visit history, private notes).
 * Admin-only + Vassili owner-only. It is NEVER exposed on a public route and
 * NEVER passed to the website concierge (/api/chat). Notes are owner-private.
 */

// --- Identity normalization ---------------------------------------------------

/** Lowercased, trimmed email — "" when absent/blank. */
export function normalizeEmail(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

/**
 * Phone reduced to its last 9 digits (digits only). Egyptian/Russian numbers
 * vary by country code and formatting; the last 9 digits are the stable
 * subscriber part. "" when there are no digits.
 */
export function normalizePhone(phone: string | null | undefined): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (digits.length === 0) return "";
  return digits.length > 9 ? digits.slice(-9) : digits;
}

/**
 * Canonical identity key for a (email, phone) pair, or null when neither is
 * usable. Email wins; phone is the fallback ONLY when email is absent — so two
 * records merge on phone only if NEITHER carries an email.
 */
export function canonicalKey(
  email: string | null | undefined,
  phone: string | null | undefined
): string | null {
  const e = normalizeEmail(email);
  if (e) return `email:${e}`;
  const p = normalizePhone(phone);
  if (p) return `phone:${p}`;
  return null;
}

/** Stable 16-hex client id derived from the canonical key (Blob paths / URLs). */
export function clientIdFor(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

const CLIENT_ID_RE = /^[0-9a-f]{16}$/;

/** True for a well-formed clientId (defense in depth on URL params). */
export function isValidClientId(id: string): boolean {
  return CLIENT_ID_RE.test(id);
}

// --- Domain model -------------------------------------------------------------

export interface ClientNote {
  id: string;
  text: string;
  createdAt: string;
}

export interface ClientOverlay {
  clientId: string;
  notes: ClientNote[];
  tags: string[];
  updatedAt: string;
}

export interface ClientBookingRef {
  uid: string;
  start: string;
  status: string;
  treatment: string;
  eventTypeId: number;
}

export interface ClientOrderRef {
  orderNumber: string;
  createdAt: string;
  status: string;
  totalEgp: number;
  items: string[];
}

export interface ClientProfile {
  clientId: string;
  canonicalKey: string;
  displayName: string;
  email: string;
  phone: string;
  lang: string;
  firstSeen: string | null;
  /** Most recent PAST confirmed booking start (ISO), or null. */
  lastVisit: string | null;
  /** Soonest FUTURE confirmed booking start (ISO), or null. */
  nextVisit: string | null;
  bookingsCount: number;
  treatmentsList: string[];
  ordersCount: number;
  totalSpendEgp: number;
  lastOrderDate: string | null;
  bookings: ClientBookingRef[];
  orders: ClientOrderRef[];
  notes: ClientNote[];
  tags: string[];
}

/** Lighter shape for the list view (no full history arrays). */
export interface ClientSummary {
  clientId: string;
  displayName: string;
  email: string;
  phone: string;
  lang: string;
  lastVisit: string | null;
  nextVisit: string | null;
  bookingsCount: number;
  ordersCount: number;
  totalSpendEgp: number;
  tags: string[];
  noteCount: number;
}

export function toClientSummary(p: ClientProfile): ClientSummary {
  return {
    clientId: p.clientId,
    displayName: p.displayName,
    email: p.email,
    phone: p.phone,
    lang: p.lang,
    lastVisit: p.lastVisit,
    nextVisit: p.nextVisit,
    bookingsCount: p.bookingsCount,
    ordersCount: p.ordersCount,
    totalSpendEgp: p.totalSpendEgp,
    tags: p.tags,
    noteCount: p.notes.length,
  };
}

// --- Injectable Blob store (the overlay) --------------------------------------

export const CRM_CLIENTS_PREFIX = "crm/clients/";

function overlayPathname(clientId: string): string {
  if (!isValidClientId(clientId)) {
    throw new Error(`Invalid clientId: ${clientId}`);
  }
  return `${CRM_CLIENTS_PREFIX}${clientId}.json`;
}

/**
 * The narrow Blob surface the overlay needs. `read` returns null ONLY for a
 * true 404 (absent blob); ANY other failure throws. `list` aggregates every
 * page (cursor-walked) so a store with >1000 clients is never truncated.
 */
export interface CrmStore {
  read(pathname: string): Promise<string | null>;
  write(pathname: string, body: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  remove(pathname: string): Promise<void>;
}

const blobStore: CrmStore = {
  async read(pathname) {
    const result = await get(pathname, { access: "private", useCache: false });
    if (!result) return null;
    return new Response(result.stream).text();
  },
  async write(pathname, body) {
    await put(pathname, body, {
      access: "private",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  },
  async list(prefix) {
    const lister = (opts: {
      prefix: string;
      cursor?: string;
      limit: number;
    }): Promise<BlobListPage> => list(opts);
    return listAllBlobPathnames(prefix, lister);
  },
  async remove(pathname) {
    await del(pathname);
  },
};

let store: CrmStore = blobStore;

/** TEST-ONLY: swap the Blob store for an in-memory mock. */
export function __setCrmStore(next: CrmStore): void {
  store = next;
}

/** TEST-ONLY: restore the real @vercel/blob store. */
export function __resetCrmStore(): void {
  store = blobStore;
}

// --- Injectable derived sources (Cal + orders + treatments) -------------------

export interface CrmDataSources {
  listBookingsInRange: typeof listBookingsInRange;
  listOrders: typeof listOrders;
  getTreatmentsCatalog: typeof getTreatmentsCatalog;
}

const liveSources: CrmDataSources = {
  listBookingsInRange,
  listOrders,
  getTreatmentsCatalog,
};

let activeSources: CrmDataSources = liveSources;

/** TEST-ONLY: swap the derived data sources for seeded mocks. */
export function __setCrmSources(next: CrmDataSources): void {
  activeSources = next;
}

/** TEST-ONLY: restore the live Cal/orders/treatments sources. */
export function __resetCrmSources(): void {
  activeSources = liveSources;
}

// --- Overlay persistence ------------------------------------------------------

const MAX_NOTE_LEN = 2000;
const MAX_TAG_LEN = 40;
const MAX_TAGS = 50;

function emptyOverlay(clientId: string): ClientOverlay {
  return { clientId, notes: [], tags: [], updatedAt: "" };
}

function isValidOverlay(value: unknown): value is ClientOverlay {
  const o = value as ClientOverlay | null;
  return (
    typeof o === "object" &&
    o !== null &&
    typeof o.clientId === "string" &&
    Array.isArray(o.notes) &&
    o.notes.every(
      (n) =>
        typeof n === "object" &&
        n !== null &&
        typeof n.id === "string" &&
        typeof n.text === "string" &&
        typeof n.createdAt === "string"
    ) &&
    Array.isArray(o.tags) &&
    o.tags.every((t) => typeof t === "string") &&
    typeof o.updatedAt === "string"
  );
}

/**
 * Read one client's overlay. A missing blob (fresh client) returns an EMPTY
 * overlay. A transient read failure THROWS (never read as "no notes"); a
 * corrupt blob THROWS (loud corruption, like the ledger / orders stores).
 */
export async function getOverlay(clientId: string): Promise<ClientOverlay> {
  const text = await store.read(overlayPathname(clientId));
  if (text === null) return emptyOverlay(clientId);
  const data = JSON.parse(text) as unknown;
  if (!isValidOverlay(data)) {
    throw new Error(
      `CRM overlay blob is corrupt (${overlayPathname(clientId)}: ${JSON.stringify(data).slice(0, 200)})`
    );
  }
  return data;
}

/**
 * Read ALL overlays as a clientId→overlay map. Transient list/read failures
 * throw; an absent listed blob (raced delete) is skipped; a corrupt blob
 * throws. Used to attach overlays to a freshly-built directory in one pass.
 */
export async function listOverlays(): Promise<Map<string, ClientOverlay>> {
  const pathnames = await store.list(CRM_CLIENTS_PREFIX);
  const byId = new Map<string, ClientOverlay>();
  const read = await Promise.all(
    pathnames.map(async (p) => {
      const text = await store.read(p);
      if (text === null) return null; // raced delete — skip, not fatal
      const data = JSON.parse(text) as unknown;
      if (!isValidOverlay(data)) {
        throw new Error(`CRM overlay blob is corrupt (${p})`);
      }
      return data;
    })
  );
  for (const overlay of read) {
    if (overlay) byId.set(overlay.clientId, overlay);
  }
  return byId;
}

/**
 * Per-client async lock. Note/tag mutations read-modify-write a single client
 * blob; serializing them per clientId means two near-simultaneous adds to the
 * SAME client can never lose an update (the slower writer no longer clobbers
 * the faster one). Distinct clients never contend (distinct keys, distinct
 * blobs), so this never serializes unrelated work.
 */
const overlayLocks = new Map<string, Promise<void>>();

async function withOverlayLock<T>(
  clientId: string,
  fn: () => Promise<T>
): Promise<T> {
  const prev = overlayLocks.get(clientId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const mine = prev.then(() => gate);
  overlayLocks.set(clientId, mine);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (overlayLocks.get(clientId) === mine) overlayLocks.delete(clientId);
  }
}

async function writeOverlay(overlay: ClientOverlay): Promise<void> {
  await store.write(
    overlayPathname(overlay.clientId),
    JSON.stringify({ ...overlay, updatedAt: new Date().toISOString() }, null, 2)
  );
}

/** Append a private note. Returns the created note. */
export async function addNote(
  clientId: string,
  text: string
): Promise<ClientNote> {
  const trimmed = text.trim().slice(0, MAX_NOTE_LEN);
  if (!trimmed) throw new Error("Note text is required.");
  return withOverlayLock(clientId, async () => {
    const overlay = await getOverlay(clientId);
    const note: ClientNote = {
      id: crypto.randomUUID(),
      text: trimmed,
      createdAt: new Date().toISOString(),
    };
    const next: ClientOverlay = { ...overlay, notes: [...overlay.notes, note] };
    await writeOverlay(next);
    return note;
  });
}

/** Remove a note by id. Returns true when something was removed. */
export async function removeNote(
  clientId: string,
  noteId: string
): Promise<boolean> {
  return withOverlayLock(clientId, async () => {
    const overlay = await getOverlay(clientId);
    const remaining = overlay.notes.filter((n) => n.id !== noteId);
    if (remaining.length === overlay.notes.length) return false;
    await writeOverlay({ ...overlay, notes: remaining });
    return true;
  });
}

/** Normalize a tag: lowercase, single-spaced, trimmed, length-capped. */
export function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/\s+/g, " ").slice(0, MAX_TAG_LEN);
}

/** Replace the whole tag set (deduped, normalized, capped). */
export async function setTags(
  clientId: string,
  tags: string[]
): Promise<string[]> {
  const cleaned = dedupeTags(tags.map(normalizeTag).filter(Boolean)).slice(
    0,
    MAX_TAGS
  );
  return withOverlayLock(clientId, async () => {
    const overlay = await getOverlay(clientId);
    await writeOverlay({ ...overlay, tags: cleaned });
    return cleaned;
  });
}

/** Add one tag (no-op when already present). Returns the resulting tag set. */
export async function addTag(
  clientId: string,
  tag: string
): Promise<string[]> {
  const t = normalizeTag(tag);
  if (!t) throw new Error("Tag is required.");
  return withOverlayLock(clientId, async () => {
    const overlay = await getOverlay(clientId);
    if (overlay.tags.includes(t)) return overlay.tags;
    const next = dedupeTags([...overlay.tags, t]).slice(0, MAX_TAGS);
    await writeOverlay({ ...overlay, tags: next });
    return next;
  });
}

/** Remove one tag. Returns the resulting tag set. */
export async function removeTag(
  clientId: string,
  tag: string
): Promise<string[]> {
  const t = normalizeTag(tag);
  return withOverlayLock(clientId, async () => {
    const overlay = await getOverlay(clientId);
    const next = overlay.tags.filter((x) => x !== t);
    await writeOverlay({ ...overlay, tags: next });
    return next;
  });
}

function dedupeTags(tags: string[]): string[] {
  return [...new Set(tags)];
}

// --- Profile derivation -------------------------------------------------------

/** "Facial Massage between Victoria Vasilyeva and X" → "Facial Massage". */
function serviceTitle(booking: CalBooking): string {
  const title = booking.title || "Booking";
  const idx = title.indexOf(" between ");
  return idx > 0 ? title.slice(0, idx) : title;
}

/** Phone field off a Cal booking's responses (best effort). */
function bookingPhone(b: CalBooking): string {
  const v = b.bookingFieldsResponses?.["attendeePhoneNumber"];
  return typeof v === "string" ? v.trim() : "";
}

/** Booking language hint from metadata / responses; defaults to "en". */
function bookingLang(b: CalBooking): string {
  const meta = (b as unknown as { metadata?: { lang?: unknown } }).metadata;
  if (meta && typeof meta.lang === "string" && meta.lang.trim()) {
    return meta.lang.trim().toLowerCase();
  }
  const r = b.bookingFieldsResponses?.["lang"];
  if (typeof r === "string" && r.trim()) return r.trim().toLowerCase();
  return "en";
}

interface NameCandidate {
  name: string;
  at: number;
}

/** Most recent non-empty name across all of a client's records. */
function pickDisplayName(candidates: NameCandidate[]): string {
  const named = candidates
    .filter((c) => c.name.trim().length > 0)
    .sort((a, b) => b.at - a.at);
  return named[0]?.name.trim() ?? "Unknown";
}

interface ClientAccumulator {
  canonicalKey: string;
  clientId: string;
  emails: Set<string>;
  phones: Set<string>;
  names: NameCandidate[];
  langs: NameCandidate[];
  bookings: ClientBookingRef[];
  orders: ClientOrderRef[];
}

function getAcc(
  map: Map<string, ClientAccumulator>,
  key: string
): ClientAccumulator {
  let acc = map.get(key);
  if (!acc) {
    acc = {
      canonicalKey: key,
      clientId: clientIdFor(key),
      emails: new Set(),
      phones: new Set(),
      names: [],
      langs: [],
      bookings: [],
      orders: [],
    };
    map.set(key, acc);
  }
  return acc;
}

export interface BuildOptions {
  now?: Date;
  sources?: CrmDataSources;
  /** Days of history to scan back / ahead when gathering bookings. */
  lookbackDays?: number;
  lookaheadDays?: number;
}

/**
 * Build every client profile from live (or injected) Cal bookings + shop
 * orders, with overlays merged in. Pure aggregation beyond the source reads —
 * fully testable with seeded sources + an in-memory overlay store.
 */
async function buildProfilesWithOverlay(
  options: BuildOptions = {}
): Promise<ClientProfile[]> {
  const sources = options.sources ?? activeSources;
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const lookbackDays = options.lookbackDays ?? 730;
  const lookaheadDays = options.lookaheadDays ?? 365;
  const DAY = 86_400_000;

  const [bookings, orders, treatments, overlays] = await Promise.all([
    sources.listBookingsInRange(
      new Date(now.getTime() - lookbackDays * DAY).toISOString(),
      new Date(now.getTime() + lookaheadDays * DAY).toISOString(),
      500
    ),
    sources.listOrders({ limit: 500 }),
    sources.getTreatmentsCatalog(),
    listOverlays(),
  ]);

  const priceByEventTypeId = new Map<number, string>();
  for (const t of treatments) {
    if (typeof t.eventTypeId === "number") {
      priceByEventTypeId.set(t.eventTypeId, t.name.en);
    }
  }

  const map = new Map<string, ClientAccumulator>();

  for (const b of bookings) {
    const attendee = b.attendees?.[0];
    const email = attendee?.email ?? "";
    const phone = bookingPhone(b);
    const key = canonicalKey(email, phone);
    if (!key) continue;
    const acc = getAcc(map, key);
    if (normalizeEmail(email)) acc.emails.add(normalizeEmail(email));
    if (normalizePhone(phone)) acc.phones.add(phone.trim());
    const at = new Date(b.start).getTime();
    acc.names.push({ name: attendee?.name ?? "", at: Number.isNaN(at) ? 0 : at });
    acc.langs.push({ name: bookingLang(b), at: Number.isNaN(at) ? 0 : at });
    const treatment =
      (typeof b.eventTypeId === "number" &&
        priceByEventTypeId.get(b.eventTypeId)) ||
      serviceTitle(b);
    acc.bookings.push({
      uid: b.uid,
      start: b.start,
      status: (b.status || "").toLowerCase(),
      treatment,
      eventTypeId: typeof b.eventTypeId === "number" ? b.eventTypeId : 0,
    });
  }

  for (const o of orders) {
    const key = canonicalKey(o.email, o.phone);
    if (!key) continue;
    const acc = getAcc(map, key);
    if (normalizeEmail(o.email)) acc.emails.add(normalizeEmail(o.email));
    if (normalizePhone(o.phone)) acc.phones.add((o.phone ?? "").trim());
    const at = new Date(o.createdAt).getTime();
    acc.names.push({ name: o.name ?? "", at: Number.isNaN(at) ? 0 : at });
    if (o.lang) acc.langs.push({ name: o.lang, at: Number.isNaN(at) ? 0 : at });
    acc.orders.push({
      orderNumber: o.orderNumber,
      createdAt: o.createdAt,
      status: o.status,
      totalEgp: Number.isFinite(o.totals?.egp) ? o.totals.egp : 0,
      items: o.items.map((i) => i.names.en),
    });
  }

  const profiles: ClientProfile[] = [];
  for (const acc of map.values()) {
    const confirmedBookings = acc.bookings.filter(
      (b) => b.status === "accepted"
    );
    const pastConfirmed = confirmedBookings
      .filter((b) => b.start < nowIso)
      .sort((a, b) => b.start.localeCompare(a.start));
    const futureConfirmed = confirmedBookings
      .filter((b) => b.start >= nowIso)
      .sort((a, b) => a.start.localeCompare(b.start));

    const allStarts = acc.bookings.map((b) => b.start);
    const allOrderDates = acc.orders.map((o) => o.createdAt);
    const firstSeen =
      [...allStarts, ...allOrderDates].sort((a, b) => a.localeCompare(b))[0] ??
      null;

    const ordersByDate = acc.orders
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const lastOrderDate = ordersByDate[0]?.createdAt ?? null;

    // totalSpend reuses the SINGLE revenue rule (orderRevenueEgp /
    // ORDER_REVENUE_STATUSES) so a client's spend matches the P&L exactly.
    const totalSpendEgp = orderRevenueEgp(
      acc.orders.map(
        (o) =>
          ({
            status: o.status,
            totals: { egp: o.totalEgp, rub: 0 },
          }) as StoredOrder
      )
    );

    const treatmentsList = [
      ...new Set(confirmedBookings.map((b) => b.treatment).filter(Boolean)),
    ];

    const overlay = overlays.get(acc.clientId);

    const langPick = pickDisplayName(acc.langs);
    const lang = langPick && langPick !== "Unknown" ? langPick : "en";

    profiles.push({
      clientId: acc.clientId,
      canonicalKey: acc.canonicalKey,
      displayName: pickDisplayName(acc.names),
      email: [...acc.emails][0] ?? "",
      phone: [...acc.phones][0] ?? "",
      lang,
      firstSeen,
      lastVisit: pastConfirmed[0]?.start ?? null,
      nextVisit: futureConfirmed[0]?.start ?? null,
      bookingsCount: acc.bookings.length,
      treatmentsList,
      ordersCount: acc.orders.length,
      totalSpendEgp,
      lastOrderDate,
      bookings: acc.bookings
        .slice()
        .sort((a, b) => b.start.localeCompare(a.start)),
      orders: ordersByDate,
      notes: overlay?.notes ?? [],
      tags: overlay?.tags ?? [],
    });
  }

  return profiles;
}

/** Latest-activity timestamp for default sort (visit or order, whichever newer). */
function lastActivity(p: ClientProfile): string {
  return (
    [p.lastVisit, p.nextVisit, p.lastOrderDate, p.firstSeen]
      .filter((x): x is string => Boolean(x))
      .sort((a, b) => b.localeCompare(a))[0] ?? ""
  );
}

/** Build the full client directory (profiles + overlay) and the radar at once. */
export async function getClientsOverview(
  options: BuildOptions & { weeks?: number } = {}
): Promise<{ profiles: ClientProfile[]; rebooking: RebookingClient[] }> {
  const profiles = await buildProfilesWithOverlay(options);
  profiles.sort((a, b) => lastActivity(b).localeCompare(lastActivity(a)));
  const rebooking = computeRebookingRadar(profiles, {
    weeks: options.weeks ?? 6,
    now: options.now,
  });
  return { profiles, rebooking };
}

/**
 * List profiles, optionally filtered by a free-text search (name / email /
 * phone, case-insensitive) and/or a tag. Sorted by most-recent activity.
 */
export async function listClientProfiles(
  filter: { search?: string; tag?: string } = {},
  options: BuildOptions = {}
): Promise<ClientProfile[]> {
  const { profiles } = await getClientsOverview(options);
  const search = (filter.search ?? "").trim().toLowerCase();
  const searchDigits = search.replace(/\D/g, "");
  const tag = filter.tag ? normalizeTag(filter.tag) : "";
  return profiles.filter((p) => {
    if (tag && !p.tags.includes(tag)) return false;
    if (!search) return true;
    if (p.displayName.toLowerCase().includes(search)) return true;
    if (p.email.toLowerCase().includes(search)) return true;
    if (
      searchDigits.length >= 3 &&
      p.phone.replace(/\D/g, "").includes(searchDigits)
    ) {
      return true;
    }
    return false;
  });
}

/** One profile by clientId (with overlay), or null when no record resolves. */
export async function getClientProfile(
  clientId: string,
  options: BuildOptions = {}
): Promise<ClientProfile | null> {
  if (!isValidClientId(clientId)) return null;
  const { profiles } = await getClientsOverview(options);
  return profiles.find((p) => p.clientId === clientId) ?? null;
}

/**
 * Resolve a free-text identifier (clientId, email or name/phone substring) to
 * matching profiles — the seam Vassili's tools use to act by name. Returns all
 * matches so the caller can refuse an ambiguous mutation.
 */
export async function resolveClients(
  identifier: string,
  options: BuildOptions = {}
): Promise<ClientProfile[]> {
  const id = identifier.trim();
  if (isValidClientId(id)) {
    const one = await getClientProfile(id, options);
    return one ? [one] : [];
  }
  return listClientProfiles({ search: id }, options);
}

// --- Re-booking radar ---------------------------------------------------------

export interface RebookingClient {
  clientId: string;
  displayName: string;
  email: string;
  phone: string;
  lang: string;
  lastVisit: string;
  lastTreatment: string;
  overdueWeeks: number;
  totalSpendEgp: number;
  tags: string[];
  suggestedDraft: { subject: string; body: string };
}

const WEEK_MS = 7 * 86_400_000;

/**
 * Clients due for a check-in: a past confirmed visit older than `weeks` weeks,
 * AND no upcoming confirmed booking. Most-overdue first. Each carries a
 * suggested branded check-in draft (Victoria sends it via the email tool).
 */
export function computeRebookingRadar(
  profiles: ClientProfile[],
  options: { weeks?: number; now?: Date } = {}
): RebookingClient[] {
  const weeks = options.weeks ?? 6;
  const now = options.now ?? new Date();
  const cutoffMs = now.getTime() - weeks * WEEK_MS;

  const due: RebookingClient[] = [];
  for (const p of profiles) {
    if (!p.lastVisit) continue; // needs at least one past confirmed booking
    if (p.nextVisit) continue; // already re-booked
    const lastMs = new Date(p.lastVisit).getTime();
    if (Number.isNaN(lastMs) || lastMs > cutoffMs) continue; // too recent
    const overdueWeeks = Math.floor((now.getTime() - lastMs) / WEEK_MS);
    const lastTreatment =
      p.bookings.find((b) => b.start === p.lastVisit)?.treatment ??
      p.treatmentsList[0] ??
      "";
    due.push({
      clientId: p.clientId,
      displayName: p.displayName,
      email: p.email,
      phone: p.phone,
      lang: p.lang,
      lastVisit: p.lastVisit,
      lastTreatment,
      overdueWeeks,
      totalSpendEgp: p.totalSpendEgp,
      tags: p.tags,
      suggestedDraft: composeCheckInDraft(p, lastTreatment),
    });
  }
  return due.sort((a, b) => b.overdueWeeks - a.overdueWeeks);
}

/** Live re-booking radar (builds the directory, then computes). */
export async function rebookingRadar(
  options: BuildOptions & { weeks?: number } = {}
): Promise<RebookingClient[]> {
  const { rebooking } = await getClientsOverview(options);
  return rebooking;
}

// --- Branded draft composition (DRAFT ONLY — never sends) ----------------------

function firstName(displayName: string): string {
  const n = displayName.trim();
  if (!n || n === "Unknown") return "";
  return n.split(/\s+/)[0];
}

/**
 * A warm re-booking check-in DRAFT (subject + plain-text body). Reflects the
 * persona's rules: women-only studio, no medical claims, consultations point
 * to Victoria. EN/RU by the client's language hint. This is a DRAFT for
 * Victoria to review — nothing is sent here.
 */
export function composeCheckInDraft(
  profile: Pick<ClientProfile, "displayName" | "lang">,
  lastTreatment: string
): { subject: string; body: string } {
  const ru = (profile.lang || "en").startsWith("ru");
  const name = firstName(profile.displayName);
  const treatment = lastTreatment.trim();

  if (ru) {
    const hi = name ? `Здравствуйте, ${name}!` : "Здравствуйте!";
    const ref = treatment
      ? `С нашей последней встречи («${treatment}») прошло некоторое время, и я подумала о вас.`
      : "С нашей последней встречи прошло некоторое время, и я подумала о вас.";
    return {
      subject: "Пора побаловать себя — Victoria Vasilyeva Holistic Beauty",
      body: [
        hi,
        "",
        ref,
        "Будет чудесно снова видеть вас в студии. Если захотите подобрать удобное время или обсудить уход индивидуально, я всегда рада помочь.",
        "",
        "Записаться можно онлайн: https://book.victoriaholisticbeauty.com/book",
        "",
        "С теплом,",
        "Виктория",
      ].join("\n"),
    };
  }

  const hi = name ? `Hi ${name},` : "Hello,";
  const ref = treatment
    ? `It has been a little while since your last visit (${treatment}), and you came to mind.`
    : "It has been a little while since your last visit, and you came to mind.";
  return {
    subject: "Time to treat yourself — Victoria Vasilyeva Holistic Beauty",
    body: [
      hi,
      "",
      ref,
      "I would love to welcome you back to the studio. If you would like to find a time that suits you, or talk through what your skin needs right now, I am always happy to help.",
      "",
      "You can book online any time: https://book.victoriaholisticbeauty.com/book",
      "",
      "Warmly,",
      "Victoria",
    ].join("\n"),
  };
}

/**
 * A general client email DRAFT for a given intent (check-in / reply / custom).
 * Returns subject + plain-text body for Victoria to review; it does NOT send
 * (she sends via the existing email_send tool, which keeps the third-party
 * confirm gate). Keeps the women-only + consultation persona rules.
 */
export function composeClientDraft(
  profile: Pick<
    ClientProfile,
    "displayName" | "lang" | "lastVisit" | "treatmentsList"
  >,
  intent: "checkin" | "reply" | "thanks" | "custom",
  message?: string,
  now: Date = new Date()
): { subject: string; body: string } {
  if (intent === "checkin") {
    const lastTreatment = profile.treatmentsList[0] ?? "";
    return composeCheckInDraft(profile, lastTreatment);
  }

  const ru = (profile.lang || "en").startsWith("ru");
  const name = firstName(profile.displayName);
  const extra = (message ?? "").trim();

  if (intent === "thanks") {
    if (ru) {
      return {
        subject: "Спасибо, что были у нас — Victoria Vasilyeva Holistic Beauty",
        body: [
          name ? `Здравствуйте, ${name}!` : "Здравствуйте!",
          "",
          "Спасибо, что доверились мне и выбрали студию. Мне было очень приятно работать с вами.",
          extra ? `\n${extra}` : "",
          "",
          "С теплом,",
          "Виктория",
        ]
          .filter((l) => l !== "")
          .join("\n"),
      };
    }
    return {
      subject: "Thank you for visiting — Victoria Vasilyeva Holistic Beauty",
      body: [
        name ? `Hi ${name},` : "Hello,",
        "",
        "Thank you for trusting me and choosing the studio — it was a pleasure to look after you.",
        extra ? `\n${extra}` : "",
        "",
        "Warmly,",
        "Victoria",
      ]
        .filter((l) => l !== "")
        .join("\n"),
    };
  }

  // reply / custom — frame the owner's message in the branded voice.
  if (ru) {
    return {
      subject: "Сообщение от Victoria Vasilyeva Holistic Beauty",
      body: [
        name ? `Здравствуйте, ${name}!` : "Здравствуйте!",
        "",
        extra || "(добавьте текст сообщения)",
        "",
        "С теплом,",
        "Виктория",
      ].join("\n"),
    };
  }
  return {
    subject: "A message from Victoria Vasilyeva Holistic Beauty",
    body: [
      name ? `Hi ${name},` : "Hello,",
      "",
      extra || "(add your message here)",
      "",
      "Warmly,",
      "Victoria",
    ].join("\n"),
  };
}
