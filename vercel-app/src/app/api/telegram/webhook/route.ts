import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  answerCallbackQuery,
  confirmCancelKeyboard,
  editMessageText,
  sendMessage,
  telegramConfigured,
} from "@/lib/telegram";
import { runAgent } from "@/lib/assistant/agent";
import { executeTool } from "@/lib/assistant/tools";
import {
  appendAudit,
  appendHistory,
  bindOwner,
  discardPendingAction,
  getOwnerChatId,
  shouldAlertOwner,
  takePendingAction,
  type IntrusionKind,
} from "@/lib/assistant/state";

/**
 * POST /api/telegram/webhook — Vassili, Victoria's Telegram assistant.
 *
 * Security model (three layers):
 * 1. Webhook authenticity: Telegram echoes the `secret_token` we register
 *    via setWebhook in the X-Telegram-Bot-Api-Secret-Token header. We
 *    require it to match TELEGRAM_WEBHOOK_SECRET (constant-time; fail
 *    closed when the env var is unset).
 * 2. Owner binding — ONE-TIME: the FIRST chat to send `/start <ADMIN_PASS>`
 *    is bound as the owner (Blob telegram/owner.json). Once bound, /start
 *    can NEVER rebind — not even with the correct password — until
 *    telegram/owner.json is manually deleted from Blob. Every other chat
 *    gets the same generic "private assistant" refusal (never revealing
 *    whether an owner exists), the attempt is appended to
 *    telegram/audit.jsonl, and the owner receives an intrusion alert
 *    (rate-limited per stranger; see shouldAlertOwner in state.ts).
 * 3. Confirmation gates: mutating tools never run off a chat message — they
 *    park as pending actions and execute only from the [Confirm] button
 *    (callback_query), with a 15-minute expiry and exactly-once semantics.
 *
 * Response discipline: once authenticated, ALWAYS answer 200 — Telegram
 * redelivers non-2xx updates and a crash loop would spam Victoria. All real
 * replies go out-of-band via sendMessage/editMessageText.
 *
 * When TELEGRAM_BOT_TOKEN is not configured the route answers 501 and does
 * nothing — the feature is dormant until the bot exists.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// --- Telegram update types (the subset we consume) ----------------------------

interface TgChat {
  id: number;
  type?: string;
}

interface TgUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TgMessage {
  message_id: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
}

interface TgCallbackQuery {
  id: string;
  data?: string;
  from?: TgUser;
  message?: TgMessage;
}

interface TgUpdate {
  update_id?: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

// --- helpers ----------------------------------------------------------------------

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

const REFUSAL =
  "Hi! I'm Vassili — Victoria's private assistant, so this chat is members-only. " +
  "For bookings and skincare advice, visit victoriaholisticbeauty.com — I'll happily help you there.";

const BOUND_GREETING =
  "Bound and ready! 🤝 I'm Vassili, your ops assistant.\n\n" +
  "Ask me things like:\n" +
  "— what's my day?\n" +
  "— any pending bookings?\n" +
  "— set tohar quantity to 15\n" +
  "— make me an offer document for…\n\n" +
  "Anything that changes data will ask for your confirmation first.";

const ALREADY_CONNECTED =
  "You're already connected — I'm right here. 🤝\n" +
  "Ask me anything: \"what's my day?\", \"any pending bookings?\"…";

function ok(extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ ok: true, ...extra });
}

// --- intrusion handling -------------------------------------------------------

/** Audit detail for the sender of an update (never trust, always record). */
function senderDetail(from?: TgUser): Record<string, unknown> {
  return {
    userId: from?.id ?? null,
    username: from?.username ?? null,
    name:
      [from?.first_name, from?.last_name].filter(Boolean).join(" ") || null,
  };
}

function describeSender(chatId: number, from?: TgUser): string {
  const name = [from?.first_name, from?.last_name].filter(Boolean).join(" ");
  const parts = [`chat id ${chatId}`];
  if (name) parts.push(`name ${name}`);
  if (from?.username) parts.push(`@${from.username}`);
  return parts.join(", ");
}

/**
 * Best-effort alert to the bound owner about an unauthorized access attempt.
 * Rate-limited per stranger (see shouldAlertOwner). Never throws and never
 * changes what the stranger sees — they always get only the generic refusal.
 */
async function alertOwnerOfIntrusion(
  owner: number,
  strangerChatId: number,
  from: TgUser | undefined,
  kind: IntrusionKind,
  attempted: string
): Promise<void> {
  try {
    if (!(await shouldAlertOwner(strangerChatId, kind))) return;
    await sendMessage(
      owner,
      `⚠️ Someone tried to access Vassili — ${describeSender(strangerChatId, from)}, attempted: ${attempted}`
    );
  } catch (error) {
    console.error("[telegram] Intrusion alert failed:", error);
  }
}

// --- message handling ----------------------------------------------------------------

async function handleMessage(message: TgMessage): Promise<void> {
  const chatId = message.chat.id;
  const from = message.from;
  const text = (message.text ?? "").trim();
  const owner = await getOwnerChatId();

  // /start <pass> — ONE-TIME owner binding.
  // [\s\S] instead of the `s` flag — tsconfig targets pre-es2018.
  const startMatch = /^\/start(?:\s+([\s\S]+))?$/.exec(text);
  if (startMatch) {
    const pass = (startMatch[1] ?? "").trim();
    const adminPass = process.env.ADMIN_PASS ?? "";
    // Fail closed: an unset/empty ADMIN_PASS or an empty supplied pass can
    // never bind (safeEqual("", "") would be true — guard lengths first).
    const passOk =
      adminPass.length > 0 && pass.length > 0 && safeEqual(pass, adminPass);

    // The bound owner sending /start again: friendly and idempotent.
    if (owner !== null && chatId === owner) {
      await sendMessage(chatId, ALREADY_CONNECTED);
      return;
    }

    // First binding — only while no owner exists.
    if (owner === null && passOk) {
      await bindOwner(chatId);
      await appendAudit({ chatId, kind: "owner-bound", detail: senderDetail(from) });
      await sendMessage(chatId, BOUND_GREETING);
      return;
    }

    // Failed binding: wrong pass (any time), or correct pass after a binding
    // already exists (rebinding requires manually deleting telegram/owner.json).
    const kind: IntrusionKind =
      owner !== null && passOk ? "start-rebind-blocked" : "start-wrong-pass";
    await appendAudit({ chatId, kind, detail: senderDetail(from) });
    if (owner !== null) {
      await alertOwnerOfIntrusion(
        owner,
        chatId,
        from,
        kind,
        kind === "start-rebind-blocked"
          ? "/start with the CORRECT password (rebind blocked)"
          : "/start with a wrong password"
      );
    }
    // Generic refusal — never reveal whether an owner exists or that the
    // password was correct.
    await sendMessage(chatId, REFUSAL);
    return;
  }

  if (owner === null || chatId !== owner) {
    await appendAudit({
      chatId,
      kind: "unauthorized-message",
      detail: { ...senderDetail(from), text: text.slice(0, 200) },
    });
    if (owner !== null) {
      await alertOwnerOfIntrusion(
        owner,
        chatId,
        from,
        "unauthorized-message",
        text ? `message: "${text.slice(0, 80)}"` : "a non-text message"
      );
    }
    await sendMessage(chatId, REFUSAL);
    return;
  }

  if (!text) {
    await sendMessage(
      chatId,
      "I only read text for now — voice notes and photos go over my head. 🙈"
    );
    return;
  }

  const outcome = await runAgent(text, { chatId });
  if (outcome.kind === "confirm") {
    await sendMessage(chatId, outcome.text, {
      replyMarkup: confirmCancelKeyboard(outcome.pendingId),
    });
  } else {
    await sendMessage(chatId, outcome.text);
  }
}

// --- callback (confirm / cancel buttons) -----------------------------------------------

async function handleCallback(cb: TgCallbackQuery): Promise<void> {
  const chatId = cb.message?.chat.id;
  const messageId = cb.message?.message_id;
  const data = cb.data ?? "";

  const owner = await getOwnerChatId();
  const presser = cb.from?.id;
  // Both the chat holding the keyboard AND the user who pressed it must be
  // the bound owner. Telegram always sets `from` on callback_query — a
  // missing sender is malformed input and fails closed.
  if (
    chatId === undefined ||
    owner === null ||
    chatId !== owner ||
    presser !== owner
  ) {
    await appendAudit({
      chatId: chatId ?? presser ?? 0,
      kind: "unauthorized-callback",
      detail: { ...senderDetail(cb.from), data: data.slice(0, 100) },
    });
    if (owner !== null) {
      await alertOwnerOfIntrusion(
        owner,
        chatId ?? presser ?? 0,
        cb.from,
        "unauthorized-callback",
        "tapped a confirmation button"
      );
    }
    await answerCallbackQuery(cb.id, "This assistant is private.");
    return;
  }

  const match = /^(confirm|cancel):([0-9a-f-]{36})$/.exec(data);
  if (!match) {
    await answerCallbackQuery(cb.id);
    return;
  }
  const [, verb, pendingId] = match;

  if (verb === "cancel") {
    await discardPendingAction(pendingId);
    await appendAudit({
      chatId,
      kind: "pending-cancelled",
      detail: { id: pendingId },
    });
    await answerCallbackQuery(cb.id, "Cancelled.");
    if (messageId !== undefined) {
      await editMessageText(chatId, messageId, "❌ Cancelled — nothing was changed.");
    }
    return;
  }

  const taken = await takePendingAction(pendingId);
  if (!taken.ok) {
    const why =
      taken.reason === "expired"
        ? "⏳ That confirmation expired (15 min limit) — please ask me again."
        : "This action is no longer available (already executed or cancelled).";
    await answerCallbackQuery(cb.id);
    if (messageId !== undefined) await editMessageText(chatId, messageId, why);
    return;
  }

  await answerCallbackQuery(cb.id, "On it…");
  const result = await executeTool(taken.action.tool, taken.action.args, {
    chatId,
  });
  await appendAudit({
    chatId,
    kind: "pending-executed",
    detail: {
      id: pendingId,
      tool: taken.action.tool,
      args: taken.action.args,
      result: result.slice(0, 500),
    },
  });
  if (messageId !== undefined) {
    await editMessageText(
      chatId,
      messageId,
      `${taken.action.summary}\n\n${result}`
    );
  }
  // Keep conversation memory coherent: the model should know the outcome
  // when Victoria follows up with "did that work?".
  await appendHistory({
    role: "assistant",
    content: `Confirmed and executed: ${taken.action.summary}\nResult: ${result}`,
  });
}

// --- route -----------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  if (!telegramConfigured()) {
    return NextResponse.json(
      { error: "Telegram is not configured (TELEGRAM_BOT_TOKEN missing)" },
      { status: 501 }
    );
  }

  // Webhook authenticity — fail closed when the secret is unset.
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const header = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!secret || !safeEqual(header, secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let update: TgUpdate;
  try {
    update = (await request.json()) as TgUpdate;
  } catch {
    return ok({ ignored: "invalid-json" });
  }

  try {
    if (update.callback_query) {
      await handleCallback(update.callback_query);
    } else if (update.message) {
      await handleMessage(update.message);
    }
  } catch (error) {
    // Never bubble a 5xx to Telegram — it would redeliver the update forever.
    console.error("[telegram] Update handling failed:", error);
  }

  return ok();
}
