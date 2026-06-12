import { createHmac } from "node:crypto";
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
 * - `clientId` = a stable 16-hex HMAC-SHA256 of the canonical key, keyed by a
 *   server secret (CRON_SECRET). Used for Blob overlay paths and admin URLs so
 *   a client's email never appears in a URL AND the id is not a plain offline
 *   hash anyone can recompute from a guessed email/phone. See `crmIdSecret`.
 * - PHONE→EMAIL reconciliation: a phone-only client who later books WITH an
 *   email would otherwise SPLIT into two profiles (phone-key vs email-key) and
 *   the phone-keyed overlay could orphan once the phone-only records age out.
 *   buildProfilesWithOverlay therefore (a) folds phone-only records into the
 *   email profile when that phone appears on ANY email-bearing record, and
 *   (b) attaches the phone-keyed overlay to the merged email profile. Any
 *   overlay that still matches NO profile is SURFACED as "unlinked" (never
 *   silently dropped).
 *
 * OVERLAY STORAGE (one-blob-per-NOTE, mirroring @/lib/finance's one-blob-per-
 * entry model — chosen specifically to kill the lost-update race):
 * - TAGS live in one small per-client blob `crm/clients/<clientId>.json`
 *   holding `{ clientId, tags, updatedAt }`. Tag mutations read-modify-write
 *   that one blob; the in-process per-client lock (`withOverlayLock`) serializes
 *   same-instance edits. Across serverless instances that lock does NOT hold —
 *   a tag write can still be lost in a true cross-instance race, accepted as a
 *   LOW-COST tradeoff (a re-applied tag is cheap; a lost note is not).
 * - NOTES are each their OWN blob `crm/clients/<clientId>/notes/<noteId>.json`
 *   holding `{ id, text, createdAt }`. addNote writes a fresh blob with a fresh
 *   id, so there is NO read-modify-write window and NO lock needed: two (or
 *   five) concurrent addNote calls — even on different serverless instances —
 *   can never clobber each other. A profile's notes are ASSEMBLED on read by
 *   listing the per-client notes prefix. This is the fix for the "silently
 *   loses Victoria's notes" race the single-document overlay had.
 * - Read-error semantics match the ledger EXACTLY: a missing blob (fresh
 *   client) yields an EMPTY overlay; any transient read/list failure THROWS
 *   (never read as "no notes" by a writer); a corrupt blob THROWS (loud
 *   corruption).
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

/**
 * Secret that keys the clientId HMAC. We REUSE `CRON_SECRET` (an existing
 * server-only secret, always present in prod) so a clientId can't be
 * recomputed offline from a guessed email/phone the way a plain sha256 could.
 *
 * Fail-closed: in production an absent secret THROWS (refusing to derive ids
 * with an empty key — that would be equivalent to the old offline hash). In
 * non-production (local dev / the offline verify harness) we fall back to a
 * fixed, clearly-non-secret dev key so ids stay deterministic without prod
 * env. The harness sets CRON_SECRET explicitly to exercise the real path.
 */
const CRM_ID_DEV_FALLBACK_SECRET = "crm-dev-insecure-clientid-secret";

function crmIdSecret(): string {
  const secret = process.env.CRON_SECRET ?? "";
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "CRM clientId secret missing: set CRON_SECRET. Refusing to derive client ids with an empty key in production."
    );
  }
  return CRM_ID_DEV_FALLBACK_SECRET;
}

/**
 * Stable 16-hex client id derived from the canonical key (Blob paths / URLs),
 * as a keyed HMAC-SHA256 (see `crmIdSecret`). Deterministic for a given
 * (key, secret); validated downstream by `isValidClientId`.
 */
export function clientIdFor(key: string): string {
  return createHmac("sha256", crmIdSecret()).update(key).digest("hex").slice(0, 16);
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
  /**
   * True when this profile was grouped on the PHONE fallback (no email on any
   * record) — its identity rests on the last-9-digits match, which can merge
   * family members / strangers sharing a number. Surfaced in the UI as a hint.
   */
  matchedByPhone: boolean;
  /**
   * True when this EMAIL-keyed profile ABSORBED at least one phone-redirected
   * record — a phone-only record folded in because its phone appeared on an
   * email-bearing record (see phoneToEmailKey reconciliation). The profile key
   * is `email:…` so `matchedByPhone` is false, yet the commingling risk is
   * highest here: a PHONE match (not an email match) pulled extra records in.
   * Surfaced as its own hint so the "verify this is one person" signal does not
   * vanish exactly when it matters most. NOT gated on name equality (names vary
   * by spelling / transliteration).
   */
  reconciledFromPhone: boolean;
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
  matchedByPhone: boolean;
  reconciledFromPhone: boolean;
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
    matchedByPhone: p.matchedByPhone,
    reconciledFromPhone: p.reconciledFromPhone,
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

/**
 * An overlay (notes/tags) whose clientId resolves to NO current profile — e.g.
 * a phone-only client whose records aged out before they returned with an
 * email. Surfaced (never silently dropped) so Victoria can re-link or erase it.
 */
export interface UnlinkedOverlay {
  clientId: string;
  noteCount: number;
  tags: string[];
  notes: ClientNote[];
}

// --- Injectable Blob store (the overlay) --------------------------------------

export const CRM_CLIENTS_PREFIX = "crm/clients/";

/** Per-client TAG overlay blob: `crm/clients/<clientId>.json`. */
function overlayPathname(clientId: string): string {
  if (!isValidClientId(clientId)) {
    throw new Error(`Invalid clientId: ${clientId}`);
  }
  return `${CRM_CLIENTS_PREFIX}${clientId}.json`;
}

/** Notes prefix for one client: `crm/clients/<clientId>/notes/`. */
function notesPrefix(clientId: string): string {
  if (!isValidClientId(clientId)) {
    throw new Error(`Invalid clientId: ${clientId}`);
  }
  return `${CRM_CLIENTS_PREFIX}${clientId}/notes/`;
}

/** noteId charset guard (defense in depth on the blob path). */
const NOTE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** One NOTE blob: `crm/clients/<clientId>/notes/<noteId>.json`. */
function notePathname(clientId: string, noteId: string): string {
  if (!isValidClientId(clientId)) {
    throw new Error(`Invalid clientId: ${clientId}`);
  }
  if (!NOTE_ID_RE.test(noteId)) {
    throw new Error(`Invalid noteId: ${noteId}`);
  }
  return `${notesPrefix(clientId)}${noteId}.json`;
}

/**
 * Parse a `crm/clients/…` pathname into the clientId + kind. Distinguishes the
 * per-client TAG overlay (`<id>.json`) from a NOTE (`<id>/notes/<noteId>.json`)
 * so a single prefix list can be partitioned. Returns null for anything that
 * doesn't match either shape (never mis-attributed).
 */
function parseCrmPathname(
  pathname: string
): { clientId: string; kind: "overlay" } | { clientId: string; kind: "note"; noteId: string } | null {
  if (!pathname.startsWith(CRM_CLIENTS_PREFIX)) return null;
  const rest = pathname.slice(CRM_CLIENTS_PREFIX.length);
  const overlay = /^([0-9a-f]{16})\.json$/.exec(rest);
  if (overlay) return { clientId: overlay[1], kind: "overlay" };
  const note = /^([0-9a-f]{16})\/notes\/([A-Za-z0-9_-]{1,64})\.json$/.exec(rest);
  if (note) return { clientId: note[1], kind: "note", noteId: note[2] };
  return null;
}

// --- Input sanitization -------------------------------------------------------

/**
 * Control / formatting characters stripped from note + tag INPUT. Covers C0
 * controls (newline \n is KEPT — notes may legitimately span lines), DEL,
 * zero-width characters, and Unicode bidi overrides/isolates that could spoof
 * how a stored value renders later (admin UI or a future export). Any future
 * CRM CSV/PDF export MUST additionally reuse the finance `csvField`
 * formula-injection guard for leading `= + - @`.
 */
const CONTROL_CHARS_RE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0009\u000B-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;

export function stripControlChars(value: string): string {
  return value.replace(CONTROL_CHARS_RE, "");
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

/** Stored TAG-overlay shape (the small per-client blob). Notes are NOT here. */
interface StoredTagOverlay {
  clientId: string;
  tags: string[];
  updatedAt: string;
}

function emptyTagOverlay(clientId: string): StoredTagOverlay {
  return { clientId, tags: [], updatedAt: "" };
}

function isValidTagOverlay(value: unknown): value is StoredTagOverlay {
  const o = value as StoredTagOverlay | null;
  return (
    typeof o === "object" &&
    o !== null &&
    typeof o.clientId === "string" &&
    Array.isArray(o.tags) &&
    o.tags.every((t) => typeof t === "string") &&
    typeof o.updatedAt === "string"
  );
}

function isValidStoredNote(value: unknown): value is ClientNote {
  const n = value as ClientNote | null;
  return (
    typeof n === "object" &&
    n !== null &&
    typeof n.id === "string" &&
    typeof n.text === "string" &&
    typeof n.createdAt === "string"
  );
}

/** Read+validate ONE client's tag-overlay blob; empty when absent. */
async function readTagOverlay(clientId: string): Promise<StoredTagOverlay> {
  const path = overlayPathname(clientId);
  const text = await store.read(path);
  if (text === null) return emptyTagOverlay(clientId);
  const data = JSON.parse(text) as unknown;
  if (!isValidTagOverlay(data)) {
    throw new Error(
      `CRM tag-overlay blob is corrupt (${path}: ${JSON.stringify(data).slice(0, 200)})`
    );
  }
  return data;
}

/** Read+validate ONE note blob; null when the listed blob raced a delete. */
async function readNoteBlob(pathname: string): Promise<ClientNote | null> {
  const text = await store.read(pathname);
  if (text === null) return null;
  const data = JSON.parse(text) as unknown;
  if (!isValidStoredNote(data)) {
    throw new Error(`CRM note blob is corrupt (${pathname})`);
  }
  return data;
}

/** Assemble ONE client's notes (oldest→newest) from their per-note blobs. */
async function listNotesForClient(clientId: string): Promise<ClientNote[]> {
  const pathnames = await store.list(notesPrefix(clientId));
  const read = await Promise.all(pathnames.map(readNoteBlob));
  return read
    .filter((n): n is ClientNote => n !== null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Read one client's FULL overlay (tags + assembled notes). A fresh client
 * yields an EMPTY overlay. A transient read/list failure THROWS (never read as
 * "no notes"); a corrupt blob THROWS (loud corruption, like the ledger).
 */
export async function getOverlay(clientId: string): Promise<ClientOverlay> {
  const [tagOverlay, notes] = await Promise.all([
    readTagOverlay(clientId),
    listNotesForClient(clientId),
  ]);
  return {
    clientId,
    notes,
    tags: tagOverlay.tags,
    updatedAt: tagOverlay.updatedAt,
  };
}

/**
 * Read ALL overlays as a clientId→overlay map, assembling each client's tags
 * (from its overlay blob) AND notes (from its per-note blobs) in ONE prefix
 * walk. Transient list/read failures throw; an absent listed blob (raced
 * delete) is skipped; a corrupt blob throws. Used to attach overlays to a
 * freshly-built directory in a single pass.
 */
export async function listOverlays(): Promise<Map<string, ClientOverlay>> {
  const pathnames = await store.list(CRM_CLIENTS_PREFIX);

  const tagsById = new Map<string, StoredTagOverlay>();
  const notesById = new Map<string, ClientNote[]>();
  // Track every clientId that has ANY blob, so a notes-only client (overlay
  // blob never written — notes don't write one) still surfaces.
  const seen = new Set<string>();

  await Promise.all(
    pathnames.map(async (p) => {
      const parsed = parseCrmPathname(p);
      if (!parsed) return; // unknown shape under the prefix — ignore, never guess
      const text = await store.read(p);
      if (text === null) return; // raced delete — skip, not fatal
      const data = JSON.parse(text) as unknown;
      seen.add(parsed.clientId);
      if (parsed.kind === "overlay") {
        if (!isValidTagOverlay(data)) {
          throw new Error(`CRM tag-overlay blob is corrupt (${p})`);
        }
        tagsById.set(parsed.clientId, data);
      } else {
        if (!isValidStoredNote(data)) {
          throw new Error(`CRM note blob is corrupt (${p})`);
        }
        const arr = notesById.get(parsed.clientId) ?? [];
        arr.push(data);
        notesById.set(parsed.clientId, arr);
      }
    })
  );

  const byId = new Map<string, ClientOverlay>();
  for (const clientId of seen) {
    const tagOverlay = tagsById.get(clientId);
    const notes = (notesById.get(clientId) ?? []).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt)
    );
    byId.set(clientId, {
      clientId,
      notes,
      tags: tagOverlay?.tags ?? [],
      updatedAt: tagOverlay?.updatedAt ?? "",
    });
  }
  return byId;
}

/**
 * Per-client async lock — used ONLY by the TAG mutations, which read-modify-
 * write the single tag-overlay blob. Serializing same-instance tag edits stops
 * the slower writer clobbering the faster one. NOTE: across serverless
 * instances this in-process lock does NOT hold, so a tag write can still be
 * lost in a true cross-instance race — accepted as a LOW-COST tradeoff (a tag
 * is cheap to re-apply). NOTES never take this lock: each addNote writes its
 * OWN blob, so there is no read-modify-write window to serialize at all.
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

async function writeTagOverlay(clientId: string, tags: string[]): Promise<void> {
  const overlay: StoredTagOverlay = {
    clientId,
    tags,
    updatedAt: new Date().toISOString(),
  };
  await store.write(overlayPathname(clientId), JSON.stringify(overlay, null, 2));
}

/**
 * Append a private note as its OWN blob (`…/notes/<noteId>.json`). No lock and
 * no read-modify-write: each call writes a distinct blob with a distinct id, so
 * N concurrent addNote calls — even across serverless instances — ALL persist
 * (this is the fix for the silent lost-note race). Control chars are stripped
 * on input. Returns the created note.
 */
export async function addNote(
  clientId: string,
  text: string
): Promise<ClientNote> {
  const trimmed = stripControlChars(text).trim().slice(0, MAX_NOTE_LEN);
  if (!trimmed) throw new Error("Note text is required.");
  const note: ClientNote = {
    id: crypto.randomUUID(),
    text: trimmed,
    createdAt: new Date().toISOString(),
  };
  await store.write(
    notePathname(clientId, note.id),
    JSON.stringify(note, null, 2)
  );
  return note;
}

/** Remove a note by id (deletes its blob). Returns true when one was removed. */
export async function removeNote(
  clientId: string,
  noteId: string
): Promise<boolean> {
  if (!NOTE_ID_RE.test(noteId)) return false;
  const path = notePathname(clientId, noteId);
  const existing = await store.read(path);
  if (existing === null) return false;
  await store.remove(path);
  return true;
}

/** Normalize a tag: strip control chars, lowercase, single-spaced, capped. */
export function normalizeTag(tag: string): string {
  return stripControlChars(tag)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .slice(0, MAX_TAG_LEN);
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
    await writeTagOverlay(clientId, cleaned);
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
    const overlay = await readTagOverlay(clientId);
    if (overlay.tags.includes(t)) return overlay.tags;
    const next = dedupeTags([...overlay.tags, t]).slice(0, MAX_TAGS);
    await writeTagOverlay(clientId, next);
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
    const overlay = await readTagOverlay(clientId);
    const next = overlay.tags.filter((x) => x !== t);
    await writeTagOverlay(clientId, next);
    return next;
  });
}

function dedupeTags(tags: string[]): string[] {
  return [...new Set(tags)];
}

/**
 * Right-to-erasure: delete ALL of a client's internal records (every note blob
 * under their notes prefix + the tag-overlay blob). Returns how many blobs were
 * removed. Also the cleanup path for an ORPHANED overlay (no live profile), so
 * it never requires a resolvable profile — it operates purely on the clientId.
 */
export async function deleteClientRecords(
  clientId: string
): Promise<{ removed: number }> {
  if (!isValidClientId(clientId)) {
    throw new Error(`Invalid clientId: ${clientId}`);
  }
  const notePaths = await store.list(notesPrefix(clientId));
  let removed = 0;
  for (const p of notePaths) {
    await store.remove(p);
    removed++;
  }
  // Remove the tag overlay if present (read first so we can report accurately).
  const overlayPath = overlayPathname(clientId);
  if ((await store.read(overlayPath)) !== null) {
    await store.remove(overlayPath);
    removed++;
  }
  return { removed };
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
  /** Set true once a phone-redirected record folds into this email profile. */
  reconciledFromPhone: boolean;
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
      reconciledFromPhone: false,
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
 * Normalize a timestamp to canonical UTC ISO (`…Z`). Cal can hand back an
 * offset form (`+02:00`); comparing those as raw strings against a `…Z` "now"
 * would sort wrong and could flip a booking across the past/future boundary.
 * Normalizing every booking start at ingestion makes all downstream string
 * comparisons (and equality with `lastVisit`) chronologically correct. Falls
 * back to the original string if it isn't a parseable date.
 */
function toIso(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toISOString();
}

/**
 * Build every client profile from live (or injected) Cal bookings + shop
 * orders, with overlays merged in, PLUS any overlay that matches no profile
 * ("unlinked"). Pure aggregation beyond the source reads — fully testable with
 * seeded sources + an in-memory overlay store.
 *
 * Identity reconciliation: a phone that appears on ANY email-bearing record is
 * folded into that email-keyed profile, so a phone-only client who later books
 * with an email does NOT split into two profiles. The phone-keyed overlay is
 * then attached to the merged profile; an overlay matching no profile at all is
 * surfaced as `unlinked` rather than silently dropped.
 */
async function buildProfilesWithOverlay(
  options: BuildOptions = {}
): Promise<{ profiles: ClientProfile[]; unlinked: UnlinkedOverlay[] }> {
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

  // PASS 1 — phone → email-key reconciliation. Any record carrying BOTH an
  // email and a phone teaches us that this phone belongs to that email profile;
  // first email wins for a shared phone (rare; documented).
  const phoneToEmailKey = new Map<string, string>();
  function learnPhoneEmail(
    email: string | null | undefined,
    phone: string | null | undefined
  ): void {
    const e = normalizeEmail(email);
    const p = normalizePhone(phone);
    if (e && p && !phoneToEmailKey.has(p)) phoneToEmailKey.set(p, `email:${e}`);
  }
  for (const b of bookings) {
    learnPhoneEmail(b.attendees?.[0]?.email, bookingPhone(b));
  }
  for (const o of orders) {
    learnPhoneEmail(o.email, o.phone);
  }

  /** Canonical key, redirecting a reconciled phone-only key onto its email. */
  function resolveKey(
    email: string | null | undefined,
    phone: string | null | undefined
  ): string | null {
    const key = canonicalKey(email, phone);
    if (!key) return null;
    if (key.startsWith("phone:")) {
      const redirect = phoneToEmailKey.get(key.slice("phone:".length));
      if (redirect) return redirect;
    }
    return key;
  }

  // PASS 2 — accumulate records under their (reconciled) key.
  const map = new Map<string, ClientAccumulator>();

  for (const b of bookings) {
    const attendee = b.attendees?.[0];
    const email = attendee?.email ?? "";
    const phone = bookingPhone(b);
    const key = resolveKey(email, phone);
    if (!key) continue;
    const acc = getAcc(map, key);
    // A record carrying NO email of its own that lands under an EMAIL key was
    // folded in by phone→email reconciliation (F-1): flag the absorbing profile.
    if (key.startsWith("email:") && !normalizeEmail(email)) {
      acc.reconciledFromPhone = true;
    }
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
      start: toIso(b.start),
      status: (b.status || "").toLowerCase(),
      treatment,
      eventTypeId: typeof b.eventTypeId === "number" ? b.eventTypeId : 0,
    });
  }

  for (const o of orders) {
    const key = resolveKey(o.email, o.phone);
    if (!key) continue;
    const acc = getAcc(map, key);
    if (key.startsWith("email:") && !normalizeEmail(o.email)) {
      acc.reconciledFromPhone = true;
    }
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

  // Track which overlay clientIds we attach, so the rest can surface as unlinked.
  const consumed = new Set<string>();

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

    // Attach overlays from the canonical clientId AND every phone-keyed id this
    // client owns — so a phone-only client's notes follow them once they gain
    // an email (the phone-keyed overlay merges into the email profile).
    //
    // F-2: when TWO emails share a phone (A=E1/P and B=E2/P), BOTH accumulate P
    // in their phones set, so BOTH would otherwise compute the same phone-keyed
    // id and attach the SAME phone-era overlay → the notes duplicate onto two
    // cards. A phone CLAIMED by an email in phoneToEmailKey (first-wins) belongs
    // to exactly ONE profile — only the WINNING email may attach that phone's
    // overlay; the loser must not. A phone NO email claimed (claimedBy
    // undefined) belongs to its own phone-keyed profile, already covered by
    // acc.clientId. If the winner has no live profile the overlay stays
    // unconsumed and surfaces as `unlinked` below — never duplicated, never
    // silently dropped.
    const candidateIds = new Set<string>([acc.clientId]);
    for (const rawPhone of acc.phones) {
      const phoneKey = canonicalKey("", rawPhone);
      if (!phoneKey) continue;
      const claimedBy = phoneToEmailKey.get(phoneKey.slice("phone:".length));
      if (claimedBy && claimedBy !== acc.canonicalKey) continue; // not the winner
      candidateIds.add(clientIdFor(phoneKey));
    }
    const mergedNotes: ClientNote[] = [];
    const mergedTags = new Set<string>();
    for (const cid of candidateIds) {
      const ov = overlays.get(cid);
      if (!ov) continue;
      consumed.add(cid);
      for (const n of ov.notes) mergedNotes.push(n);
      for (const t of ov.tags) mergedTags.add(t);
    }
    mergedNotes.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const langPick = pickDisplayName(acc.langs);
    const lang = langPick && langPick !== "Unknown" ? langPick : "en";

    profiles.push({
      clientId: acc.clientId,
      canonicalKey: acc.canonicalKey,
      displayName: pickDisplayName(acc.names),
      email: [...acc.emails][0] ?? "",
      phone: [...acc.phones][0] ?? "",
      matchedByPhone: acc.canonicalKey.startsWith("phone:"),
      reconciledFromPhone: acc.reconciledFromPhone,
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
      notes: mergedNotes,
      tags: [...mergedTags],
    });
  }

  // Any overlay (with notes OR tags) not attached above is orphaned — surface
  // it so private notes are NEVER silently lost.
  const unlinked: UnlinkedOverlay[] = [];
  for (const [cid, ov] of overlays) {
    if (consumed.has(cid)) continue;
    if (ov.notes.length === 0 && ov.tags.length === 0) continue;
    unlinked.push({
      clientId: cid,
      noteCount: ov.notes.length,
      tags: ov.tags,
      notes: ov.notes,
    });
  }
  unlinked.sort((a, b) => a.clientId.localeCompare(b.clientId));

  return { profiles, unlinked };
}

/** Latest-activity timestamp for default sort (visit or order, whichever newer). */
function lastActivity(p: ClientProfile): string {
  return (
    [p.lastVisit, p.nextVisit, p.lastOrderDate, p.firstSeen]
      .filter((x): x is string => Boolean(x))
      .sort((a, b) => b.localeCompare(a))[0] ?? ""
  );
}

/**
 * Build the full client directory (profiles + overlay), the re-booking radar,
 * and any unlinked overlays at once.
 */
export async function getClientsOverview(
  options: BuildOptions & { weeks?: number } = {}
): Promise<{
  profiles: ClientProfile[];
  rebooking: RebookingClient[];
  unlinked: UnlinkedOverlay[];
}> {
  const { profiles, unlinked } = await buildProfilesWithOverlay(options);
  profiles.sort((a, b) => lastActivity(b).localeCompare(lastActivity(a)));
  const rebooking = computeRebookingRadar(profiles, {
    weeks: options.weeks ?? 6,
    now: options.now,
  });
  return { profiles, rebooking, unlinked };
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
