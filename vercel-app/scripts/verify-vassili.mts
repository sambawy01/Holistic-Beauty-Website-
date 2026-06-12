/**
 * End-to-end verification harness for Vassili (the Telegram assistant).
 *
 * Run from vercel-app/:   npx tsx scripts/verify-vassili.mts
 *
 * What is REAL: Vercel Blob (state/catalog — including product_add/remove,
 * hard-cleaned to byte-identical afterwards), Cal.com READS, Cal.com
 * OUT-OF-OFFICE create+delete (far-future day, removed immediately — the
 * empirical block_time verification), and the Ollama model (local ollama →
 * Ollama Cloud). What is MOCKED at the fetch boundary:
 * - api.telegram.org      → captured (no bot exists yet)
 * - Cal.com BOOKING mutations (confirm/decline/reschedule) → captured
 *   (never touch real bookings)
 * - api.resend.com        → captured (never send real emails; RESEND_API_KEY
 *   is also blanked for belt-and-braces)
 * - Blob READS of telegram/owner.json → 404 (undici-dispatcher seam), ONLY
 *   while section 19 runs — exercises the no-owner branch without ever
 *   deleting the real binding
 *
 * The script drives the real webhook route handler with synthetic Telegram
 * updates and asserts on the captured outbound calls.
 *
 * PRODUCTION-STATE SAFETY:
 * - telegram/owner.json, telegram/audit.jsonl and catalog/products.json are
 *   snapshotted at start and restored BYTE-IDENTICAL in a `finally` cleanup
 *   (even when the run crashes mid-way).
 * - If an owner record already exists whose chat id is NOT this harness's
 *   synthetic one, the run REFUSES to start (it would unbind the real owner)
 *   unless VASSILI_HARNESS_OVERRIDE=1 is set.
 * - telegram/history.json, telegram/alerts.json, telegram/pending/* and
 *   telegram/claims/* are working state created by the run and are deleted
 *   in cleanup.
 */

import { createHmac } from "node:crypto";
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
// Harness-controlled Cal webhook secret: synthetic BOOKING_* payloads are
// HMAC-signed with this so the route takes the trusted-payload path (a
// synthetic uid would fail the canonical Cal API lookup fallback).
process.env.CAL_WEBHOOK_SECRET = "test-cal-secret";

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

/**
 * When non-null, Ollama chat calls are answered from this queue instead of
 * the real model (request bodies captured in ollamaRequests for assertions).
 * Used to script EXACT tool calls — e.g. numbers-as-strings arguments — that
 * the real model can't be forced to emit deterministically.
 */
let scriptedOllama: { message: Record<string, unknown> }[] | null = null;
const ollamaRequests: {
  messages: { role: string; tool_name?: string; content: string }[];
}[] = [];

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

  if (
    scriptedOllama !== null &&
    (url.includes("ollama.com/api/chat") || url.includes(":11434/api/chat"))
  ) {
    if (typeof init?.body === "string") {
      ollamaRequests.push(JSON.parse(init.body));
    }
    const next = scriptedOllama.shift();
    if (!next) {
      return new Response(
        JSON.stringify({ error: "scripted Ollama queue exhausted" }),
        { status: 500 }
      );
    }
    return new Response(JSON.stringify(next), {
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

// --- undici interception (the Blob SDK's HTTP boundary) ----------------------------
// @vercel/blob performs ALL its HTTP through the `undici` package's fetch —
// NOT globalThis.fetch — and undici's fetch consults its module-global
// dispatcher at call time, so that is the seam. Two harness behaviours,
// passthrough otherwise (MockAgent with net-connect enabled):
// - blobOwner404Mock.activate(): GETs of telegram/owner.json answer 404
//   (the SDK maps a true 404 to null = "no owner bound") so section 19 can
//   exercise the no-owner branch WITHOUT deleting the real binding — a
//   SIGKILL mid-section can no longer leave one-time owner binding
//   reopened. Deactivated outside that section.
// - blobUrlLog: when non-null, records {method, url} of every Blob SDK
//   request — used to prove the stale-state sweep does NO content reads.
const { MockAgent, setGlobalDispatcher } = await import("undici");
let blobUrlLog: { method: string; url: string }[] | null = null;
const blobOwner404Mock = new MockAgent();
blobOwner404Mock.enableNetConnect(); // everything unmatched → real network
// MockAgent caches a CONCRETE pool per origin string on first dispatch; a
// function key's dispatch list is shared into that cache BY REFERENCE. So
// intercepts added mid-run only take effect when registered on the SAME
// key instance — a fresh arrow function would create a shadow pool that is
// never consulted again (verified empirically). Blob READS hit
// <store>.blob.vercel-storage.com (BLOB_STORE_ORIGIN); blob WRITES hit the
// API host https://vercel.com/api/blob, addressed by its exact origin
// string (BLOB_API_ORIGIN), which always resolves to the cached pool.
const BLOB_STORE_ORIGIN = (origin: string) =>
  origin.includes("vercel-storage.com");
const BLOB_API_ORIGIN = new URL(
  process.env.VERCEL_BLOB_API_URL || "https://vercel.com/api/blob"
).origin;
blobOwner404Mock
  .get(BLOB_STORE_ORIGIN)
  .intercept({
    path: (p: string) => p.includes("/telegram/owner.json"),
    method: "GET",
  })
  .reply(404, "Not Found")
  .persist();
blobOwner404Mock.deactivate(); // mocking OFF by default — section 19 only
setGlobalDispatcher(
  blobOwner404Mock.compose((dispatch) => (opts, handler) => {
    if (blobUrlLog) {
      blobUrlLog.push({
        method: String(opts.method),
        url: `${String(opts.origin)}${String(opts.path)}`,
      });
    }
    return dispatch(opts, handler);
  })
);

// --- app imports (after env + fetch patch) ----------------------------------------
const { POST: webhookPOST } = await import("../src/app/api/telegram/webhook/route");
const { POST: calWebhookPOST } = await import("../src/app/api/cal/webhook/route");
const { POST: orderPOST } = await import("../src/app/api/order/route");
const {
  getOwnerChatId,
  createPendingAction,
  takePendingAction,
  discardPendingAction,
  retirePendingAction,
  sweepStalePendingState,
  isSweepStale,
  STALE_SWEEP_RETENTION_MS,
  NOTIFY_PENDING_TTL_MS,
} = await import("../src/lib/assistant/state");
const { claimDailySend } = await import("../src/lib/reports/shared");
const { getCatalog, saveCatalog } = await import("../src/lib/catalog");
const { executeTool, describeMutation, validateMutationArgs } = await import(
  "../src/lib/assistant/tools"
);
const { listOrders, getOrder } = await import("../src/lib/orders");
const { listOutOfOffice, deleteOutOfOffice, listOwnerBookings } = await import(
  "../src/lib/admin/cal"
);
const { del, get, list, put } = await import("@vercel/blob");

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

/** Cal.com webhook request, HMAC-signed so the route trusts the payload. */
function calRequest(body: unknown): Request {
  const raw = JSON.stringify(body);
  const signature = createHmac("sha256", process.env.CAL_WEBHOOK_SECRET!)
    .update(raw)
    .digest("hex");
  return new Request("https://book.victoriaholisticbeauty.com/api/cal/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-cal-signature-256": signature,
    },
    body: raw,
  });
}

/** Shop order POST (no Origin header — same-origin is allowed by CORS). */
function orderRequest(body: unknown): Request {
  return new Request("https://book.victoriaholisticbeauty.com/api/order", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Pushed-button callback data must be a confirm-verb pending-action id. */
const CONFIRM_BTN_RE =
  /^confirm:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type CapturedKeyboard = {
  text?: string;
  reply_markup?: {
    inline_keyboard?: { text: string; callback_data: string }[][];
  };
};

function keyboardRow(cap: Captured | undefined) {
  return (cap?.body as CapturedKeyboard | undefined)?.reply_markup
    ?.inline_keyboard?.[0] ?? [];
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

/**
 * Raw bytes of a blob, or null ONLY when the blob truly does not exist (the
 * SDK's 404 → null result). ANY other outcome — transport error, non-200
 * status — THROWS so the run aborts BEFORE mutating anything. Treating a
 * transient failure as "absent" at snapshot time would skip the real-owner
 * refusal gate below and make cleanup delete the production owner binding
 * (or restore catalog/products.json to "absent", deleting the live catalog).
 */
async function readBlobText(
  pathname: string,
  getImpl: typeof get = get
): Promise<string | null> {
  const r = await getImpl(pathname, { access: "private", useCache: false });
  if (r === null) return null; // SDK's true not-found — the blob is absent
  if (r.statusCode !== 200 || !r.stream) {
    throw new Error(
      `readBlobText(${pathname}): unexpected non-200 blob read (statusCode=${r.statusCode}) — refusing to treat as absent`
    );
  }
  return new Response(r.stream).text();
}

/** Restore a blob to its snapshotted bytes (null snapshot = delete). */
async function restoreBlobText(
  pathname: string,
  snapshot: string | null,
  contentType: string
): Promise<void> {
  if (snapshot === null) {
    try {
      await del(pathname);
    } catch {
      // already missing — fine
    }
    return;
  }
  await put(pathname, snapshot, {
    access: "private",
    contentType,
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}

const RUN_STARTED_AT = new Date().toISOString();

// ====================================================================================
// Fail-closed self-test BEFORE the snapshot reads: a non-404 failure must
// THROW (aborting the run pre-mutation), never classify as "absent".
{
  let transportThrew = false;
  try {
    await readBlobText("telegram/owner.json", (async () => {
      throw new Error("simulated transient blob transport failure");
    }) as unknown as typeof get);
  } catch {
    transportThrew = true;
  }
  let non200Threw = false;
  try {
    await readBlobText("telegram/owner.json", (async () => ({
      statusCode: 304,
      stream: null,
    })) as unknown as typeof get);
  } catch {
    non200Threw = true;
  }
  check(
    "snapshot reads fail closed: non-404 blob failures throw, never read as 'absent'",
    transportThrew && non200Threw
  );
}

// ====================================================================================
// Snapshot production state FIRST — restored byte-identical in the finally
// cleanup at the bottom, even when the run crashes. These top-level awaits
// run BEFORE the mutating try block: any snapshot-read throw aborts the
// process with nothing touched.
// VASSILI_SIMULATE_SNAPSHOT_READ_FAILURE=1 injects a transient-500-style
// failure here so the abort-before-mutation behaviour can be verified from
// the outside (expected: non-zero exit, section 0 never runs).
const snapshotGet: typeof get =
  process.env.VASSILI_SIMULATE_SNAPSHOT_READ_FAILURE === "1"
    ? ((async () => {
        throw new Error(
          "simulated transient blob 500 (VASSILI_SIMULATE_SNAPSHOT_READ_FAILURE=1)"
        );
      }) as unknown as typeof get)
    : get;
console.log("=== snapshot: owner.json / audit.jsonl / products.json ===");
const ownerSnapshot = await readBlobText("telegram/owner.json", snapshotGet);
const auditSnapshot = await readBlobText("telegram/audit.jsonl", snapshotGet);
const productsSnapshot = await readBlobText("catalog/products.json", snapshotGet);
console.log(
  `owner=${ownerSnapshot === null ? "absent" : "present"}, audit=${
    auditSnapshot === null ? "absent" : `${auditSnapshot.length} bytes`
  }, products=${productsSnapshot === null ? "absent" : `${productsSnapshot.length} bytes`}`
);

// REFUSE to run against a real owner binding: section 0 unbinds the owner and
// the run re-binds the synthetic harness chat. A crash before cleanup would
// leave Victoria unbound (and binding reopened). Override only deliberately.
if (ownerSnapshot !== null && process.env.VASSILI_HARNESS_OVERRIDE !== "1") {
  let boundChatId: number | null = null;
  try {
    const parsed = JSON.parse(ownerSnapshot) as { chatId?: unknown };
    boundChatId = typeof parsed.chatId === "number" ? parsed.chatId : null;
  } catch {
    boundChatId = null; // unparseable — treat as unknown real state
  }
  if (boundChatId !== OWNER_CHAT) {
    console.error(
      `\nREFUSING TO RUN: telegram/owner.json holds a real owner binding (chatId=${boundChatId ?? "unparseable"}).\n` +
        "Running the harness would unbind the production owner. Set VASSILI_HARNESS_OVERRIDE=1 to override\n" +
        "(the snapshot/restore cleanup will put the record back, but only if the run reaches cleanup)."
    );
    process.exit(2);
  }
}

let crashed: unknown = null;
try {
  // ====================================================================================
  console.log("\n=== 0. Reset telegram/* state (idempotent harness) ===");
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

  console.log("\n=== 2c. Owner tapping a stale/inaccessible-message button ===");
  {
    // Telegram omits callback_query.message for messages older than ~48h or
    // otherwise inaccessible. The OWNER pressing such a button is not an
    // intruder: expect a quiet "expired" answer, no alert, no intruder audit.
    telegramCalls.length = 0;
    await webhookPOST(
      tgRequest({
        update_id: updateId++,
        callback_query: {
          id: "cbq-stale-owner",
          data: "confirm:00000000-0000-4000-8000-000000000000",
          from: { id: OWNER_CHAT, first_name: "Test" },
          // no `message` field — stale/inaccessible
        },
      }) as never
    );
    const staleAnswer = telegramCalls.find((c) => c.url.includes("answerCallbackQuery"));
    check(
      "owner stale-button tap → 'expired' callback answer",
      Boolean(
        staleAnswer &&
          /expired/i.test(String((staleAnswer.body as { text?: string })?.text))
      ),
      JSON.stringify(staleAnswer?.body).slice(0, 160)
    );
    check(
      "owner stale-button tap → NO intruder alert about herself",
      messagesTo(OWNER_CHAT, ALERT_RE).length === 0
    );
    const audit = await readAuditEntries();
    check(
      "owner stale-button tap → no unauthorized-callback audit entry",
      !audit.some(
        (e) =>
          e.kind === "unauthorized-callback" &&
          e.chatId === OWNER_CHAT &&
          typeof e.at === "string" &&
          e.at >= RUN_STARTED_AT
      )
    );
  }

  console.log("\n=== 2d. Pre-binding /start nudge (owner-unbound window only) ===");
  {
    const NUDGE_RE = /if you're victoria/i;
    const NUDGE_FORM_RE = /\/start <your access phrase>/;

    // (b) BOUND state — the real synthetic owner binding from section 2 is
    // live. A bare /start from a NON-OWNER must still hit the UNCHANGED
    // generic wall: never the nudge, never any hint that binding exists.
    telegramCalls.length = 0;
    await sendText(STRANGER_CHAT, "/start");
    const boundReply = lastTelegramText();
    check(
      "bound + non-owner bare /start → generic wall, NOT the nudge",
      REFUSAL_RE.test(boundReply) &&
        !NUDGE_RE.test(boundReply) &&
        !NUDGE_FORM_RE.test(boundReply),
      boundReply.slice(0, 160)
    );
    check(
      "bound wall leaks neither the access phrase nor that an owner is bound",
      !boundReply.includes(ADMIN_PASS) &&
        !/\bbind|\bowner\b|already connected/i.test(boundReply),
      boundReply.slice(0, 160)
    );

    // (a) UNBOUND simulation via the owner-404 seam (owner.json is NEVER
    // deleted — the SDK maps a true 404 to null = "no owner bound").
    const ownerBytesBefore = await readBlobText("telegram/owner.json");
    check(
      "owner binding present before the unbound simulation",
      ownerBytesBefore !== null
    );
    try {
      blobOwner404Mock.activate();
      check(
        "seam active: getOwnerChatId() reports unbound (owner.json untouched)",
        (await getOwnerChatId()) === null
      );

      // Bare /start while unbound → gentle nudge, not the wall.
      telegramCalls.length = 0;
      await sendText(STRANGER_CHAT, "/start");
      const nudge = lastTelegramText();
      check(
        "unbound + bare /start → nudge text (not the wall)",
        NUDGE_RE.test(nudge) &&
          NUDGE_FORM_RE.test(nudge) &&
          !REFUSAL_RE.test(nudge),
        nudge.slice(0, 200)
      );

      // Wrong-password /start while unbound → the generic wall, NOT the nudge.
      // A present-but-wrong phrase is a guesser probing: it must learn nothing
      // (no nudge, no pass leak, no closeness hint, no echo of the guess).
      telegramCalls.length = 0;
      await sendText(STRANGER_CHAT, "/start totally-wrong-guess");
      const wrongReply = lastTelegramText();
      check(
        "unbound + wrong-pass /start → generic wall, NOT the nudge",
        REFUSAL_RE.test(wrongReply) &&
          !NUDGE_RE.test(wrongReply) &&
          !NUDGE_FORM_RE.test(wrongReply) &&
          !wrongReply.includes(ADMIN_PASS) &&
          !/totally-wrong-guess/.test(wrongReply) &&
          !/close|correct|almost|right password/i.test(wrongReply),
        wrongReply.slice(0, 200)
      );
    } finally {
      blobOwner404Mock.deactivate();
    }

    // (c) The seam-based simulation never wrote to owner.json.
    check(
      "owner.json byte-identical after the nudge simulation (seam, never deleted)",
      (await readBlobText("telegram/owner.json")) === ownerBytesBefore
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

  // Sections 4–5 act on whatever booking is PENDING on Cal right now (the
  // harness never hardcodes uids — live data changes between runs).
  const pendingNow = (await listOwnerBookings()).filter(
    (b) => (b.status || "").toLowerCase() === "pending"
  );
  const flowTarget = pendingNow[0];
  const flowClient = flowTarget?.attendees?.[0]?.name ?? "";
  const flowService = (flowTarget?.title || "Booking").split(" between ")[0];

  console.log(
    `\n=== 4. Confirm-booking flow (live pending: ${flowClient || "NONE"}) — Cal mutation stubbed ===`
  );
  if (!flowTarget) {
    check("confirm flow (skipped — no pending bookings on Cal right now)", true);
  } else {
    telegramCalls.length = 0;
    calMutations.length = 0;
    await sendText(
      OWNER_CHAT,
      `please confirm ${flowClient}'s pending "${flowService}" booking request`
    );
    const confirmMsg = lastTelegramText();
    const pendingId = lastKeyboardPendingId();
    console.log("--- confirm prompt ---\n" + confirmMsg + "\npendingId: " + pendingId);
    check("agent asked for confirmation with keyboard", pendingId !== null);
    check(
      `summary references the real uid (${flowTarget.uid})`,
      confirmMsg.includes(flowTarget.uid),
      confirmMsg.slice(0, 160)
    );
    check(
      "confirm summary disclosure: client gets a confirmation email",
      /client will receive a booking-confirmation email/i.test(confirmMsg),
      confirmMsg.slice(0, 220)
    );
    check("no Cal mutation before Confirm tap", calMutations.length === 0);

    if (pendingId) {
      telegramCalls.length = 0;
      await tapButton(OWNER_CHAT, `confirm:${pendingId}`);
      check(
        "Confirm tap → confirmBooking called with the right uid",
        calMutations.some((c) => c.url.includes(`/bookings/${flowTarget.uid}/confirm`)),
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
  if (!flowTarget) {
    check("cancel path (skipped — no pending bookings on Cal right now)", true);
  } else {
    telegramCalls.length = 0;
    calMutations.length = 0;
    await sendText(
      OWNER_CHAT,
      `decline ${flowClient}'s "${flowService}" booking request, reason: schedule conflict`
    );
    const pendingId = lastKeyboardPendingId();
    check("decline parked behind keyboard", pendingId !== null, lastTelegramText().slice(0, 140));
    check(
      "decline summary disclosure: reason is emailed to the client",
      /EMAILED this reason/.test(lastTelegramText()),
      lastTelegramText().slice(0, 220)
    );
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

  console.log("\n=== 6. Catalog mutation (REAL blob): tohar → 15 → byte-identical restore ===");
  {
    // Raw bytes BEFORE the mutation — restored EXACTLY afterwards. A logical
    // restore (read-modify-write) would stamp a fresh updatedAt and leave the
    // blob different from production state.
    const section6Bytes = await readBlobText("catalog/products.json");
    check("catalog blob exists for byte-identical restore", section6Bytes !== null);

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
      // restore the EXACT pre-mutation bytes
      if (section6Bytes !== null) {
        await restoreBlobText("catalog/products.json", section6Bytes, "application/json");
      }
      const restored = await readBlobText("catalog/products.json");
      check(
        "catalog blob byte-identical after section 6 restore",
        section6Bytes !== null && restored === section6Bytes,
        `len ${section6Bytes?.length} → ${restored?.length}`
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

  console.log("\n=== 9. Read-only tools: stats_summary / client_history / order_lookup ===");
  {
    const ctx = { chatId: OWNER_CHAT };

    const stats = await executeTool("stats_summary", { period: "month" }, ctx);
    console.log("--- stats_summary(month) ---\n" + stats);
    check(
      "stats_summary returns real aggregates",
      /Stats for this month/.test(stats) &&
        /Bookings — \d+ confirmed/.test(stats) &&
        /Orders — \d+ total, \d+ EGP revenue/.test(stats)
    );

    const hist = await executeTool("client_history", { query: "hany" }, ctx);
    console.log("--- client_history(hany) ---\n" + hist.slice(0, 500));
    check(
      "client_history matches by name substring",
      /hany/i.test(hist) && /booking\(s\)/.test(hist)
    );

    const someOrder = (await listOrders({ limit: 1 }))[0];
    if (someOrder) {
      const lookup = await executeTool(
        "order_lookup",
        { orderNumber: someOrder.orderNumber },
        ctx
      );
      console.log("--- order_lookup ---\n" + lookup);
      check(
        "order_lookup gives full detail (items, totals, address, history)",
        lookup.includes(someOrder.orderNumber) &&
          /Items:/.test(lookup) &&
          /Address:/.test(lookup) &&
          /Total: \d+ EGP/.test(lookup) &&
          /Status history:/.test(lookup)
      );
    } else {
      check("order_lookup full detail (skipped — no orders in store)", true);
    }

    // Via the agent these are read-only: instant answer, NO confirm keyboard.
    telegramCalls.length = 0;
    await sendText(OWNER_CHAT, "how is this month going? give me the stats summary");
    check(
      "stats via agent → instant reply, no keyboard",
      lastKeyboardPendingId() === null && lastTelegramText().length > 10,
      lastTelegramText().slice(0, 140)
    );
  }

  console.log("\n=== 10. product_add → live → product_remove → byte-identical restore ===");
  {
    // Raw catalog bytes BEFORE — the test must leave the blob byte-identical.
    const beforeText = await readBlobText("catalog/products.json");
    check("catalog blob exists for byte-identical comparison", beforeText !== null);

    telegramCalls.length = 0;
    await sendText(
      OWNER_CHAT,
      'add a new product to the shop: English name "Test Harness Balm", Russian name "Тестовый бальзам", price 999 EGP, quantity 3'
    );
    const addId = lastKeyboardPendingId();
    const addPrompt = lastTelegramText();
    console.log("--- add prompt ---\n" + addPrompt);
    check("product_add parked behind keyboard", addId !== null, addPrompt.slice(0, 200));
    check(
      "add summary disclosure: product goes LIVE on the site",
      /LIVE on the public site/i.test(addPrompt),
      addPrompt.slice(0, 220)
    );
    check(
      "catalog unchanged before Confirm",
      !(await getCatalog()).some(
        (p) => p.en.name === "Test Harness Balm" || p.slug.startsWith("test-harness")
      )
    );

    let slug = "";
    if (addId) {
      telegramCalls.length = 0;
      await tapButton(OWNER_CHAT, `confirm:${addId}`);
      const after = await getCatalog();
      const added = after.find(
        (p) => p.en.name === "Test Harness Balm" || p.slug.startsWith("test-harness")
      );
      slug = added?.slug ?? "";
      check(
        "REAL catalog gained the product (active, 999 EGP, qty 3)",
        Boolean(
          added &&
            added.active &&
            added.priceEgp === 999 &&
            added.quantity === 3 &&
            !added.soldOut
        ),
        JSON.stringify(added).slice(0, 200)
      );
    }

    if (slug) {
      telegramCalls.length = 0;
      await sendText(OWNER_CHAT, `now remove the product ${slug} from the shop`);
      const rmId = lastKeyboardPendingId();
      const rmPrompt = lastTelegramText();
      console.log("--- remove prompt ---\n" + rmPrompt);
      check("product_remove parked behind keyboard", rmId !== null, rmPrompt.slice(0, 160));
      check(
        "remove summary disclosure: hidden from site, reversible",
        /disappears from the public site/i.test(rmPrompt) && /reversible/i.test(rmPrompt),
        rmPrompt.slice(0, 220)
      );
      if (rmId) {
        await tapButton(OWNER_CHAT, `confirm:${rmId}`);
        const after = await getCatalog();
        const p = after.find((x) => x.slug === slug);
        check(
          "soft-removed: active=false but still in catalog",
          Boolean(p && p.active === false),
          JSON.stringify(p).slice(0, 160)
        );
      }
      // Hard cleanup: drop the test product entirely.
      const cleaned = (await getCatalog()).filter((p) => p.slug !== slug);
      await saveCatalog(cleaned);
    }

    const afterText = await readBlobText("catalog/products.json");
    check(
      "catalog byte-identical after hard cleanup",
      beforeText !== null && afterText === beforeText,
      `len ${beforeText?.length} → ${afterText?.length}`
    );
  }

  console.log("\n=== 11. block_time: REAL far-future Cal OOO create + cleanup ===");
  {
    telegramCalls.length = 0;
    await sendText(
      OWNER_CHAT,
      "block my calendar for 5 March 2027 (the whole day), note: harness test"
    );
    const blockId = lastKeyboardPendingId();
    const blockPrompt = lastTelegramText();
    console.log("--- block prompt ---\n" + blockPrompt);
    check("block_time parked behind keyboard", blockId !== null, blockPrompt.slice(0, 200));
    check(
      "block summary disclosure: WHOLE days become unbookable",
      /WHOLE day/i.test(blockPrompt) && /unbookable/i.test(blockPrompt),
      blockPrompt.slice(0, 220)
    );
    if (blockId) {
      telegramCalls.length = 0;
      await tapButton(OWNER_CHAT, `confirm:${blockId}`);
      const edited = telegramCalls.find((c) => c.url.includes("editMessageText"));
      console.log(
        "block result:",
        String((edited?.body as { text?: string })?.text).slice(0, 220)
      );
      const entries = await listOutOfOffice();
      const mine = entries.filter((e) => (e.start || "").startsWith("2027-03-05"));
      check(
        "REAL Cal OOO entry created for 2027-03-05",
        mine.length === 1,
        JSON.stringify(entries).slice(0, 300)
      );
      for (const e of mine) await deleteOutOfOffice(e.id);
      const left = (await listOutOfOffice()).filter((e) =>
        (e.start || "").startsWith("2027-03-05")
      );
      check("OOO entry cleaned up (calendar unblocked)", left.length === 0);
    }
  }

  console.log("\n=== 12. Russian PDF via agent (embedded Cyrillic fonts) ===");
  {
    telegramCalls.length = 0;
    lastPdf = null;
    await sendText(
      OWNER_CHAT,
      "сделай PDF-документ: коммерческое предложение для спа-отеля, два-три предложения на русском"
    );
    const ruPdf = lastPdf as Buffer | null;
    check(
      "RU PDF generated",
      Boolean(ruPdf && ruPdf.subarray(0, 5).toString().startsWith("%PDF")),
      `size=${ruPdf?.length}`
    );
    check(
      "embedded PT fonts present in the PDF (no built-in Latin-only fonts)",
      Boolean(
        ruPdf &&
          (ruPdf.includes("PTSerif-Regular") || ruPdf.includes("PTSans-Regular")) &&
          !ruPdf.includes("/BaseFont /Helvetica")
      )
    );
    if (ruPdf) {
      writeFileSync("/tmp/vassili-ru-agent-sample.pdf", ruPdf);
      console.log("RU PDF saved for visual inspection: /tmp/vassili-ru-agent-sample.pdf");
    }
    console.log("final agent text:", lastTelegramText().slice(0, 200));
  }

  console.log("\n=== 13. Disclosure: order status email & outsider email preview ===");
  {
    // Structural guarantees first — disclosure lives in describeMutation, so
    // these hold no matter what live data exists.
    check(
      "describeMutation(order_set_status→shipped) discloses the status email",
      /client will receive a status email/i.test(
        describeMutation("order_set_status", { orderNumber: "VV-TEST00", status: "shipped" })
      )
    );
    check(
      "describeMutation(order_set_status→cancelled) discloses reason email",
      /cancellation email INCLUDING this reason/i.test(
        describeMutation("order_set_status", {
          orderNumber: "VV-TEST00",
          status: "cancelled",
          reason: "out of stock",
        })
      )
    );
    check(
      "describeMutation(booking_decline) discloses reason email",
      /EMAILED this reason/.test(
        describeMutation("booking_decline", { uid: "x", reason: "y" })
      )
    );
    check(
      "describeMutation(email_send) shows recipient + subject + full body",
      (() => {
        const d = describeMutation("email_send", {
          to: "a@b.com",
          subject: "S",
          body: "full body text here",
        });
        return (
          d.includes("a@b.com") &&
          d.includes('Subject: "S"') &&
          d.includes("full body text here")
        );
      })()
    );

    // order_set_status: park → assert disclosure → CANCEL (no real change).
    const mutable = (await listOrders({ limit: 30 })).find(
      (o) => o.status === "ordered" || o.status === "confirmed"
    );
    if (mutable) {
      const next = mutable.status === "ordered" ? "confirmed" : "shipped";
      telegramCalls.length = 0;
      await sendText(OWNER_CHAT, `set order ${mutable.orderNumber} to ${next}`);
      const id = lastKeyboardPendingId();
      const prompt = lastTelegramText();
      console.log("--- status prompt ---\n" + prompt);
      check("order_set_status parked behind keyboard", id !== null, prompt.slice(0, 160));
      check(
        "status summary disclosure: client receives a status email",
        /client will receive a (status|cancellation) email/i.test(prompt),
        prompt.slice(0, 220)
      );
      if (id) await tapButton(OWNER_CHAT, `cancel:${id}`);
      const fresh = (await listOrders({ limit: 30 })).find(
        (o) => o.orderNumber === mutable.orderNumber
      );
      check(
        "order untouched after Cancel",
        fresh?.status === mutable.status,
        `status=${fresh?.status}`
      );
    } else {
      check("order_set_status disclosure (skipped — no mutable order)", true);
    }

    // email_send to an outsider: summary must show recipient + subject + FULL body.
    telegramCalls.length = 0;
    resendCalls.length = 0;
    await sendText(
      OWNER_CHAT,
      'send an email to partner@example.com with subject "Samples" and exactly this body: "Hello! The Onmacabim samples ship on Monday. Warm regards, Victoria"'
    );
    const mailId = lastKeyboardPendingId();
    const mailPrompt = lastTelegramText();
    console.log("--- email prompt ---\n" + mailPrompt);
    check("outsider email parked behind keyboard", mailId !== null);
    check(
      "email summary shows recipient + subject + full body preview",
      mailPrompt.includes("partner@example.com") &&
        /Subject:/.test(mailPrompt) &&
        /full message/.test(mailPrompt) &&
        /samples/i.test(mailPrompt),
      mailPrompt.slice(0, 300)
    );
    check("no email sent before confirm", resendCalls.length === 0);
    if (mailId) await tapButton(OWNER_CHAT, `cancel:${mailId}`);
  }

  console.log("\n=== 14. Pending-action concurrency: exactly-once claims ===");
  {
    // Two PARALLEL Confirm taps on one pending action: exactly one may
    // execute. del() succeeds silently on already-deleted blobs, so this is
    // only safe with the atomic claim (allowOverwrite: false) underneath.
    const a = await createPendingAction({
      chatId: OWNER_CHAT,
      tool: "email_send",
      args: { to: "x@example.com", subject: "s", body: "b" },
      summary: "concurrency test A",
    });
    const [r1, r2] = await Promise.all([
      takePendingAction(a.id),
      takePendingAction(a.id),
    ]);
    check(
      "Confirm+Confirm in parallel → exactly one wins",
      (r1.ok ? 1 : 0) + (r2.ok ? 1 : 0) === 1,
      JSON.stringify({ r1, r2 }).slice(0, 200)
    );

    // Confirm racing Cancel: exactly one may claim the action.
    const b = await createPendingAction({
      chatId: OWNER_CHAT,
      tool: "email_send",
      args: { to: "x@example.com", subject: "s", body: "b" },
      summary: "concurrency test B",
    });
    const [take, discarded] = await Promise.all([
      takePendingAction(b.id),
      discardPendingAction(b.id),
    ]);
    check(
      "Confirm+Cancel in parallel → exactly one wins",
      (take.ok ? 1 : 0) + (discarded ? 1 : 0) === 1,
      JSON.stringify({ take, discarded }).slice(0, 200)
    );

    // Sequential second tap after a win still finds nothing.
    const r3 = await takePendingAction(a.id);
    check("third (late) Confirm tap → not-found", !r3.ok);

    // Stale Cancel honesty: once the pending blob is gone (executed,
    // cancelled, or swept after expiry), discard must return false — the
    // route then says "no longer available", never the lie
    // "Cancelled — nothing was changed".
    const staleCancel = await discardPendingAction(b.id);
    check("stale Cancel on already-handled pending → false", staleCancel === false);
    const ghostCancel = await discardPendingAction(crypto.randomUUID());
    check("Cancel on a never-existing pending id → false", ghostCancel === false);
  }

  console.log("\n=== 14b. Stale-state sweep: uploadedAt-only, no content reads ===");
  {
    // The sweep runs fire-and-forget inside createPendingAction (it must
    // never block the Cal-webhook/order hot paths); here it is called
    // directly and its Blob traffic observed at the undici dispatcher.
    //
    // Cutoff rule first (pure — real stale blobs can't be faked because
    // uploadedAt is server-assigned): one shared 14-day horizon for BOTH
    // prefixes, so a claim marker always outlives any pending (incl. 7-day
    // pushed buttons) it could be guarding.
    check(
      "sweep retention = 2× the LONGEST pending TTL (claims outlive 7-day pendings)",
      STALE_SWEEP_RETENTION_MS === 2 * NOTIFY_PENDING_TTL_MS
    );
    const now = Date.now();
    check(
      "isSweepStale: beyond the horizon → stale; within → kept; garbage → kept",
      isSweepStale(new Date(now - STALE_SWEEP_RETENTION_MS - 60_000), now) === true &&
        isSweepStale(new Date(now - STALE_SWEEP_RETENTION_MS + 60_000), now) === false &&
        isSweepStale("not-a-date", now) === false
    );

    // Live behaviour: park a pending + leave a claim marker (take a second
    // one), then sweep and prove (a) no content reads, (b) both prefixes
    // listed, (c) fresh state survives.
    const keepMe = await createPendingAction({
      chatId: OWNER_CHAT,
      tool: "email_send",
      args: { to: "x@example.com", subject: "s", body: "b" },
      summary: "sweep survivor",
    });
    const claimed = await createPendingAction({
      chatId: OWNER_CHAT,
      tool: "email_send",
      args: { to: "x@example.com", subject: "s", body: "b" },
      summary: "sweep claim source",
    });
    await takePendingAction(claimed.id); // leaves telegram/claims/<id>.json

    blobUrlLog = [];
    await sweepStalePendingState();
    const swept = blobUrlLog;
    blobUrlLog = null;

    // A content read is a GET whose URL PATH targets an individual blob
    // under either prefix; list() carries the prefix in the QUERY string.
    const contentReads = swept.filter((e) => {
      if (e.method !== "GET") return false;
      try {
        const p = new URL(e.url).pathname;
        return p.includes("/telegram/pending/") || p.includes("/telegram/claims/");
      } catch {
        return false;
      }
    });
    check(
      "sweep performs ZERO content reads (judges by list()'s uploadedAt only)",
      contentReads.length === 0,
      contentReads.map((e) => e.url).join(", ").slice(0, 200)
    );
    const decoded = swept.map((e) => {
      try {
        return `${e.method} ${decodeURIComponent(e.url)}`;
      } catch {
        return `${e.method} ${e.url}`;
      }
    });
    check(
      "sweep lists BOTH prefixes (claims AND pending)",
      decoded.some((u) => u.startsWith("GET") && u.includes("prefix=telegram/claims/")) &&
        decoded.some((u) => u.startsWith("GET") && u.includes("prefix=telegram/pending/")),
      decoded.join(" | ").slice(0, 300)
    );
    check(
      "fresh pending survives the sweep",
      (await readBlobText(`telegram/pending/${keepMe.id}.json`)) !== null
    );
    check(
      "fresh claim marker survives the sweep (still guards its pending)",
      (await readBlobText(`telegram/claims/${claimed.id}.json`)) !== null
    );
    // keepMe/claim blobs are removed by the final cleanup's full sweep.
  }

  console.log(
    "\n=== 14c. Sibling retire: claim written even when the pending read fails ==="
  );
  {
    // The webhook executor retires the OTHER button of a pushed pair after
    // a winning claim. discardPendingAction's existence-read-before-claim
    // is right for the Cancel-tap UX (honest "no longer available") but
    // wrong for retirement: a transient Blob read failure would skip the
    // claim write and leave the sibling button live for the rest of its
    // 7-day TTL. retirePendingAction does NO read — the claim marker (the
    // kill switch) is written unconditionally. Simulated read outage: the
    // undici seam answers 500 for GETs of these two pending blobs (get()
    // throws on a 500, no retry); PUT/DELETE pass through to the real store.
    const retireId = crypto.randomUUID();
    const discardId = crypto.randomUUID();
    const mkPending = (id: string) =>
      put(
        `telegram/pending/${id}.json`,
        JSON.stringify({
          id,
          chatId: OWNER_CHAT,
          tool: "booking_confirm",
          args: { uid: "sibling-retire-uid" },
          summary: "sibling-retire harness pending",
          createdAt: new Date().toISOString(),
          ttlMs: NOTIFY_PENDING_TTL_MS,
        }),
        {
          access: "private",
          contentType: "application/json",
          addRandomSuffix: false,
          allowOverwrite: true,
        }
      );
    await mkPending(retireId);
    await mkPending(discardId);
    blobOwner404Mock
      .get(BLOB_STORE_ORIGIN) // SAME key instance — see the MockAgent note
      .intercept({
        path: (p: string) =>
          p.includes(`/telegram/pending/${retireId}.json`) ||
          p.includes(`/telegram/pending/${discardId}.json`),
        method: "GET",
      })
      .reply(500, "harness simulated blob read outage")
      .persist();
    try {
      blobOwner404Mock.activate();
      // Baseline — the OLD sibling path (discardPendingAction): the failed
      // existence read aborts BEFORE the claim, leaving the button live.
      // This is exactly the gap retirePendingAction closes.
      let discardOutcome: boolean | "threw" = "threw";
      try {
        discardOutcome = await discardPendingAction(discardId);
      } catch {
        // get() throwing on the 500 is part of the simulated outage
      }
      check(
        "discardPendingAction under read outage: NO claim marker written (the gap)",
        discardOutcome !== true &&
          (await readBlobText(`telegram/claims/${discardId}.json`)) === null,
        `outcome=${String(discardOutcome)}`
      );
      // retirePendingAction: never reads, never throws — the claim marker
      // lands despite the read outage, so the sibling can never execute.
      await retirePendingAction(retireId);
      check(
        "retirePendingAction under read outage: claim marker written (sibling killed)",
        (await readBlobText(`telegram/claims/${retireId}.json`)) !== null
      );
    } finally {
      blobOwner404Mock.deactivate();
    }
    check(
      "retired pending blob deleted (best-effort delete succeeded here)",
      (await readBlobText(`telegram/pending/${retireId}.json`)) === null
    );
    const lateTake = await takePendingAction(retireId);
    check(
      "post-retire tap on the sibling → not-found (kill switch holds)",
      !lateTake.ok && lateTake.reason === "not-found",
      JSON.stringify(lateTake)
    );
    // discardId pending + retire claim marker are removed by final cleanup.
  }

  console.log("\n=== 15. Mutation-arg validation (summary/executor parity) ===");
  {
    const arrayTo = validateMutationArgs("email_send", {
      to: ["attacker@evil.com"],
      subject: "Hi",
      body: "B",
    });
    check("array-typed `to` → REFUSED (never parked)", arrayTo.ok === false);

    const badEmail = validateMutationArgs("email_send", {
      to: "not-an-email",
      subject: "s",
      body: "b",
    });
    check("non-email `to` → REFUSED", badEmail.ok === false);

    const good = validateMutationArgs("email_send", {
      to: " a@b.com ",
      subject: "s",
      body: "b",
      undeclaredExtra: "dropped",
    });
    check(
      "valid email_send passes, trimmed + undeclared params dropped",
      good.ok === true &&
        good.args.to === "a@b.com" &&
        !("undeclaredExtra" in good.args)
    );

    const objSlug = validateMutationArgs("product_update", {
      slug: { $gt: "" },
      quantity: 5,
    });
    check("non-string slug on product_update → REFUSED", objSlug.ok === false);

    // Numbers-as-strings: lossless ones coerce (and the summary renders the
    // coerced value — confirm-what-executes preserved); lossy/non-numeric
    // strings are still refused.
    const strQty = validateMutationArgs("product_update", {
      slug: "tohar-hamidbar-concentrate",
      quantity: "15",
    });
    check(
      "lossless numeric string quantity '15' → coerced to number 15",
      strQty.ok === true && strQty.args.quantity === 15
    );
    const strPrice = validateMutationArgs("product_update", {
      slug: "tohar-hamidbar-concentrate",
      priceEgp: "250",
    });
    check(
      "string priceEgp '250' → coerced; summary renders 250 EGP",
      strPrice.ok === true &&
        strPrice.args.priceEgp === 250 &&
        /price 250 EGP/.test(describeMutation("product_update", strPrice.args))
    );
    const lossyQty = validateMutationArgs("product_update", {
      slug: "tohar-hamidbar-concentrate",
      quantity: "015",
    });
    check("lossy numeric string '015' → still REFUSED", lossyQty.ok === false);
    const nonNumQty = validateMutationArgs("product_update", {
      slug: "tohar-hamidbar-concentrate",
      quantity: "lots",
    });
    check("non-numeric string quantity → REFUSED", nonNumQty.ok === false);

    const missingReason = validateMutationArgs("booking_decline", { uid: "u1" });
    check("missing required reason on booking_decline → REFUSED", missingReason.ok === false);

    const badStatus = validateMutationArgs("order_set_status", {
      orderNumber: "VV-AB12CD",
      status: "exploded",
    });
    check("enum violation on order_set_status → REFUSED", badStatus.ok === false);
  }

  console.log(
    "\n=== 15b. Agent loop (scripted model): string price parks coerced; invalid arg → retry round ==="
  );
  {
    // (a) Model emits '"priceEgp": "250"' (numbers-as-strings) — must be
    // coerced, parked behind the keyboard, and the summary must show 250.
    telegramCalls.length = 0;
    ollamaRequests.length = 0;
    scriptedOllama = [
      {
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              function: {
                name: "product_update",
                arguments: { slug: "tohar-hamidbar-concentrate", priceEgp: "250" },
              },
            },
          ],
        },
      },
    ];
    await sendText(OWNER_CHAT, "set tohar price to 250 EGP");
    const coercedId = lastKeyboardPendingId();
    const coercedPrompt = lastTelegramText();
    check(
      "model's string '250' price → coerced, parked, summary shows 250 EGP",
      coercedId !== null && /price 250 EGP/.test(coercedPrompt),
      coercedPrompt.slice(0, 160)
    );
    if (coercedId) await tapButton(OWNER_CHAT, `cancel:${coercedId}`);

    // (b) Genuinely invalid arg: REFUSED goes back to the model as a tool
    // result and it gets a retry round — Victoria sees the model's
    // self-correction, not an immediate refusal ending the loop.
    telegramCalls.length = 0;
    ollamaRequests.length = 0;
    scriptedOllama = [
      {
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              function: {
                name: "product_update",
                arguments: { slug: "tohar-hamidbar-concentrate", quantity: "lots" },
              },
            },
          ],
        },
      },
      {
        message: {
          role: "assistant",
          content: "Quantity needs to be a number — how many units should I set?",
        },
      },
    ];
    await sendText(OWNER_CHAT, "set tohar quantity to lots");
    const retryReply = lastTelegramText();
    check(
      "invalid arg → REFUSED fed back to the model as a tool result (retry round granted)",
      ollamaRequests.length === 2 &&
        ollamaRequests[1].messages.some(
          (m) => m.role === "tool" && /REFUSED/.test(m.content)
        ),
      `ollama calls=${ollamaRequests.length}`
    );
    check(
      "user sees the model's self-correction, not an immediate refusal",
      /how many units/i.test(retryReply) &&
        !/I can't do that as asked/.test(retryReply),
      retryReply.slice(0, 160)
    );
    check(
      "nothing parked for the invalid call",
      lastKeyboardPendingId() === null
    );
    scriptedOllama = null;
  }

  console.log("\n=== 16. Telegram update_id dedupe (redelivery protection) ===");
  {
    telegramCalls.length = 0;
    const dupUpdate = {
      update_id: 987_654_321,
      message: {
        message_id: messageId++,
        chat: { id: STRANGER2_CHAT, type: "private" },
        from: { id: STRANGER2_CHAT, first_name: "Dup" },
        text: "duplicate delivery test",
      },
    };
    const first = await webhookPOST(tgRequest(dupUpdate) as never);
    const refusalsAfterFirst = messagesTo(STRANGER2_CHAT, REFUSAL_RE).length;
    const second = await webhookPOST(tgRequest(dupUpdate) as never);
    const secondJson = (await second.json()) as { deduped?: boolean };
    check(
      "first delivery handled normally",
      first.status === 200 && refusalsAfterFirst === 1
    );
    check(
      "redelivered update_id skipped (no second reply)",
      second.status === 200 &&
        secondJson.deduped === true &&
        messagesTo(STRANGER2_CHAT, REFUSAL_RE).length === 1,
      JSON.stringify(secondJson)
    );
  }
  console.log("\n=== 17. Cal webhook → instant booking-request push (one-tap actions) ===");
  {
    // (a) Signed BOOKING_REQUESTED → owner push with [Confirm | Decline].
    telegramCalls.length = 0;
    calMutations.length = 0;
    const requestPayload = (uid: string) => ({
      triggerEvent: "BOOKING_REQUESTED",
      payload: {
        uid,
        eventTitle: "Relaxing Massage",
        title: "Relaxing Massage between Анна Тест and Victoria",
        status: "PENDING",
        startTime: "2027-04-10T12:00:00.000Z",
        endTime: "2027-04-10T13:00:00.000Z",
        attendees: [
          {
            name: "Анна Тест",
            email: "anna@example.com",
            timeZone: "Africa/Cairo",
            phoneNumber: "+201001234567",
          },
        ],
        metadata: { lang: "en" },
      },
    });
    const res = await calWebhookPOST(calRequest(requestPayload("harness-push-uid-1")) as never);
    check("BOOKING_REQUESTED webhook answers 200", res.status === 200);

    const pushes = messagesTo(OWNER_CHAT, /New booking request/);
    check("booking-request push captured", pushes.length === 1);
    const pushText = String((pushes[0]?.body as { text?: string } | undefined)?.text ?? "");
    console.log("--- booking push ---\n" + pushText);
    check(
      "push text carries name, treatment, Cairo datetime, phone",
      pushText.includes("Анна Тест") &&
        pushText.includes("Relaxing Massage") &&
        /2027/.test(pushText) &&
        pushText.includes("+201001234567"),
      pushText.slice(0, 200)
    );
    const row = keyboardRow(pushes[0]);
    check(
      "two buttons (Confirm/Decline) with valid pending-action callback data",
      row.length === 2 &&
        /Confirm/.test(row[0]?.text ?? "") &&
        /Decline/.test(row[1]?.text ?? "") &&
        CONFIRM_BTN_RE.test(row[0]?.callback_data ?? "") &&
        CONFIRM_BTN_RE.test(row[1]?.callback_data ?? ""),
      JSON.stringify(row)
    );
    check("no Cal mutation before any tap", calMutations.length === 0);

    // Pushed pendings carry the LONG ttl: the 15-min chat default would kill
    // a notification button before Victoria even sees it. They also cross-
    // link as siblings so the first winning tap retires the other button.
    const confirmId = (row[0]?.callback_data ?? "").replace(/^confirm:/, "");
    const declineId = (row[1]?.callback_data ?? "").replace(/^confirm:/, "");
    const pendingRaw = confirmId
      ? await readBlobText(`telegram/pending/${confirmId}.json`)
      : null;
    const pendingParsed = pendingRaw
      ? (JSON.parse(pendingRaw) as {
          tool?: string;
          args?: { uid?: string };
          ttlMs?: number;
          summary?: string;
          siblingId?: string;
        })
      : null;
    check(
      "Confirm button parks booking_confirm(uid) with 7-day ttlMs + disclosure summary",
      pendingParsed?.tool === "booking_confirm" &&
        pendingParsed?.args?.uid === "harness-push-uid-1" &&
        pendingParsed?.ttlMs === 7 * 24 * 60 * 60 * 1000 &&
        /booking-confirmation email/i.test(pendingParsed?.summary ?? ""),
      JSON.stringify(pendingParsed).slice(0, 240)
    );
    check(
      "Confirm pending cross-links the Decline pending as its sibling",
      Boolean(declineId) && pendingParsed?.siblingId === declineId,
      `siblingId=${pendingParsed?.siblingId} declineId=${declineId}`
    );

    // (b) Tap Confirm → the EXISTING executor path runs booking_confirm.
    telegramCalls.length = 0;
    if (row[0]) await tapButton(OWNER_CHAT, row[0].callback_data);
    check(
      "Confirm tap → confirmBooking(harness-push-uid-1) via the existing executor",
      calMutations.some((c) => c.url.includes("/bookings/harness-push-uid-1/confirm")),
      calMutations.map((c) => c.url).join(", ")
    );
    const edited = telegramCalls.find((c) => c.url.includes("editMessageText"));
    check(
      "notification message edited with summary + result",
      Boolean(edited && /done/.test(String((edited.body as { text?: string })?.text))),
      String((edited?.body as { text?: string })?.text).slice(0, 160)
    );
    // Sibling mutual exclusion: winning the Confirm claim discarded the
    // Decline pending, so a later Decline tap can NEVER execute — even when
    // the best-effort editMessageText above had failed.
    const siblingTake = declineId ? await takePendingAction(declineId) : null;
    check(
      "winning Confirm discards the sibling Decline (take → not-found)",
      siblingTake !== null && !siblingTake.ok && siblingTake.reason === "not-found",
      JSON.stringify(siblingTake)
    );

    // (c) Decline button on a second request → declineBooking + canned reason.
    telegramCalls.length = 0;
    calMutations.length = 0;
    await calWebhookPOST(calRequest(requestPayload("harness-push-uid-2")) as never);
    const row2 = keyboardRow(messagesTo(OWNER_CHAT, /New booking request/)[0]);
    telegramCalls.length = 0;
    if (row2[1]) await tapButton(OWNER_CHAT, row2[1].callback_data);
    const declineCall = calMutations.find((c) =>
      c.url.includes("/bookings/harness-push-uid-2/decline")
    );
    check(
      "Decline tap → declineBooking with the canned schedule-conflict reason",
      Boolean(declineCall && /Schedule conflict/.test(JSON.stringify(declineCall.body))),
      JSON.stringify(declineCall?.body ?? calMutations.map((c) => c.url)).slice(0, 200)
    );
    // …and symmetrically, the winning Decline discarded its Confirm sibling.
    const confirm2Id = (row2[0]?.callback_data ?? "").replace(/^confirm:/, "");
    const confirm2Take = confirm2Id ? await takePendingAction(confirm2Id) : null;
    check(
      "winning Decline discards the sibling Confirm (take → not-found)",
      confirm2Take !== null && !confirm2Take.ok && confirm2Take.reason === "not-found",
      JSON.stringify(confirm2Take)
    );

    // (d) BOOKING_CANCELLED → informational push, NO buttons.
    telegramCalls.length = 0;
    await calWebhookPOST(
      calRequest({
        triggerEvent: "BOOKING_CANCELLED",
        payload: {
          ...requestPayload("harness-push-uid-3").payload,
          status: "CANCELLED",
          cancellationReason: "plans changed",
        },
      }) as never
    );
    const cancelledPush = messagesTo(OWNER_CHAT, /cancelled Relaxing Massage/)[0];
    check(
      "BOOKING_CANCELLED → informational push (name+date+reason), no buttons",
      Boolean(cancelledPush) &&
        /Анна Тест/.test(String((cancelledPush?.body as { text?: string })?.text)) &&
        /plans changed/.test(String((cancelledPush?.body as { text?: string })?.text)) &&
        (cancelledPush?.body as CapturedKeyboard)?.reply_markup === undefined,
      JSON.stringify(cancelledPush?.body).slice(0, 220)
    );

    // (e) Per-action TTL honoured on the take path: a 1-hour-old pushed
    // action (7-day ttl) is still claimable; a 1-hour-old default-ttl action
    // is expired.
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const agedPending = (id: string, ttlMs?: number) =>
      put(
        `telegram/pending/${id}.json`,
        JSON.stringify({
          id,
          chatId: OWNER_CHAT,
          tool: "booking_confirm",
          args: { uid: "aged-uid" },
          summary: "aged harness pending",
          createdAt: hourAgo,
          ...(ttlMs ? { ttlMs } : {}),
        }),
        {
          access: "private",
          contentType: "application/json",
          addRandomSuffix: false,
          allowOverwrite: true,
        }
      );
    const agedLongId = crypto.randomUUID();
    await agedPending(agedLongId, 7 * 24 * 60 * 60 * 1000);
    const tookLong = await takePendingAction(agedLongId);
    check("1-hour-old pending with 7-day ttl → still claimable", tookLong.ok === true);
    const agedDefaultId = crypto.randomUUID();
    await agedPending(agedDefaultId);
    const tookDefault = await takePendingAction(agedDefaultId);
    check(
      "1-hour-old pending with default ttl → expired",
      !tookDefault.ok && tookDefault.reason === "expired",
      JSON.stringify(tookDefault)
    );

    // (f) pushSafe hardening: C1 controls (NEL), line/paragraph separators
    // and bidi controls in client-controlled fields are stripped before the
    // push text — an RTL override could visually reverse a phone number or
    // relabel a field, and NEL/LS/PS forge lines just like \n.
    telegramCalls.length = 0;
    await calWebhookPOST(
      calRequest({
        triggerEvent: "BOOKING_REQUESTED",
        payload: {
          ...requestPayload("harness-push-uid-5").payload,
          attendees: [
            {
              name: "Ev\u202Eil\u2066Bidi\u2069\u0085Name\u2028X\u009fY",
              email: "bidi@example.com",
              timeZone: "Africa/Cairo",
              phoneNumber: "+201001234567",
            },
          ],
        },
      }) as never
    );
    const bidiPush = messagesTo(OWNER_CHAT, /New booking request/)[0];
    const bidiText = String(
      (bidiPush?.body as { text?: string } | undefined)?.text ?? ""
    );
    check(
      "push strips C1 controls, line/para separators and bidi controls from client text",
      Boolean(bidiPush) &&
        !/[\u0080-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(bidiText) &&
        bidiText.includes("Ev il") && // stripped chars collapse to a space
        bidiText.includes("Bidi") &&
        bidiText.includes("Name") &&
        bidiText.includes("X Y"),
      JSON.stringify(bidiText).slice(0, 220)
    );
  }

  console.log("\n=== 18. Order route → order push + low-stock alert (REAL blob, byte-restored) ===");
  {
    const catalogBytes = await readBlobText("catalog/products.json");
    check("catalog blob present for byte restore", catalogBytes !== null);
    const testOrderNumbers: string[] = [];
    try {
      // Craft stock so a 1-unit order CROSSES the low-stock threshold: 4 → 3.
      const crafted = await getCatalog();
      const tohar = crafted.find((p) => p.slug === "tohar-hamidbar-concentrate");
      if (tohar) {
        tohar.quantity = 4;
        tohar.soldOut = false;
      }
      await saveCatalog(crafted);

      telegramCalls.length = 0;
      const res = await orderPOST(
        orderRequest({
          items: [{ slug: "tohar-hamidbar-concentrate", qty: 1 }],
          name: "Push Harness",
          phone: "+201001112233",
          address: "1 Test Street, Hurghada",
          lang: "en",
        }) as never
      );
      const json = (await res.json()) as { received?: boolean; orderNumber?: string };
      const orderNumber = json.orderNumber ?? "";
      if (orderNumber) testOrderNumbers.push(orderNumber);
      check(
        "order accepted (received + orderNumber)",
        res.status === 200 && json.received === true && orderNumber !== "",
        JSON.stringify(json).slice(0, 160)
      );

      const orderPush = messagesTo(OWNER_CHAT, /New order/)[0];
      const orderText = String((orderPush?.body as { text?: string } | undefined)?.text ?? "");
      console.log("--- order push ---\n" + orderText);
      check(
        "order push carries number, name, total, item list, phone",
        orderText.includes(orderNumber) &&
          orderText.includes("Push Harness") &&
          /\d+ EGP/.test(orderText) &&
          /1× /.test(orderText) &&
          orderText.includes("+201001112233"),
        orderText.slice(0, 220)
      );
      const orderRow = keyboardRow(orderPush);
      check(
        "order buttons: Mark confirmed / Cancel order with valid pending ids",
        orderRow.length === 2 &&
          /confirmed/i.test(orderRow[0]?.text ?? "") &&
          /Cancel/.test(orderRow[1]?.text ?? "") &&
          CONFIRM_BTN_RE.test(orderRow[0]?.callback_data ?? "") &&
          CONFIRM_BTN_RE.test(orderRow[1]?.callback_data ?? ""),
        JSON.stringify(orderRow)
      );

      const lowPush = messagesTo(OWNER_CHAT, /down to 3 left/)[0];
      const lowRow = keyboardRow(lowPush);
      console.log("--- low-stock push ---\n" + String((lowPush?.body as { text?: string })?.text));
      check(
        "low-stock alert (4 → 3) with one-tap Mark-sold-out button",
        Boolean(lowPush) &&
          lowRow.length === 1 &&
          /sold out/i.test(lowRow[0]?.text ?? "") &&
          CONFIRM_BTN_RE.test(lowRow[0]?.callback_data ?? ""),
        JSON.stringify(lowRow)
      );

      // Tap [Mark confirmed] → REAL order advances ordered → confirmed via
      // the existing executor (status email no-ops: RESEND blank, no buyer email).
      telegramCalls.length = 0;
      if (orderRow[0]) await tapButton(OWNER_CHAT, orderRow[0].callback_data);
      const confirmedOrder = orderNumber ? await getOrder(orderNumber) : null;
      check(
        "Mark-confirmed tap → REAL order status = confirmed",
        confirmedOrder?.status === "confirmed",
        `status=${confirmedOrder?.status}`
      );
      // Sibling mutual exclusion on the order pair: Mark-confirmed winning
      // its claim discarded [Cancel order] — a day-3 Cancel tap can no
      // longer cancel (and restock) an order that may already have shipped.
      const cancelOrderId = (orderRow[1]?.callback_data ?? "").replace(/^confirm:/, "");
      const cancelTake = cancelOrderId ? await takePendingAction(cancelOrderId) : null;
      check(
        "Mark-confirmed discards the sibling Cancel-order pending (take → not-found)",
        cancelTake !== null && !cancelTake.ok && cancelTake.reason === "not-found",
        JSON.stringify(cancelTake)
      );

      // Tap [Mark sold out] → REAL catalog flips soldOut: true.
      telegramCalls.length = 0;
      if (lowRow[0]) await tapButton(OWNER_CHAT, lowRow[0].callback_data);
      const afterTap = await getCatalog();
      check(
        "sold-out tap → tohar soldOut=true in the REAL catalog",
        afterTap.find((p) => p.slug === "tohar-hamidbar-concentrate")?.soldOut === true
      );

      // Quantity hitting 0 → informational push only (auto sold-out), no
      // button, and no duplicate "down to N" alert (1 is not a crossing).
      const crafted2 = await getCatalog();
      const tohar2 = crafted2.find((p) => p.slug === "tohar-hamidbar-concentrate");
      if (tohar2) {
        tohar2.quantity = 1;
        tohar2.soldOut = false;
      }
      await saveCatalog(crafted2);
      telegramCalls.length = 0;
      const zeroRes = await orderPOST(
        orderRequest({
          items: [{ slug: "tohar-hamidbar-concentrate", qty: 1 }],
          name: "Push Harness Zero",
          phone: "+201001112233",
          address: "1 Test Street, Hurghada",
          lang: "en",
        }) as never
      );
      const zeroJson = (await zeroRes.json()) as { orderNumber?: string };
      if (zeroJson.orderNumber) testOrderNumbers.push(zeroJson.orderNumber);
      const zeroPush = messagesTo(OWNER_CHAT, /hit 0 in stock/)[0];
      check(
        "stock hitting 0 → informational auto-sold-out push without buttons",
        Boolean(zeroPush) &&
          (zeroPush?.body as CapturedKeyboard)?.reply_markup === undefined,
        JSON.stringify(zeroPush?.body).slice(0, 200)
      );
      check(
        "no low-stock button alert on the 1 → 0 order (not a threshold crossing)",
        messagesTo(OWNER_CHAT, /down to \d+ left/).length === 0
      );
    } finally {
      // DELETE the test order blobs and restore the catalog bytes.
      for (const num of testOrderNumbers) {
        try {
          await del(`orders/${num}.json`);
          console.log("deleted test order", num);
        } catch {
          // best effort
        }
      }
      if (catalogBytes !== null) {
        await restoreBlobText("catalog/products.json", catalogBytes, "application/json");
      }
      check(
        "catalog byte-identical after section 18",
        (await readBlobText("catalog/products.json")) === catalogBytes,
        `len ${catalogBytes?.length}`
      );
      check(
        "test order blobs deleted",
        (await listOrders({ limit: 50 })).every(
          (o) => !testOrderNumbers.includes(o.orderNumber)
        )
      );
    }
  }

  console.log("\n=== 19. No bound owner → zero pushes, flows still succeed (seam, owner.json untouched) ===");
  {
    // The no-owner branch used to be exercised by DELETING the real
    // telegram/owner.json — a SIGKILL inside that window would have left
    // one-time owner binding REOPENED (a takeover vector) with no cleanup
    // able to run. Instead, the undici-dispatcher seam answers 404 for
    // owner.json READS only (the SDK maps a true 404 to null = "unbound")
    // while the real blob never leaves the store.
    const catalogBytes = await readBlobText("catalog/products.json");
    const ownerBytesBefore = await readBlobText("telegram/owner.json");
    check(
      "owner binding present before the no-owner simulation",
      ownerBytesBefore !== null
    );
    let orphanOrder = "";
    try {
      blobOwner404Mock.activate();
      check(
        "seam active: getOwnerChatId() reports unbound (owner.json untouched)",
        (await getOwnerChatId()) === null
      );
      telegramCalls.length = 0;
      const calRes = await calWebhookPOST(
        calRequest({
          triggerEvent: "BOOKING_REQUESTED",
          payload: {
            uid: "harness-push-uid-4",
            eventTitle: "Relaxing Massage",
            status: "PENDING",
            startTime: "2027-04-11T12:00:00.000Z",
            endTime: "2027-04-11T13:00:00.000Z",
            attendees: [{ name: "Анна Тест", email: "anna@example.com" }],
            metadata: { lang: "en" },
          },
        }) as never
      );
      check("booking webhook still 200 with no owner", calRes.status === 200);
      const orderRes = await orderPOST(
        orderRequest({
          items: [{ slug: "tohar-hamidbar-concentrate", qty: 1 }],
          name: "Push Harness NoOwner",
          phone: "+201001112233",
          address: "1 Test Street, Hurghada",
          lang: "en",
        }) as never
      );
      const orderJson = (await orderRes.json()) as {
        received?: boolean;
        orderNumber?: string;
      };
      orphanOrder = orderJson.orderNumber ?? "";
      check(
        "order still succeeds with no owner",
        orderRes.status === 200 && orderJson.received === true,
        JSON.stringify(orderJson).slice(0, 140)
      );
      check(
        "zero Telegram calls with no owner bound",
        telegramCalls.length === 0,
        `calls=${telegramCalls.length}`
      );
    } finally {
      blobOwner404Mock.deactivate();
      if (orphanOrder) {
        try {
          await del(`orders/${orphanOrder}.json`);
          console.log("deleted test order", orphanOrder);
        } catch {
          // best effort
        }
      }
      if (catalogBytes !== null) {
        await restoreBlobText("catalog/products.json", catalogBytes, "application/json");
      }
      check(
        "owner.json byte-identical after the no-owner section (never deleted)",
        (await readBlobText("telegram/owner.json")) === ownerBytesBefore
      );
    }
  }

  console.log("\n=== 20. Report day-marker idempotency (claims pattern) ===");
  {
    // claimDailySend guards the digest/weekly routes against the residual
    // double-fire windows the Cairo-hour guard can't close (60-min-plus
    // Actions delays, prod workflow_dispatch). Synthetic job name + far-past
    // date keys so this can never collide with real markers; cleaned up
    // below AND by the final-cleanup prefix sweep.
    const JOB = "harness-idem";
    const day1 = "2000-01-01";
    const day2 = "2000-01-02";
    for (const d of [day1, day2]) {
      try {
        await del(`reports/sent/${JOB}/${d}.json`);
      } catch {
        // stale marker from a crashed previous run — fine
      }
    }
    const first = await claimDailySend(JOB, day1);
    const second = await claimDailySend(JOB, day1);
    const nextDay = await claimDailySend(JOB, day2);
    check('first firing claims the day marker → "claimed"', first === "claimed");
    check(
      'second firing, same Cairo day → REAL Blob conflict mapped to "already-sent" (quiet skip)',
      second === "already-sent",
      `second=${second}`
    );
    check('next day → fresh marker → "claimed"', nextDay === "claimed");
    check(
      'malformed marker keys → "error" (loud, never written, never a quiet skip)',
      (await claimDailySend("Bad/Job", day1)) === "error" &&
        (await claimDailySend(JOB, "2000-1-1")) === "error"
    );

    // Simulated Blob OUTAGE (undici seam): PUTs for this synthetic job
    // answer 500 service_unavailable — NOT a conflict — and must map to
    // "error" (route → HTTP 500, red Actions run), never to the quiet
    // "already-sent" skip that would silently lose the job for the day.
    // VERCEL_BLOB_RETRIES=0 keeps the SDK from retrying the 500 ten times.
    // NOTE: blob WRITES go to the API host (BLOB_API_ORIGIN, default
    // https://vercel.com/api/blob), NOT *.vercel-storage.com like reads —
    // the pathname rides in the ?pathname= query, hence the substring match.
    blobOwner404Mock
      .get(BLOB_API_ORIGIN)
      .intercept({
        path: (p: string) => p.includes("harness-outage"),
        method: "PUT",
      })
      .reply(
        500,
        JSON.stringify({
          error: { code: "service_unavailable", message: "harness simulated outage" },
        }),
        { headers: { "content-type": "application/json" } }
      )
      .persist();
    const savedRetries = process.env.VERCEL_BLOB_RETRIES;
    process.env.VERCEL_BLOB_RETRIES = "0";
    let outage = "";
    try {
      blobOwner404Mock.activate();
      outage = await claimDailySend("harness-outage", day1);
    } finally {
      blobOwner404Mock.deactivate();
      if (savedRetries === undefined) delete process.env.VERCEL_BLOB_RETRIES;
      else process.env.VERCEL_BLOB_RETRIES = savedRetries;
    }
    check(
      'simulated Blob outage during claim → "error" (never a silent skip)',
      outage === "error",
      `outage=${outage}`
    );
    for (const d of [day1, day2]) {
      try {
        await del(`reports/sent/${JOB}/${d}.json`);
      } catch {
        // best effort — final cleanup sweeps the prefix too
      }
    }

    // force=1 (non-production only) bypasses the marker ENTIRELY — it
    // neither checks nor claims — so repeated dev/harness test sends work
    // AND never suppress the real scheduled send. Proven against the real
    // weekly-report route: two forced calls both send (Resend mocked).
    const { GET: weeklyGET } = await import("../src/app/api/cron/weekly-report/route");
    const { cairoDateKey } = await import("../src/lib/daily-brief-email");
    const { NextRequest } = await import("next/server");
    const weeklyReq = () =>
      new NextRequest(
        "https://book.victoriaholisticbeauty.com/api/cron/weekly-report?force=1",
        { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }
      );
    // The real marker for today (Cairo date) may legitimately pre-exist
    // (e.g. harness running on a Sunday evening after the real send) —
    // assert the forced runs leave it EXACTLY as found, claimed or not.
    const realMarkerPath = `reports/sent/weekly-report/${cairoDateKey(new Date())}.json`;
    const realMarkerBefore = await readBlobText(realMarkerPath);
    resendCalls.length = 0;
    const w1 = (await (await weeklyGET(weeklyReq())).json()) as {
      ok?: boolean;
      skipped?: string;
    };
    const w2 = (await (await weeklyGET(weeklyReq())).json()) as {
      ok?: boolean;
      skipped?: string;
    };
    check(
      "force=1 bypasses the day marker (two forced weekly runs both send)",
      w1.ok === true && !w1.skipped && w2.ok === true && !w2.skipped,
      JSON.stringify({ w1: w1.skipped ?? "sent", w2: w2.skipped ?? "sent" })
    );

    // BOTH delivery channels failing must be LOUD: HTTP 500 with a
    // top-level error field (the workflows print {ok, skipped, error} and
    // fail on non-200). Email is already down (RESEND_API_KEY blanked →
    // sentCount 0); the owner-404 seam makes the Telegram push report
    // no-owner-bound — zero channels delivered.
    let bothFailedRes: Awaited<ReturnType<typeof weeklyGET>>;
    try {
      blobOwner404Mock.activate();
      bothFailedRes = await weeklyGET(weeklyReq());
    } finally {
      blobOwner404Mock.deactivate();
    }
    const bothFailedJson = (await bothFailedRes.json()) as {
      ok?: boolean;
      error?: string;
      telegram?: { sent?: boolean; reason?: string };
    };
    check(
      "email+telegram both failed → HTTP 500 with top-level error (Actions run goes red)",
      bothFailedRes.status === 500 &&
        bothFailedJson.ok === false &&
        typeof bothFailedJson.error === "string" &&
        bothFailedJson.error.length > 0 &&
        bothFailedJson.telegram?.sent === false,
      `status=${bothFailedRes.status} ${JSON.stringify(bothFailedJson).slice(0, 200)}`
    );

    check(
      "forced runs never claim the real weekly marker (untouched, claimed or not)",
      (await readBlobText(realMarkerPath)) === realMarkerBefore
    );
  }
} catch (error) {
  crashed = error;
} finally {
  // ====================================================================================
  console.log("\n=== cleanup: restore production Blob state (always runs) ===");

  // Working state created by the run — delete.
  for (const path of ["telegram/history.json", "telegram/alerts.json"]) {
    try {
      await del(path);
      console.log("deleted", path);
    } catch {
      // missing — fine
    }
  }

  // Pending actions + exactly-once claim markers created by the run — sweep.
  // reports/sent/harness-idem/ and reports/sent/harness-outage/ hold ONLY
  // this harness's synthetic day markers (section 20 — the outage marker
  // should never exist because its PUT is mocked to 500, swept anyway);
  // real job markers (evening-digest, weekly-report) live under their own
  // prefixes and are never touched.
  try {
    for (const prefix of [
      "telegram/pending/",
      "telegram/claims/",
      "reports/sent/harness-idem/",
      "reports/sent/harness-outage/",
    ]) {
      const { blobs } = await list({ prefix });
      for (const blob of blobs) {
        try {
          await del(blob.pathname);
        } catch {
          // best effort
        }
      }
      console.log(`swept ${blobs.length} blob(s) under ${prefix}`);
    }
  } catch (error) {
    console.log("pending/claims sweep failed:", error instanceof Error ? error.message : error);
  }

  // Owner binding + audit log: restore the EXACT pre-run bytes (or absence).
  try {
    await restoreBlobText("telegram/owner.json", ownerSnapshot, "application/json");
    check(
      "owner.json restored byte-identical to pre-run state",
      (await readBlobText("telegram/owner.json")) === ownerSnapshot
    );
  } catch (error) {
    check("owner.json restored byte-identical to pre-run state", false, String(error));
  }
  try {
    await restoreBlobText("telegram/audit.jsonl", auditSnapshot, "application/x-ndjson");
    check(
      "audit.jsonl restored byte-identical to pre-run state",
      (await readBlobText("telegram/audit.jsonl")) === auditSnapshot
    );
  } catch (error) {
    check("audit.jsonl restored byte-identical to pre-run state", false, String(error));
  }

  // Shop catalog: must end the run byte-identical. Sections 6 and 10 restore
  // themselves; this is the crash-safe backstop + the whole-run guarantee.
  try {
    const productsNow = await readBlobText("catalog/products.json");
    if (productsNow !== productsSnapshot) {
      console.log("products.json drifted — restoring run-start bytes");
      await restoreBlobText("catalog/products.json", productsSnapshot, "application/json");
    }
    check(
      "products.json byte-identical across the whole run",
      (await readBlobText("catalog/products.json")) === productsSnapshot,
      `snapshot ${productsSnapshot?.length ?? "absent"} bytes`
    );
  } catch (error) {
    check("products.json byte-identical across the whole run", false, String(error));
  }
}

if (crashed) {
  console.error("\nHARNESS CRASHED MID-RUN (state was still restored):", crashed);
  failures++;
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
