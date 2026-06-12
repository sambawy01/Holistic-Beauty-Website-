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
  takePendingAction,
} from "@/lib/assistant/state";

/**
 * POST /api/telegram/webhook — Vassili, Victoria's Telegram assistant.
 *
 * Security model (three layers):
 * 1. Webhook authenticity: Telegram echoes the `secret_token` we register
 *    via setWebhook in the X-Telegram-Bot-Api-Secret-Token header. We
 *    require it to match TELEGRAM_WEBHOOK_SECRET (constant-time; fail
 *    closed when the env var is unset).
 * 2. Owner binding: the FIRST chat to send `/start <ADMIN_PASS>` is bound
 *    as the owner (Blob telegram/owner.json). Every other chat gets a
 *    polite "private assistant" refusal. Re-binding requires the pass again.
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

interface TgMessage {
  message_id: number;
  chat: TgChat;
  text?: string;
}

interface TgCallbackQuery {
  id: string;
  data?: string;
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

function ok(extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ ok: true, ...extra });
}

// --- message handling ----------------------------------------------------------------

async function handleMessage(message: TgMessage): Promise<void> {
  const chatId = message.chat.id;
  const text = (message.text ?? "").trim();
  const owner = await getOwnerChatId();

  // /start <pass> — owner binding (also re-binding from a new device/chat).
  // [\s\S] instead of the `s` flag — tsconfig targets pre-es2018.
  const startMatch = /^\/start(?:\s+([\s\S]+))?$/.exec(text);
  if (startMatch) {
    const pass = (startMatch[1] ?? "").trim();
    const adminPass = process.env.ADMIN_PASS;
    if (adminPass && pass && safeEqual(pass, adminPass)) {
      await bindOwner(chatId);
      await appendAudit({ chatId, kind: "owner-bound", detail: {} });
      await sendMessage(chatId, BOUND_GREETING);
    } else {
      await sendMessage(chatId, REFUSAL);
    }
    return;
  }

  if (owner === null || chatId !== owner) {
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
  if (chatId === undefined || owner === null || chatId !== owner) {
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
