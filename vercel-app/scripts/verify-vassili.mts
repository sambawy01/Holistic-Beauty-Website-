/**
 * End-to-end verification harness for Vassili (the Telegram assistant).
 *
 * Run from vercel-app/:   npx tsx scripts/verify-vassili.mts
 *
 * What is REAL: Vercel Blob (state/catalog), Cal.com READS, the Ollama model
 * (local ollama → Ollama Cloud). What is MOCKED at the fetch boundary:
 * - api.telegram.org   → captured (no bot exists yet)
 * - Cal.com MUTATIONS  → captured (never confirm/decline/move real bookings)
 * - api.resend.com     → captured (never send real emails; RESEND_API_KEY is
 *   also blanked for belt-and-braces)
 *
 * The script drives the real webhook route handler with synthetic Telegram
 * updates and asserts on the captured outbound calls. It restores any state
 * it changes (catalog quantity, telegram/* blobs).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- env (before any app import) ---------------------------------------------
for (const line of readFileSync(join(__dirname, "..", ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)="?([^"]*)"?$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}
process.env.RESEND_API_KEY = ""; // never send real emails from this harness
process.env.TELEGRAM_BOT_TOKEN = "TEST:fake-token";
process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";

// .env.local pulls ADMIN_PASS as empty — use a harness-controlled value (the
// route only ever compares against the env var, so this tests the mechanism).
if (!process.env.ADMIN_PASS) process.env.ADMIN_PASS = "victoria2026!";
const ADMIN_PASS = process.env.ADMIN_PASS;

// --- fetch interception ------------------------------------------------------------
interface Captured {
  url: string;
  method: string;
  body?: unknown;
  form?: Record<string, { filename?: string; size?: number; text?: string }>;
}
const telegramCalls: Captured[] = [];
const calMutations: Captured[] = [];
const resendCalls: Captured[] = [];
let lastPdf: Buffer | null = null;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? "GET").toUpperCase();

  if (url.includes("api.telegram.org")) {
    const cap: Captured = { url, method };
    if (init?.body instanceof FormData) {
      cap.form = {};
      for (const [key, value] of init.body.entries()) {
        if (value instanceof Blob) {
          const buf = Buffer.from(await value.arrayBuffer());
          const filename = (value as File).name;
          cap.form[key] = { filename, size: buf.length };
          if (filename?.endsWith(".pdf")) lastPdf = buf;
        } else {
          cap.form[key] = { text: String(value) };
        }
      }
    } else if (typeof init?.body === "string") {
      cap.body = JSON.parse(init.body);
    }
    telegramCalls.push(cap);
    return new Response(
      JSON.stringify({ ok: true, result: { message_id: 4242 } }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  // Cal.com mutations: POST /bookings/<uid>/(confirm|decline|reschedule)
  if (
    method === "POST" &&
    /\/v2\/bookings\/[^/]+\/(confirm|decline|reschedule)$/.test(url)
  ) {
    calMutations.push({
      url,
      method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify({ status: "success", data: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (url.includes("api.resend.com")) {
    resendCalls.push({
      url,
      method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify({ id: "mock" }), { status: 200 });
  }

  return realFetch(input as RequestInfo, init);
}) as typeof fetch;

// --- app imports (after env + fetch patch) ----------------------------------------
const { POST: webhookPOST } = await import("../src/app/api/telegram/webhook/route");
const { getOwnerChatId } = await import("../src/lib/assistant/state");
const { getCatalog, saveCatalog } = await import("../src/lib/catalog");
const { del, get } = await import("@vercel/blob");

// --- helpers ---------------------------------------------------------------------------
const OWNER_CHAT = 770_077_001;
const STRANGER_CHAT = 990_099_009;
const STRANGER2_CHAT = 880_088_008;
let updateId = 1;
let messageId = 100;

function tgRequest(update: unknown, secret = "test-webhook-secret"): Request {
  return new Request("https://book.victoriaholisticbeauty.com/api/telegram/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": secret,
    },
    body: JSON.stringify(update),
  });
}

async function sendText(chatId: number, text: string) {
  const res = await webhookPOST(
    tgRequest({
      update_id: updateId++,
      message: {
        message_id: messageId++,
        chat: { id: chatId, type: "private" },
        from: { id: chatId, first_name: "Test" },
        text,
      },
    }) as never
  );
  return res;
}

async function tapButton(chatId: number, data: string, fromId?: number) {
  return webhookPOST(
    tgRequest({
      update_id: updateId++,
      callback_query: {
        id: `cbq-${updateId}`,
        data,
        from: { id: fromId ?? chatId, first_name: "Test" },
        message: { message_id: 4242, chat: { id: chatId, type: "private" } },
      },
    }) as never
  );
}

function lastTelegramText(): string {
  for (let i = telegramCalls.length - 1; i >= 0; i--) {
    const b = telegramCalls[i].body as { text?: string } | undefined;
    if (b?.text) return b.text;
  }
  return "";
}

function lastKeyboardPendingId(): string | null {
  for (let i = telegramCalls.length - 1; i >= 0; i--) {
    const b = telegramCalls[i].body as
      | { reply_markup?: { inline_keyboard?: { callback_data: string }[][] } }
      | undefined;
    const btn = b?.reply_markup?.inline_keyboard?.[0]?.[0];
    if (btn) return btn.callback_data.replace(/^confirm:/, "");
  }
  return null;
}

/** sendMessage calls to a given chat whose text matches. */
function messagesTo(chatId: number, re: RegExp): Captured[] {
  return telegramCalls.filter((c) => {
    const b = c.body as { chat_id?: number; text?: string } | undefined;
    return (
      c.url.includes("sendMessage") &&
      b?.chat_id === chatId &&
      re.test(String(b?.text ?? ""))
    );
  });
}

const ALERT_RE = /tried to access Vassili/;
const REFUSAL_RE = /private assistant/;

async function readAuditEntries(): Promise<
  { at?: string; chatId?: number; kind?: string; detail?: Record<string, unknown> }[]
> {
  const r = await get("telegram/audit.jsonl", { access: "private", useCache: false });
  if (!r || r.statusCode !== 200) return [];
  const text = await new Response(r.stream).text();
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as { chatId?: number; kind?: string };
      } catch {
        return {};
      }
    });
}

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}

const RUN_STARTED_AT = new Date().toISOString();

// ====================================================================================
console.log("=== 0. Reset telegram/* state (idempotent harness) ===");
for (const path of ["telegram/owner.json", "telegram/history.json", "telegram/alerts.json"]) {
  try {
    await del(path);
    console.log("deleted stale", path);
  } catch {
    // missing — fine
  }
}

console.log("\n=== 1. Gates: no token / bad secret / strangers ===");
{
  const saved = process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_BOT_TOKEN;
  const res = await sendText(OWNER_CHAT, "hi");
  check("501 when TELEGRAM_BOT_TOKEN unset", res.status === 501);
  process.env.TELEGRAM_BOT_TOKEN = saved;
}
{
  const res = await webhookPOST(
    tgRequest({ update_id: updateId++, message: { message_id: 1, chat: { id: 1 }, text: "x" } }, "WRONG") as never
  );
  check("401 on wrong webhook secret", res.status === 401);
}
{
  telegramCalls.length = 0;
  const res = await sendText(STRANGER_CHAT, "hello, can I book a massage?");
  check("stranger gets 200", res.status === 200);
  check(
    "stranger gets private-assistant refusal",
    lastTelegramText().includes("private assistant"),
    JSON.stringify(lastTelegramText()).slice(0, 120)
  );
}
{
  telegramCalls.length = 0;
  await sendText(OWNER_CHAT, "/start letmein-wrong");
  check("wrong /start pass → refusal", lastTelegramText().includes("private assistant"));
  const owner = await getOwnerChatId();
  check("owner NOT bound after wrong pass", owner !== OWNER_CHAT, `owner=${owner}`);
}
{
  // Empty ADMIN_PASS must fail closed — no empty-string bypass, ever.
  const savedPass = process.env.ADMIN_PASS;
  process.env.ADMIN_PASS = "";
  telegramCalls.length = 0;
  await sendText(OWNER_CHAT, "/start"); // empty supplied pass vs empty ADMIN_PASS
  await sendText(OWNER_CHAT, "/start anything");
  check("empty ADMIN_PASS → binding impossible", (await getOwnerChatId()) === null);
  check(
    "empty ADMIN_PASS → refusal (not greeting)",
    messagesTo(OWNER_CHAT, REFUSAL_RE).length === 2 &&
      messagesTo(OWNER_CHAT, /ops assistant/).length === 0
  );
  process.env.ADMIN_PASS = savedPass;
}

console.log("\n=== 2. Owner binding ===");
{
  telegramCalls.length = 0;
  await sendText(OWNER_CHAT, `/start ${ADMIN_PASS}`);
  check("greeting after correct pass", lastTelegramText().includes("ops assistant"));
  const owner = await getOwnerChatId();
  check("Blob owner.json bound to chat", owner === OWNER_CHAT, `owner=${owner}`);
}

console.log("\n=== 2b. Hardening: one-time binding, intrusion alerts, audit ===");
{
  // (a) stranger /start with a WRONG password after binding → refusal + alert
  telegramCalls.length = 0;
  await sendText(STRANGER_CHAT, "/start hunter2");
  check(
    "stranger wrong-pass /start → generic refusal",
    messagesTo(STRANGER_CHAT, REFUSAL_RE).length === 1
  );
  check(
    "owner alerted about wrong-pass attempt",
    messagesTo(OWNER_CHAT, ALERT_RE).length === 1,
    JSON.stringify(messagesTo(OWNER_CHAT, ALERT_RE)[0]?.body).slice(0, 160)
  );

  // (b) stranger /start with the CORRECT password after binding → NO rebind
  telegramCalls.length = 0;
  await sendText(STRANGER_CHAT, `/start ${ADMIN_PASS}`);
  check(
    "correct-pass /start from stranger → generic refusal (no greeting leak)",
    messagesTo(STRANGER_CHAT, REFUSAL_RE).length === 1 &&
      messagesTo(STRANGER_CHAT, /ops assistant|already connected/i).length === 0
  );
  check(
    "binding NOT hijacked — owner unchanged",
    (await getOwnerChatId()) === OWNER_CHAT
  );
  check(
    "owner alerted about correct-pass rebind attempt",
    messagesTo(OWNER_CHAT, ALERT_RE).length === 1 &&
      /CORRECT password/.test(
        String((messagesTo(OWNER_CHAT, ALERT_RE)[0]?.body as { text?: string })?.text)
      )
  );

  // owner /start again → friendly idempotent reply, no alert, no rebind error
  telegramCalls.length = 0;
  await sendText(OWNER_CHAT, `/start ${ADMIN_PASS}`);
  check(
    "owner /start again → friendly already-connected reply",
    /already connected/i.test(lastTelegramText()),
    lastTelegramText().slice(0, 100)
  );
  check(
    "owner /start does not trigger an alert",
    messagesTo(OWNER_CHAT, ALERT_RE).length === 0
  );

  // (c) stranger plain message → refusal + first-contact alert (3rd alert in window)
  telegramCalls.length = 0;
  await sendText(STRANGER_CHAT, "hey, what's Victoria's schedule?");
  check(
    "stranger plain message → refusal",
    messagesTo(STRANGER_CHAT, REFUSAL_RE).length === 1
  );
  check(
    "first-contact alert for stranger message",
    messagesTo(OWNER_CHAT, ALERT_RE).length === 1
  );

  // rate cap: 4th alert-eligible attempt within the hour → NO alert
  telegramCalls.length = 0;
  await sendText(STRANGER_CHAT, "/start another-guess");
  check(
    "4th attempt still refused",
    messagesTo(STRANGER_CHAT, REFUSAL_RE).length === 1
  );
  check(
    "alert rate-limit: 4th attempt within the hour → NO alert",
    messagesTo(OWNER_CHAT, ALERT_RE).length === 0
  );

  // day-gating for plain messages (fresh stranger, cap untouched)
  telegramCalls.length = 0;
  await sendText(STRANGER2_CHAT, "hello?");
  check(
    "second stranger first message → alert",
    messagesTo(OWNER_CHAT, ALERT_RE).length === 1
  );
  telegramCalls.length = 0;
  await sendText(STRANGER2_CHAT, "are you ignoring me?");
  check(
    "second stranger repeat message same day → NO alert (day gate)",
    messagesTo(OWNER_CHAT, ALERT_RE).length === 0
  );
  check(
    "…but still refused",
    messagesTo(STRANGER2_CHAT, REFUSAL_RE).length === 1
  );

  // stranger callback tap → privately refused, nothing executes
  telegramCalls.length = 0;
  calMutations.length = 0;
  await tapButton(STRANGER2_CHAT, "confirm:00000000-0000-4000-8000-000000000000");
  const cbAnswer = telegramCalls.find((c) => c.url.includes("answerCallbackQuery"));
  check(
    "stranger callback tap → answered 'private', no mutation",
    Boolean(cbAnswer) && calMutations.length === 0
  );

  // audit completeness — only entries written by THIS run count
  const audit = await readAuditEntries();
  const has = (kind: string, chatId: number) =>
    audit.some(
      (e) =>
        e.kind === kind &&
        e.chatId === chatId &&
        typeof e.at === "string" &&
        e.at >= RUN_STARTED_AT
    );
  check("audit: start-wrong-pass logged", has("start-wrong-pass", STRANGER_CHAT));
  check(
    "audit: start-rebind-blocked logged",
    has("start-rebind-blocked", STRANGER_CHAT)
  );
  check(
    "audit: unauthorized-message logged",
    has("unauthorized-message", STRANGER_CHAT)
  );
  check(
    "audit: unauthorized-callback logged",
    has("unauthorized-callback", STRANGER2_CHAT)
  );
}

console.log("\n=== 3. \"what's my day?\" (real brief data via real Ollama+Cal+Blob) ===");
{
  telegramCalls.length = 0;
  await sendText(OWNER_CHAT, "what's my day looking like?");
  const reply = lastTelegramText();
  console.log("--- reply ---\n" + reply + "\n-------------");
  check("got a non-empty reply", reply.length > 20);
  check(
    "reply reflects real data (mentions booking/order/pending substance)",
    /pending|booking|appointment|order|quiet|calm/i.test(reply)
  );
}

console.log("\n=== 4. Confirm-booking flow (xhani) — Cal mutation stubbed ===");
{
  telegramCalls.length = 0;
  calMutations.length = 0;
  await sendText(OWNER_CHAT, "please confirm the booking request from xhani");
  const confirmMsg = lastTelegramText();
  const pendingId = lastKeyboardPendingId();
  console.log("--- confirm prompt ---\n" + confirmMsg + "\npendingId: " + pendingId);
  check("agent asked for confirmation with keyboard", pendingId !== null);
  check(
    "summary references xhani's real uid",
    confirmMsg.includes("8oVE8ZQ8mTnZEytEaVdpR2"),
    confirmMsg.slice(0, 160)
  );
  check("no Cal mutation before Confirm tap", calMutations.length === 0);

  if (pendingId) {
    telegramCalls.length = 0;
    await tapButton(OWNER_CHAT, `confirm:${pendingId}`);
    check(
      "Confirm tap → confirmBooking called with the right uid",
      calMutations.some((c) => c.url.includes("/bookings/8oVE8ZQ8mTnZEytEaVdpR2/confirm")),
      calMutations.map((c) => c.url).join(", ")
    );
    const edited = telegramCalls.find((c) => c.url.includes("editMessageText"));
    check(
      "result edited into the message",
      Boolean(edited && String((edited.body as { text?: string })?.text).includes("done")),
      String((edited?.body as { text?: string })?.text).slice(0, 120)
    );
    // double-tap: must be gone
    calMutations.length = 0;
    await tapButton(OWNER_CHAT, `confirm:${pendingId}`);
    check("second Confirm tap is a no-op", calMutations.length === 0);
  }
}

console.log("\n=== 5. Cancel path ===");
{
  telegramCalls.length = 0;
  calMutations.length = 0;
  await sendText(OWNER_CHAT, "decline Hany's facial massage request, reason: schedule conflict");
  const pendingId = lastKeyboardPendingId();
  check("decline parked behind keyboard", pendingId !== null, lastTelegramText().slice(0, 140));
  if (pendingId) {
    telegramCalls.length = 0;
    await tapButton(OWNER_CHAT, `cancel:${pendingId}`);
    check("Cancel tap → no Cal mutation", calMutations.length === 0);
    const edited = telegramCalls.find((c) => c.url.includes("editMessageText"));
    check(
      "message edited to Cancelled",
      Boolean(edited && /cancelled/i.test(String((edited.body as { text?: string })?.text)))
    );
  }
}

console.log("\n=== 6. Catalog mutation (REAL blob): tohar 20 → 15 → restore ===");
{
  const before = await getCatalog();
  const tohar = before.find((p) => p.slug === "tohar-hamidbar-concentrate");
  console.log("tohar quantity before:", tohar?.quantity);
  telegramCalls.length = 0;
  await sendText(OWNER_CHAT, "set tohar quantity to 15");
  const pendingId = lastKeyboardPendingId();
  const prompt = lastTelegramText();
  check("product_update parked behind keyboard", pendingId !== null, prompt.slice(0, 140));
  check("summary mentions quantity 15", /quantity 15/.test(prompt), prompt.slice(0, 140));

  const midway = await getCatalog();
  check(
    "catalog unchanged before Confirm",
    midway.find((p) => p.slug === "tohar-hamidbar-concentrate")?.quantity === tohar?.quantity
  );

  if (pendingId) {
    await tapButton(OWNER_CHAT, `confirm:${pendingId}`);
    const after = await getCatalog();
    const q = after.find((p) => p.slug === "tohar-hamidbar-concentrate")?.quantity;
    check("REAL catalog updated to 15", q === 15, `quantity=${q}`);
    // restore
    const restore = await getCatalog();
    const p = restore.find((x) => x.slug === "tohar-hamidbar-concentrate");
    if (p && tohar) {
      p.quantity = tohar.quantity;
      p.updatedAt = new Date().toISOString();
      await saveCatalog(restore);
    }
    const final = await getCatalog();
    check(
      "catalog RESTORED",
      final.find((x) => x.slug === "tohar-hamidbar-concentrate")?.quantity === tohar?.quantity,
      `quantity=${final.find((x) => x.slug === "tohar-hamidbar-concentrate")?.quantity}`
    );
  }
}

console.log("\n=== 7. PDF document on letterhead ===");
{
  telegramCalls.length = 0;
  lastPdf = null;
  await sendText(
    OWNER_CHAT,
    "make me an offer document for Palm Hills — three sentences offering our facial treatments for their spa guests"
  );
  const docCall = telegramCalls.find((c) => c.url.includes("sendDocument"));
  check("sendDocument multipart captured", Boolean(docCall), JSON.stringify(docCall?.form));
  // TS can't see the fetch-closure reassignment — widen explicitly.
  const pdfBuf = lastPdf as Buffer | null;
  check(
    "PDF buffer present and looks like a PDF",
    Boolean(pdfBuf && pdfBuf.subarray(0, 5).toString().startsWith("%PDF")),
    `size=${pdfBuf?.length}`
  );
  if (pdfBuf) {
    const out = "/tmp/vassili-offer-sample.pdf";
    writeFileSync(out, pdfBuf);
    console.log("PDF saved for inspection:", out);
  }
  console.log("final agent text:", lastTelegramText().slice(0, 200));
}

console.log("\n=== 8. Daily-brief cron pushes to Telegram ===");
{
  telegramCalls.length = 0;
  const { GET: cronGET } = await import("../src/app/api/cron/daily-brief/route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest(
    "https://book.victoriaholisticbeauty.com/api/cron/daily-brief?force=1",
    { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }
  );
  const res = await cronGET(req);
  const json = (await res.json()) as { telegram?: { sent: boolean }; email?: unknown };
  console.log("cron response:", JSON.stringify(json).slice(0, 300));
  check("cron ok", res.status === 200);
  check("telegram push sent to bound owner", json.telegram?.sent === true);
  const pushed = telegramCalls.find(
    (c) => c.url.includes("sendMessage") && (c.body as { chat_id?: number })?.chat_id === OWNER_CHAT
  );
  check(
    "brief text pushed to owner chat",
    Boolean(pushed && /Good morning/.test(String((pushed.body as { text?: string })?.text)))
  );
}

console.log("\n=== cleanup: remove test telegram/* state from Blob ===");
for (const path of ["telegram/owner.json", "telegram/history.json", "telegram/alerts.json"]) {
  try {
    await del(path);
    console.log("deleted", path);
  } catch (e) {
    console.log("delete failed (ok if missing):", path, e instanceof Error ? e.message : e);
  }
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
