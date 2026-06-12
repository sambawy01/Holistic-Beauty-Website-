/**
 * Minimal Telegram Bot API client for Vassili (Victoria's assistant).
 *
 * - Token from env TELEGRAM_BOT_TOKEN. When unset, `telegramConfigured()`
 *   is false and callers must no-op (the webhook route answers 501).
 * - All replies are PLAIN TEXT (no parse_mode): Telegram's Markdown parser
 *   rejects unbalanced entities with a 400, and model output is not
 *   guaranteed to be balanced. Plain text can never bounce.
 * - `sendMessage` chunks at the 4096-char API limit.
 * - `sendDocument` uses multipart/form-data (FormData + Blob are global in
 *   the Node runtimes Next.js supports).
 *
 * Failure model: every call returns `{ ok, ... }` from Telegram or throws on
 * transport errors — callers decide what is fatal. The webhook route treats
 * nothing as fatal (it always answers 200 so Telegram never redelivers).
 */

const API_BASE = "https://api.telegram.org";

/** Telegram hard limit on message text length. */
const MAX_MESSAGE_CHARS = 4096;

export function telegramConfigured(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN);
}

function botUrl(method: string): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  }
  return `${API_BASE}/bot${token}/${method}`;
}

export interface TelegramResult {
  ok: boolean;
  status: number;
  /** Raw `result` from Telegram on success (e.g. the sent Message). */
  result?: unknown;
  description?: string;
}

async function callTelegram(
  method: string,
  payload: Record<string, unknown>
): Promise<TelegramResult> {
  const res = await fetch(botUrl(method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: unknown;
    description?: string;
  };
  if (!res.ok || !data.ok) {
    console.error(
      `[telegram] ${method} failed (${res.status}): ${String(data.description).slice(0, 300)}`
    );
  }
  return {
    ok: Boolean(data.ok),
    status: res.status,
    result: data.result,
    description: data.description,
  };
}

/** Inline keyboard markup (subset we use: one row of buttons). */
export interface InlineKeyboard {
  inline_keyboard: { text: string; callback_data: string }[][];
}

export function confirmCancelKeyboard(pendingId: string): InlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: "✅ Confirm", callback_data: `confirm:${pendingId}` },
        { text: "❌ Cancel", callback_data: `cancel:${pendingId}` },
      ],
    ],
  };
}

/** Split text into ≤4096-char chunks, preferring newline boundaries. */
function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > MAX_MESSAGE_CHARS) {
    let cut = rest.lastIndexOf("\n", MAX_MESSAGE_CHARS);
    if (cut < MAX_MESSAGE_CHARS / 2) cut = MAX_MESSAGE_CHARS;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.length > 0 || chunks.length === 0) chunks.push(rest);
  return chunks;
}

/**
 * Send a plain-text message. Long texts are chunked; the keyboard (when
 * given) is attached to the LAST chunk. Returns the result of the last send.
 */
export async function sendMessage(
  chatId: number,
  text: string,
  options: { replyMarkup?: InlineKeyboard } = {}
): Promise<TelegramResult> {
  const chunks = chunkText(text);
  let last: TelegramResult = { ok: false, status: 0 };
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    last = await callTelegram("sendMessage", {
      chat_id: chatId,
      text: chunks[i],
      ...(isLast && options.replyMarkup
        ? { reply_markup: options.replyMarkup }
        : {}),
    });
  }
  return last;
}

/** Edit a message's text (used to replace a confirm prompt with the result). */
export async function editMessageText(
  chatId: number,
  messageId: number,
  text: string
): Promise<TelegramResult> {
  return callTelegram("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: text.slice(0, MAX_MESSAGE_CHARS),
  });
}

/** Acknowledge a callback query (stops the button spinner). */
export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string
): Promise<TelegramResult> {
  return callTelegram("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text: text.slice(0, 200) } : {}),
  });
}

/** Send a document (PDF) as multipart/form-data. */
export async function sendDocument(
  chatId: number,
  filename: string,
  content: Buffer,
  options: { caption?: string; contentType?: string } = {}
): Promise<TelegramResult> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (options.caption) form.append("caption", options.caption.slice(0, 1024));
  form.append(
    "document",
    new Blob([new Uint8Array(content)], {
      type: options.contentType ?? "application/pdf",
    }),
    filename
  );
  const res = await fetch(botUrl("sendDocument"), {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: unknown;
    description?: string;
  };
  if (!res.ok || !data.ok) {
    console.error(
      `[telegram] sendDocument failed (${res.status}): ${String(data.description).slice(0, 300)}`
    );
  }
  return {
    ok: Boolean(data.ok),
    status: res.status,
    result: data.result,
    description: data.description,
  };
}
