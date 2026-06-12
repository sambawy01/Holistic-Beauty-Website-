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
  retirePendingAction,
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
 *    telegram/owner.json is manually deleted from Blob. Once an owner is
 *    bound, every other chat gets the same generic "private assistant"
 *    refusal (never revealing whether an owner exists). The ONLY exception
 *    is the pre-binding window: while NO owner exists, a BARE `/start` (no
 *    access-phrase token, and only when ADMIN_PASS is configured) gets a
 *    gentle nudge toward the access-phrase form (no password or closeness is
 *    ever revealed). A present-but-wrong phrase still gets the generic wall —
 *    a guesser learns nothing — and this whole branch is unreachable once bound.
 *    Either way the attempt is appended to
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
export const maxDuration = 90;

/**
 * Absolute deadline for one update's processing, derived from maxDuration
 * with a safety margin. Threaded into runAgent so the agent loop stops
 * calling the model (and replies "taking too long") instead of being killed
 * mid-run — a killed invocation answers no 2xx and Telegram redelivers.
 */
const DEADLINE_MARGIN_MS = 10_000;

// --- update_id dedupe (best effort, in-memory) ---------------------------------
// Telegram redelivers an update whenever it saw no 2xx (e.g. a timed-out
// invocation). Remember recently seen update_ids per instance and skip
// repeats — best effort by design: a fresh instance starts empty, and the
// confirmation gate + atomic pending-action claim remain the real
// exactly-once guarantees for anything mutating.

const RECENT_UPDATE_TTL_MS = 15 * 60 * 1000;
const RECENT_UPDATE_MAX = 1000;
const recentUpdateIds = new Map<number, number>(); // update_id → first-seen ms

function alreadySeenUpdate(updateId: number): boolean {
  const now = Date.now();
  if (recentUpdateIds.has(updateId)) return true;
  recentUpdateIds.set(updateId, now);
  if (recentUpdateIds.size > RECENT_UPDATE_MAX) {
    for (const [id, seenAt] of recentUpdateIds) {
      if (
        now - seenAt > RECENT_UPDATE_TTL_MS ||
        recentUpdateIds.size > RECENT_UPDATE_MAX
      ) {
        recentUpdateIds.delete(id);
      } else {
        break; // Map iterates in insertion order — the rest are newer.
      }
    }
  }
  return false;
}

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

// Shown ONLY in the pre-binding window (no owner bound yet) for a BARE `/start`
// with no access-phrase token — a legitimate Victoria who simply doesn't know
// the `/start <phrase>` form. A present-but-wrong phrase gets the generic
// REFUSAL instead (a guesser must learn nothing). Safe here because there is no
// owner to protect: it reveals no password and confirms no closeness. The
// instant an owner IS bound, this branch is unreachable and every chat gets
// REFUSAL.
const UNBOUND_START_NUDGE =
  "Hi — I'm Vassili, Victoria's assistant. If you're Victoria, start me with your access phrase like this:\n" +
  "/start <your access phrase>";

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

const OWNER_READ_ERROR =
  "Sorry — something went wrong on my side. Please try again in a minute.";

async function handleMessage(
  message: TgMessage,
  deadlineAt: number
): Promise<void> {
  const chatId = message.chat.id;
  const from = message.from;
  const text = (message.text ?? "").trim();

  // FAIL CLOSED on a corrupt/unreadable owner record: getOwnerChatId throws
  // for anything except a true 404. Treating that as "unbound" would reopen
  // one-time owner binding to the next /start — a takeover vector.
  let owner: number | null;
  try {
    owner = await getOwnerChatId();
  } catch (error) {
    console.error("[telegram] Owner record unreadable — failing closed:", error);
    await sendMessage(chatId, OWNER_READ_ERROR);
    return;
  }

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
      // An owner IS bound: every other chat gets the UNCHANGED generic wall —
      // never reveal whether an owner exists or that the password was correct.
      await sendMessage(chatId, REFUSAL);
    } else if (pass.length === 0 && adminPass.length > 0) {
      // No owner bound yet AND a BARE `/start` (no access-phrase token) while
      // binding is actually possible (ADMIN_PASS configured): almost certainly
      // Victoria not knowing the `/start <phrase>` form, so nudge her toward
      // it. The nudge never echoes input and never confirms closeness.
      // Unreachable once bound (the REFUSAL branch above takes over).
      await sendMessage(chatId, UNBOUND_START_NUDGE);
    } else {
      // A present-but-wrong access phrase (a guesser probing), OR a
      // misconfigured/empty ADMIN_PASS where nothing can bind: fail closed to
      // the SAME generic wall everyone else gets — reveal nothing, hint nothing.
      await sendMessage(chatId, REFUSAL);
    }
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

  const outcome = await runAgent(text, { chatId }, { deadlineAt });
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

  // FAIL CLOSED on a corrupt/unreadable owner record (see handleMessage).
  let owner: number | null;
  try {
    owner = await getOwnerChatId();
  } catch (error) {
    console.error("[telegram] Owner record unreadable — failing closed:", error);
    await answerCallbackQuery(cb.id, "Something went wrong — please try again.");
    return;
  }
  const presser = cb.from?.id;

  // The OWNER tapping a button on a stale/inaccessible message (Telegram
  // omits cb.message after ~48h or when the message is unreachable): there
  // is no intruder here — answer quietly, never alert Victoria about
  // herself. The pending action behind it expired long ago anyway.
  if (owner !== null && presser === owner && chatId === undefined) {
    await answerCallbackQuery(
      cb.id,
      "That button has expired — please ask me again."
    );
    return;
  }

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
    // discardPendingAction goes through the same atomic claim as Confirm:
    // false means another tap (Confirm or Cancel) already won — never tell
    // Victoria "nothing was changed" when a racing Confirm executed.
    const discarded = await discardPendingAction(pendingId);
    if (!discarded) {
      await answerCallbackQuery(cb.id);
      if (messageId !== undefined) {
        await editMessageText(
          chatId,
          messageId,
          "This action is no longer available (already executed or cancelled)."
        );
      }
      return;
    }
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
        ? "⏳ That confirmation expired — please ask me again."
        : "This action is no longer available (already executed or cancelled).";
    await answerCallbackQuery(cb.id);
    if (messageId !== undefined) await editMessageText(chatId, messageId, why);
    return;
  }

  // Paired pushed buttons (Confirm/Decline on one notification): the claim
  // is won — retire the sibling pending NOW, before executing. The
  // editMessageText below also removes both buttons, but it is best effort
  // and unreliable for aged messages; without this, a day-3 tap on the
  // other button would still execute (e.g. cancelling a shipped order).
  // retirePendingAction (NOT discardPendingAction): it writes the claim
  // marker unconditionally, with no existence read a transient Blob failure
  // could short-circuit into leaving the sibling button live for days.
  if (taken.action.siblingId) {
    await retirePendingAction(taken.action.siblingId);
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

  // Skip redelivered updates (best effort — see alreadySeenUpdate). Must be
  // checked BEFORE processing: redelivery happens precisely because a slow
  // first run produced no 2xx in time.
  if (
    typeof update.update_id === "number" &&
    alreadySeenUpdate(update.update_id)
  ) {
    return ok({ deduped: true });
  }

  const deadlineAt = Date.now() + maxDuration * 1000 - DEADLINE_MARGIN_MS;

  try {
    if (update.callback_query) {
      await handleCallback(update.callback_query);
    } else if (update.message) {
      await handleMessage(update.message, deadlineAt);
    }
  } catch (error) {
    // Never bubble a 5xx to Telegram — it would redeliver the update forever.
    console.error("[telegram] Update handling failed:", error);
  }

  return ok();
}
