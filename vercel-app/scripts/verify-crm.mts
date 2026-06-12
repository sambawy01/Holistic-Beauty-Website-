/**
 * Self-contained verification harness for the Wave 3 CRM.
 *
 * Run from vercel-app/:   npx tsx scripts/verify-crm.mts
 *
 * WHY SELF-CONTAINED (mirrors scripts/verify-finance.mts): the local
 * BLOB_READ_WRITE_TOKEN 403s on private blob CONTENT reads, so this harness
 * NEVER touches real prod Blob or Cal. Instead:
 * - Derived sources (Cal bookings / shop orders / treatments) are INJECTED via
 *   crm.__setCrmSources, so identity merge + profile maths are deterministic
 *   and offline.
 * - The overlay persistence layer runs against an IN-MEMORY CrmStore mock
 *   (crm.__setCrmStore) — CRUD round-trips, concurrent-add safety, pagination
 *   and read-error semantics.
 * - Cal / Blob tokens and ADMIN_* are BLANKED so any stray live read fails
 *   fast; RESEND/Telegram are captured via a fetch mock to PROVE the email
 *   draft tool never sends.
 *
 * No real prod Blob/Cal writes ever happen.
 */

// --- env: blank every live backend BEFORE app imports ------------------------
process.env.BLOB_READ_WRITE_TOKEN = ""; // overlay uses the in-memory mock
process.env.CALCOM_API_KEY = ""; // Cal reads would throw — sources are injected
process.env.CALCOM_API_URL = "";
process.env.RESEND_API_KEY = "test-resend"; // non-empty → a real send WOULD fetch
process.env.TELEGRAM_BOT_TOKEN = "TEST:fake-token";
process.env.NOTIFY_EMAIL = "owner@example.com";
// Blank admin creds so the API auth test sees an UNAUTHENTICATED request.
process.env.ADMIN_USER = "";
process.env.ADMIN_PASS = "";
process.env.ADMIN_TOKEN = "";

// --- fetch interception (prove the draft tool never sends) --------------------
const resendCalls: { url: string }[] = [];
const telegramCalls: { url: string }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("api.resend.com")) {
    resendCalls.push({ url });
    return new Response(JSON.stringify({ id: "mock" }), { status: 200 });
  }
  if (url.includes("api.telegram.org")) {
    telegramCalls.push({ url });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
  return realFetch(input as RequestInfo, init);
}) as typeof fetch;

// --- app imports (after env + fetch patch) -----------------------------------
const crm = await import("../src/lib/crm");
const {
  __setCrmStore,
  __resetCrmStore,
  __setCrmSources,
  __resetCrmSources,
  canonicalKey,
  clientIdFor,
  normalizeEmail,
  normalizePhone,
  isValidClientId,
  getOverlay,
  listOverlays,
  addNote,
  removeNote,
  addTag,
  removeTag,
  setTags,
  listClientProfiles,
  getClientProfile,
  getClientsOverview,
  rebookingRadar,
  computeRebookingRadar,
} = crm;
const { orderRevenueEgp } = await import("../src/lib/reports/weekly-report");
const {
  TOOLS,
  requiresConfirmation,
  validateMutationArgs,
  describeMutation,
  executeTool,
} = await import("../src/lib/assistant/tools");
const { buildSystemPrompt } = await import("../src/lib/concierge-prompt");
const { buildDailyBriefEmail } = await import("../src/lib/daily-brief-email");
const { GET: clientsGET } = await import("../src/app/api/admin/clients/route");
const { NextRequest } = await import("next/server");

import type { CrmStore, CrmDataSources, ClientProfile } from "../src/lib/crm";
import type { StoredOrder } from "../src/lib/orders";
import type { CalBooking } from "../src/lib/admin/cal";
import type { Treatment } from "../src/lib/treatments";

// --- in-memory overlay store (one blob per client) ---------------------------
function makeMemoryStore(): CrmStore & { dump(): Map<string, string> } {
  const map = new Map<string, string>();
  return {
    async read(pathname: string) {
      // A genuine microtask delay so concurrent read-modify-write would race
      // WITHOUT the per-client lock (proving the lock actually serializes).
      await Promise.resolve();
      return map.has(pathname) ? map.get(pathname)! : null;
    },
    async write(pathname: string, body: string) {
      await Promise.resolve();
      map.set(pathname, body);
    },
    async list(prefix: string) {
      return [...map.keys()].filter((k) => k.startsWith(prefix));
    },
    async remove(pathname: string) {
      map.delete(pathname);
    },
    dump: () => map,
  };
}

function makeSources(
  bookings: CalBooking[],
  orders: StoredOrder[],
  treatments: Treatment[]
): CrmDataSources {
  return {
    listBookingsInRange: async () => bookings,
    listOrders: async () => orders,
    getTreatmentsCatalog: async () => treatments,
  };
}

// --- check harness -----------------------------------------------------------
let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}
async function expectThrow(name: string, fn: () => Promise<unknown>) {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  check(name, threw);
}

const NOW = new Date("2026-06-13T12:00:00.000Z");
const DAY = 86_400_000;
function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * DAY).toISOString();
}
function daysAhead(n: number): string {
  return new Date(NOW.getTime() + n * DAY).toISOString();
}

// ============================================================================
console.log("\n=== 1. Identity normalization + canonical key + clientId ===");
{
  check("normalizeEmail lowercases + trims", normalizeEmail("  Foo@Bar.COM ") === "foo@bar.com");
  check("normalizePhone keeps last 9 digits", normalizePhone("+20 100 123 4567") === "001234567", normalizePhone("+20 100 123 4567"));
  check("canonicalKey prefers email", canonicalKey("A@b.com", "+201001234567") === "email:a@b.com");
  check("canonicalKey falls back to phone when no email", canonicalKey("", "+20 (100) 123-4567") === "phone:001234567");
  check("canonicalKey null when neither present", canonicalKey("", "") === null);
  const id = clientIdFor("email:a@b.com");
  check("clientId is 16 hex + stable", isValidClientId(id) && id === clientIdFor("email:a@b.com"));
  check("different keys → different clientIds", clientIdFor("email:a@b.com") !== clientIdFor("email:c@d.com"));
}

// ============================================================================
console.log("\n=== 2. Identity merge: booking email + order email → ONE profile ===");
{
  __setCrmStore(makeMemoryStore());
  const treatments = [mkTreatment("facial-massage", "Facial Massage", 3350, 327658)];
  const bookings = [
    // Same person, mixed case/whitespace email across booking + order.
    mkBooking("Facial Massage between Victoria and Mariam", "accepted", daysAgo(70), 327658, " Mariam@Example.com ", "+20 100 111 2222", "Mariam Hassan"),
  ];
  const orders = [
    mkOrder("VV-AAAAAA", "delivered", 1200, daysAgo(30), "mariam@example.com", "+20 100 999 0000", "M. Hassan"),
  ];
  const sources = makeSources(bookings, orders, treatments);
  const profiles = await listClientProfiles({}, { now: NOW, sources });
  check("booking + order with same email → exactly ONE profile", profiles.length === 1, `count=${profiles.length}`);
  const p = profiles[0];
  check("merged profile carries the booking AND the order", p.bookingsCount === 1 && p.ordersCount === 1);
  check("case/whitespace normalized into one email", p.email === "mariam@example.com", p.email);
  check("displayName = most recent non-empty name (order, 30d ago)", p.displayName === "M. Hassan", p.displayName);
}

// ============================================================================
console.log("\n=== 3. Phone-only fallback merge (no email on either record) ===");
{
  __setCrmStore(makeMemoryStore());
  const bookings = [
    mkBooking("Facial Massage between Victoria and Nour", "accepted", daysAgo(50), 327658, "", "0100-555-1234", "Nour"),
  ];
  const orders = [
    mkOrder("VV-BBBBBB", "confirmed", 800, daysAgo(10), "", "+2 010 0555 1234", "Nour A"),
  ];
  const profiles = await listClientProfiles({}, { now: NOW, sources: makeSources(bookings, orders, []) });
  check("phone-only booking + order (same last 9) → ONE profile", profiles.length === 1, `count=${profiles.length}`);
  check("phone-only profile has both records", profiles[0]?.bookingsCount === 1 && profiles[0]?.ordersCount === 1);

  // A record WITH an email must NOT merge into a phone-only one by phone.
  const mixed = await listClientProfiles({}, {
    now: NOW,
    sources: makeSources(
      [mkBooking("Facial Massage between Victoria and X", "accepted", daysAgo(50), 327658, "x@e.com", "0100-555-1234", "X")],
      [mkOrder("VV-CCCCCC", "confirmed", 500, daysAgo(5), "", "0100-555-1234", "X phone")],
      []
    ),
  });
  check("email record does NOT merge with phone-only by phone (2 profiles)", mixed.length === 2, `count=${mixed.length}`);
}

// ============================================================================
console.log("\n=== 4. totalSpend reuses orderRevenueEgp + lastVisit/nextVisit logic ===");
let spendProfile: ClientProfile;
{
  __setCrmStore(makeMemoryStore());
  const treatments = [mkTreatment("facial-massage", "Facial Massage", 3350, 327658)];
  const bookings = [
    mkBooking("Facial Massage between Victoria and Lena", "accepted", daysAgo(90), 327658, "lena@example.com", "0111", "Lena"), // past
    mkBooking("Facial Massage between Victoria and Lena", "accepted", daysAgo(20), 327658, "lena@example.com", "0111", "Lena"), // most-recent past
    mkBooking("Facial Massage between Victoria and Lena", "accepted", daysAhead(14), 327658, "lena@example.com", "0111", "Lena"), // future
    mkBooking("Facial Massage between Victoria and Lena", "pending", daysAhead(3), 327658, "lena@example.com", "0111", "Lena"), // not confirmed
  ];
  const orders = [
    mkOrder("VV-DDDDDD", "delivered", 1000, daysAgo(40), "lena@example.com", "0111", "Lena"),
    mkOrder("VV-EEEEEE", "confirmed", 500, daysAgo(15), "lena@example.com", "0111", "Lena"),
    mkOrder("VV-FFFFFF", "cancelled", 999, daysAgo(10), "lena@example.com", "0111", "Lena"), // NOT revenue
    mkOrder("VV-GGGGGG", "ordered", 300, daysAgo(2), "lena@example.com", "0111", "Lena"), // NOT revenue
  ];
  const profiles = await listClientProfiles({}, { now: NOW, sources: makeSources(bookings, orders, treatments) });
  spendProfile = profiles[0];
  const expectedSpend = orderRevenueEgp(orders);
  check("totalSpend == orderRevenueEgp(orders) (reuse, not reinvent)", spendProfile.totalSpendEgp === expectedSpend, `${spendProfile.totalSpendEgp} vs ${expectedSpend}`);
  check("totalSpend counts only revenue statuses (1000+500=1500)", spendProfile.totalSpendEgp === 1500, String(spendProfile.totalSpendEgp));
  check("lastVisit = most recent PAST confirmed (20d ago)", spendProfile.lastVisit === daysAgo(20), String(spendProfile.lastVisit));
  check("nextVisit = soonest FUTURE confirmed (14d ahead)", spendProfile.nextVisit === daysAhead(14), String(spendProfile.nextVisit));
  check("bookingsCount counts all (4)", spendProfile.bookingsCount === 4);
  check("ordersCount counts all (4)", spendProfile.ordersCount === 4);
  check("treatmentsList from confirmed bookings", spendProfile.treatmentsList.includes("Facial Massage"));
  check("lastOrderDate = newest order (2d ago)", spendProfile.lastOrderDate === daysAgo(2), String(spendProfile.lastOrderDate));
}

// ============================================================================
console.log("\n=== 5. Re-booking radar (>N weeks, no upcoming, has past confirmed) ===");
{
  const treatments = [mkTreatment("facial-massage", "Facial Massage", 3350, 327658)];
  const overdue = mkProfileVisits("overdue@e.com", "Overdue One", [daysAgo(70)], []); // 10w ago, no upcoming
  const recent = mkProfileVisits("recent@e.com", "Recent One", [daysAgo(14)], []); // 2w ago → too recent
  const hasUpcoming = mkProfileVisits("upcoming@e.com", "Upcoming One", [daysAgo(80)], [daysAhead(5)]); // overdue but re-booked
  const neverConfirmed = mkProfileVisits("never@e.com", "Never One", [], [], "pending"); // no past confirmed
  const sources = makeSources(
    [...overdue.bookings, ...recent.bookings, ...hasUpcoming.bookings, ...neverConfirmed.bookings],
    [],
    treatments
  );
  __setCrmStore(makeMemoryStore());
  const due = await rebookingRadar({ weeks: 6, now: NOW, sources });
  const names = due.map((d) => d.displayName);
  check("overdue (>6wk, no upcoming) surfaces", names.includes("Overdue One"), names.join(","));
  check("recent (<6wk) excluded", !names.includes("Recent One"));
  check("has-upcoming excluded", !names.includes("Upcoming One"));
  check("no-past-confirmed excluded", !names.includes("Never One"));
  const od = due.find((d) => d.displayName === "Overdue One");
  check("overdueWeeks computed (~10)", od !== undefined && od.overdueWeeks === 10, String(od?.overdueWeeks));
  check("suggested draft present (subject + body)", Boolean(od?.suggestedDraft.subject && od?.suggestedDraft.body));
  check("sorted most-overdue first", due.length >= 1 && due[0].overdueWeeks >= (due[due.length - 1]?.overdueWeeks ?? 0));

  // computeRebookingRadar is the pure seam — same answer offline.
  const pure = computeRebookingRadar(
    await listClientProfiles({}, { now: NOW, sources }),
    { weeks: 6, now: NOW }
  );
  check("computeRebookingRadar (pure) agrees with rebookingRadar", pure.length === due.length);
}

// ============================================================================
console.log("\n=== 6. Overlay CRUD: one blob/client, paginated list, read-error throws ===");
{
  const store = makeMemoryStore();
  __setCrmStore(store);
  const idA = clientIdFor("email:a@e.com");
  const idB = clientIdFor("email:b@e.com");

  check("fresh client → empty overlay", (await getOverlay(idA)).notes.length === 0 && (await getOverlay(idA)).tags.length === 0);

  const n1 = await addNote(idA, "prefers low pressure");
  check("addNote returns id + text + createdAt", Boolean(n1.id) && n1.text === "prefers low pressure" && Boolean(n1.createdAt));
  const n2 = await addNote(idA, "allergic to lavender");
  check("two notes persisted on client A", (await getOverlay(idA)).notes.length === 2);

  await addNote(idB, "VIP since 2024");
  check("client B note is a SEPARATE blob (one blob per client)", store.dump().has(`crm/clients/${idA}.json`) && store.dump().has(`crm/clients/${idB}.json`));
  check("client B has its own single note", (await getOverlay(idB)).notes.length === 1);

  const removed = await removeNote(idA, n1.id);
  check("removeNote deletes by id", removed === true && (await getOverlay(idA)).notes.length === 1);
  check("removeNote unknown id → false", (await removeNote(idA, "nope")) === false);
  check("remaining note is the second one", (await getOverlay(idA)).notes[0].id === n2.id);

  await addTag(idA, "  VIP  ");
  await addTag(idA, "vip"); // dedupe (normalized)
  await addTag(idA, "sensitive-skin");
  check("addTag normalizes + dedupes", JSON.stringify((await getOverlay(idA)).tags) === JSON.stringify(["vip", "sensitive-skin"]), JSON.stringify((await getOverlay(idA)).tags));
  await removeTag(idA, "VIP");
  check("removeTag (case-insensitive) removes it", !(await getOverlay(idA)).tags.includes("vip"));
  const set = await setTags(idA, ["Returning", "returning", "gift"]);
  check("setTags replaces whole set, deduped", JSON.stringify(set) === JSON.stringify(["returning", "gift"]), JSON.stringify(set));
}

// ============================================================================
console.log("\n=== 6b. CONCURRENT note-add to the SAME client → no lost update ===");
{
  __setCrmStore(makeMemoryStore());
  const id = clientIdFor("email:concurrent@e.com");
  // Without the per-client lock, these async read-modify-writes interleave and
  // the slower writer clobbers the others. The lock serializes them.
  await Promise.all([
    addNote(id, "note 1"),
    addNote(id, "note 2"),
    addNote(id, "note 3"),
    addNote(id, "note 4"),
    addNote(id, "note 5"),
  ]);
  const overlay = await getOverlay(id);
  const texts = new Set(overlay.notes.map((n) => n.text));
  check("all 5 concurrent notes persisted (no lost update)", overlay.notes.length === 5 && texts.size === 5, `count=${overlay.notes.length}`);
}

// ============================================================================
console.log("\n=== 6c. Overlay list PAGINATION (cursor walk aggregates all pages) ===");
{
  // Drive listOverlays through a CrmStore whose `list` uses the SAME cursor
  // walk crm uses in prod (listAllBlobPathnames) over a TWO-page mock.
  const { listAllBlobPathnames } = await import("../src/lib/finance");
  const PREFIX = "crm/clients/";
  const TOTAL = 1300; // straddles the 1000-blob page cap → forces a 2nd page
  const overlays = new Map<string, string>();
  for (let i = 0; i < TOTAL; i++) {
    const cid = String(i).padStart(16, "0");
    overlays.set(`${PREFIX}${cid}.json`, JSON.stringify({ clientId: cid, notes: [], tags: [], updatedAt: "" }));
  }
  let listCalls = 0;
  const pagedStore: CrmStore = {
    async read(p) {
      return overlays.has(p) ? overlays.get(p)! : null;
    },
    async write() {},
    async list(prefix) {
      return listAllBlobPathnames(prefix, async (opts) => {
        listCalls++;
        const all = [...overlays.keys()].filter((k) => k.startsWith(opts.prefix));
        const start = opts.cursor ? Number(opts.cursor) : 0;
        const slice = all.slice(start, start + opts.limit);
        const next = start + opts.limit;
        const more = next < all.length;
        return { blobs: slice.map((pathname) => ({ pathname })), cursor: more ? String(next) : undefined, hasMore: more };
      });
    },
    async remove() {},
  };
  __setCrmStore(pagedStore);
  const all = await listOverlays();
  check("listOverlays aggregates ALL 1300 overlays (not truncated at 1000)", all.size === TOTAL, `got ${all.size}`);
  check("cursor walk made >1 list() page call", listCalls >= 2, `calls=${listCalls}`);
}

// ============================================================================
console.log("\n=== 6d. Read-error semantics: transient throws, corrupt throws ===");
{
  // transient read failure → getOverlay / listOverlays THROW (never "no notes")
  __setCrmStore({
    async read() {
      throw new Error("simulated transient read 500");
    },
    async write() {},
    async list() {
      return ["crm/clients/0000000000000000.json"];
    },
    async remove() {},
  });
  await expectThrow("transient read error → getOverlay THROWS", () => getOverlay(clientIdFor("email:x@e.com")));
  await expectThrow("transient read error → listOverlays THROWS", () => listOverlays());

  // transient LIST failure → listOverlays THROWS
  __setCrmStore({
    async read() {
      return null;
    },
    async write() {},
    async list() {
      throw new Error("simulated transient list 500");
    },
    async remove() {},
  });
  await expectThrow("transient list error → listOverlays THROWS", () => listOverlays());

  // corrupt overlay blob → THROWS (loud corruption)
  __setCrmStore({
    async read() {
      return JSON.stringify({ clientId: "x", notes: "not-an-array", tags: [] });
    },
    async write() {},
    async list() {
      return [];
    },
    async remove() {},
  });
  await expectThrow("corrupt overlay blob → getOverlay THROWS", () => getOverlay(clientIdFor("email:x@e.com")));
}

// ============================================================================
console.log("\n=== 7. Vassili CRM tools: schema, gate, disclosure, executors ===");
{
  __setCrmStore(makeMemoryStore());
  const treatments = [mkTreatment("facial-massage", "Facial Massage", 3350, 327658)];
  // Seed relative to REAL now so the tool path (which uses the real clock)
  // sees a genuinely-overdue client and a resolvable profile.
  const realDay = (n: number) => new Date(Date.now() - n * DAY).toISOString();
  const bookings = [
    mkBooking("Facial Massage between Victoria and Mariam", "accepted", realDay(70), 327658, "mariam@example.com", "0100111", "Mariam Hassan"),
  ];
  const orders = [mkOrder("VV-HHHHHH", "delivered", 1200, realDay(40), "mariam@example.com", "0100111", "Mariam Hassan")];
  __setCrmSources(makeSources(bookings, orders, treatments));
  const ctx = { chatId: 770_077_001 };
  const mariamId = clientIdFor("email:mariam@example.com");

  // schema presence
  const names = TOOLS.map((t) => t.function.name);
  check("TOOLS includes the 5 CRM tools", ["client_profile", "rebooking_radar", "client_note_add", "client_tag", "draft_client_email"].every((n) => names.includes(n)));

  // mutating vs read-only
  check("client_note_add requires confirmation", requiresConfirmation("client_note_add", { clientId: mariamId, text: "hi" }));
  check("client_tag requires confirmation", requiresConfirmation("client_tag", { clientId: mariamId, action: "add", tag: "vip" }));
  check("client_profile is read-only", !requiresConfirmation("client_profile", { query: "mariam" }));
  check("rebooking_radar is read-only", !requiresConfirmation("rebooking_radar", { weeks: 6 }));
  check("draft_client_email is read-only", !requiresConfirmation("draft_client_email", { query: "mariam", intent: "checkin" }));

  // gate validation
  const vTag = validateMutationArgs("client_tag", { clientId: mariamId, action: "add", tag: "vip" });
  check("validateMutationArgs accepts a valid client_tag", vTag.ok);
  const vBadAction = validateMutationArgs("client_tag", { clientId: mariamId, action: "nuke", tag: "vip" });
  check("validateMutationArgs refuses an out-of-enum action", !vBadAction.ok);
  const vNote = validateMutationArgs("client_note_add", { clientId: mariamId, text: "prefers mornings" });
  check("validateMutationArgs accepts a valid client_note_add", vNote.ok);

  // structural disclosure — must spell out "not visible to the client"
  const discNote = describeMutation("client_note_add", { clientId: mariamId, text: "prefers mornings" });
  check("describeMutation(note) discloses private/not-visible", /not visible to the client/i.test(discNote), discNote.slice(0, 120));
  const discTag = describeMutation("client_tag", { clientId: mariamId, action: "add", tag: "vip" });
  check("describeMutation(tag) discloses private label", /not visible to the client/i.test(discTag) && /vip/.test(discTag), discTag.slice(0, 120));

  // client_profile read
  const profileText = await executeTool("client_profile", { query: "mariam" }, ctx);
  check("client_profile returns the matched profile", /Mariam Hassan/.test(profileText) && /1200 EGP/.test(profileText), profileText.slice(0, 120));

  // note executor persists (the Confirm-tap path)
  const noteResult = await executeTool("client_note_add", { clientId: mariamId, text: "prefers mornings" }, ctx);
  check("client_note_add executor confirms + persists", /Note added/.test(noteResult));
  check("note actually persisted in the overlay store", (await getOverlay(mariamId)).notes.some((n) => n.text === "prefers mornings"));

  // tag executor persists
  const tagResult = await executeTool("client_tag", { clientId: mariamId, action: "add", tag: "VIP" }, ctx);
  check("client_tag executor adds the tag (normalized)", /Added tag "vip"/.test(tagResult), tagResult.slice(0, 80));
  check("tag persisted in the overlay store", (await getOverlay(mariamId)).tags.includes("vip"));

  // resolve-by-name also works for mutations (single match)
  const byName = await executeTool("client_note_add", { identifier: "mariam", text: "second note" }, ctx);
  check("client_note_add resolves by name (single match)", /Note added/.test(byName));

  // rebooking_radar tool
  const radarText = await executeTool("rebooking_radar", { weeks: 6 }, ctx);
  check("rebooking_radar tool lists the overdue client", /Mariam Hassan/.test(radarText) && /overdue/.test(radarText), radarText.slice(0, 120));

  // draft_client_email PRODUCES a draft and does NOT send
  resendCalls.length = 0;
  telegramCalls.length = 0;
  const draftText = await executeTool("draft_client_email", { query: "mariam", intent: "checkin" }, ctx);
  check("draft_client_email returns a DRAFT (subject + body)", /DRAFT for Mariam Hassan/.test(draftText) && /Subject:/.test(draftText), draftText.slice(0, 100));
  check("draft_client_email did NOT send any email (no Resend call)", resendCalls.length === 0, `resendCalls=${resendCalls.length}`);
  check("draft_client_email did NOT send to Telegram", telegramCalls.length === 0);
  check("draft points to email_send for actual sending", /email_send/.test(draftText));

  __resetCrmSources();
}

// ============================================================================
console.log("\n=== 8. API auth: unauthenticated GET /api/admin/clients → 401 ===");
{
  const res = await clientsGET(new NextRequest("https://book.victoriaholisticbeauty.com/api/admin/clients"));
  check("GET /api/admin/clients without auth → 401", res.status === 401, `status=${res.status}`);
}

// ============================================================================
console.log("\n=== 9. PRIVACY: public concierge prompt contains NO client PII ===");
{
  // Seed CRM with a recognizable client + a private note, then build the
  // PUBLIC concierge prompt and assert NONE of that PII leaks into it.
  __setCrmStore(makeMemoryStore());
  const id = clientIdFor("email:secret-client@example.com");
  await addNote(id, "PRIVATE-NOTE-prefers-low-pressure");
  const prompt = buildSystemPrompt("en", [], []);
  check("concierge prompt has no client email", !prompt.includes("secret-client@example.com"));
  check("concierge prompt has no private note text", !prompt.includes("PRIVATE-NOTE-prefers-low-pressure"));
  check("concierge prompt mentions no CRM tools", !/client_profile|rebooking_radar|client_note_add|client_tag/.test(prompt));
}

// ============================================================================
console.log("\n=== 10. Brief integration: re-booking section is additive ===");
{
  // With NO rebooking input the brief renders exactly as before (no section).
  const base = buildDailyBriefEmail({ bookings: [], orders: [], failures: [], now: NOW });
  check("brief without rebooking has no check-in section", !/due for a check-in/i.test(base.text) && base.counts.rebooking === 0);

  // With due clients, the section appears and the count is surfaced.
  const withDue = buildDailyBriefEmail({
    bookings: [],
    orders: [],
    failures: [],
    now: NOW,
    rebookingDue: [
      { displayName: "Overdue One", lastTreatment: "Facial Massage", overdueWeeks: 10 },
      { displayName: "Overdue Two", lastTreatment: "", overdueWeeks: 8 },
    ],
  });
  check("brief WITH due clients renders the check-in section", /Clients due for a check-in \(2\)/.test(withDue.text), "");
  check("brief surfaces the most-overdue client first", withDue.text.indexOf("Overdue One") < withDue.text.indexOf("Overdue Two"));
  check("brief counts.rebooking reflects due clients", withDue.counts.rebooking === 2);
  check("brief is no longer an 'empty day' when only check-ins are due", !/enjoy the calm/.test(withDue.text));
}

// ============================================================================
console.log(`\n=== DONE — ${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} ===`);
__resetCrmStore();
__resetCrmSources();
process.exit(failures === 0 ? 0 : 1);

// --- factories ---------------------------------------------------------------
function mkBooking(
  title: string,
  status: string,
  start: string,
  eventTypeId: number,
  email: string,
  phone: string,
  name: string
): CalBooking {
  return {
    id: 1,
    uid: crypto.randomUUID(),
    title,
    status,
    start,
    end: start,
    duration: 60,
    eventTypeId,
    attendees: [{ name, email, timeZone: "Africa/Cairo" }],
    bookingFieldsResponses: { attendeePhoneNumber: phone },
  };
}

function mkOrder(
  orderNumber: string,
  status: string,
  egp: number,
  createdAt: string,
  email: string,
  phone: string,
  name: string
): StoredOrder {
  return {
    orderNumber,
    createdAt,
    status: status as StoredOrder["status"],
    items: [{ slug: "x", qty: 1, names: { en: "Cream", ru: "Крем" }, lineTotals: { egp, rub: 0 } }],
    totals: { egp, rub: 0 },
    name,
    phone,
    email,
    address: "",
    note: "",
    lang: "en",
    statusHistory: [],
  };
}

function mkTreatment(
  slug: string,
  nameEn: string,
  priceEgp: number,
  eventTypeId: number
): Treatment {
  return {
    slug,
    eventTypeId,
    name: { en: nameEn, ru: nameEn },
    description: { en: "", ru: "" },
    durationMinutes: 60,
    priceEgp,
    priceRub: 0,
    active: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** A client's confirmed past + future booking set (for the radar tests). */
function mkProfileVisits(
  email: string,
  name: string,
  pastStarts: string[],
  futureStarts: string[],
  status = "accepted"
): { bookings: CalBooking[] } {
  const bookings = [
    ...pastStarts.map((s) => mkBooking(`Facial Massage between Victoria and ${name}`, status, s, 327658, email, "0100", name)),
    ...futureStarts.map((s) => mkBooking(`Facial Massage between Victoria and ${name}`, "accepted", s, 327658, email, "0100", name)),
  ];
  return { bookings };
}
