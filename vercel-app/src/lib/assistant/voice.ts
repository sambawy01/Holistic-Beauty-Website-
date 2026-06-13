/**
 * Voice-note transcription for Vassili — Groq Whisper.
 *
 * Victoria can send a Telegram voice note (OGG/Opus) instead of typing; the
 * webhook downloads the bytes and hands them here. We transcribe with Groq's
 * `whisper-large-v3-turbo` (OpenAI-compatible multipart endpoint) and feed the
 * transcript into the SAME text agent loop as a typed message — so a spoken
 * "confirm tomorrow's bookings and mark the Onmacabim order shipped" goes
 * through the identical confirm gate.
 *
 * - Language: AUTO (no language param) — Whisper detects EN vs RU itself, which
 *   is exactly Victoria's mix. Verified empirically against both.
 * - Degrades gracefully: with no GROQ_API_KEY (`voiceEnabled()` false) the
 *   webhook tells Victoria voice is unavailable instead of crashing. The key
 *   is already provisioned in Vercel prod env.
 * - Caps: oversize audio is rejected BEFORE the upload (a friendly message, not
 *   a timeout). Duration is capped in the webhook (Telegram reports it).
 */

/** Groq's OpenAI-compatible transcription endpoint. */
const GROQ_TRANSCRIBE_URL =
  "https://api.groq.com/openai/v1/audio/transcriptions";

/** The transcription model (confirmed available on this account). */
export const VOICE_MODEL = "whisper-large-v3-turbo";

/**
 * Hard cap on audio we'll upload (bytes). Telegram voice notes are tiny (Opus
 * ~1KB/s), so 20 MB is already minutes of speech; anything larger is rejected
 * with a clear message rather than risking a slow upload near the webhook
 * deadline. (Groq's own limit is higher; this is our conservative gate.)
 */
export const MAX_VOICE_BYTES = 20 * 1024 * 1024;

/**
 * Hard cap on voice-note DURATION (seconds), checked against Telegram's
 * reported duration before we ever download. Five minutes is generous for an
 * ops instruction and keeps transcription well inside the webhook budget.
 */
export const MAX_VOICE_SECONDS = 300;

/** Per-request upstream timeout for the Groq call. */
const TRANSCRIBE_TIMEOUT_MS = 30_000;

/**
 * Budget reserved for the agent loop AFTER transcription (ms). Transcription is
 * the last I/O before the agent runs, so we never let the Groq call extend past
 * `deadlineAt − this`, and fail fast below this floor — a SIGKILL at the
 * webhook's maxDuration would answer no 2xx and make Telegram redeliver.
 */
const TRANSCRIBE_DEADLINE_RESERVE_MS = 20_000;
/** Don't start the Groq call with less than this much time; fail fast instead. */
const MIN_TRANSCRIBE_TIMEOUT_MS = 3_000;

/** Is voice transcription usable right now? (Needs a Groq API key.) */
export function voiceEnabled(): boolean {
  return Boolean((process.env.GROQ_API_KEY || "").trim());
}

export type TranscriptionOutcome =
  | { ok: true; text: string }
  | {
      ok: false;
      reason: "disabled" | "too-large" | "empty" | "upstream" | "too-slow";
    };

/**
 * Transcribe voice-note bytes to text via Groq Whisper. Never throws — every
 * failure path returns a typed `{ ok:false, reason }` the webhook maps to a
 * friendly reply.
 */
export async function transcribeVoice(
  bytes: Buffer,
  options: { mime?: string; filename?: string; deadlineAt?: number } = {}
): Promise<TranscriptionOutcome> {
  const key = (process.env.GROQ_API_KEY || "").trim();
  if (!key) return { ok: false, reason: "disabled" };
  if (bytes.length === 0 || bytes.length > MAX_VOICE_BYTES) {
    return { ok: false, reason: "too-large" };
  }

  // Deadline-aware timeout: cap at min(default, remaining − reserve). If too
  // little of the webhook budget remains, fail fast ("too-slow") rather than
  // risk the maxDuration kill → Telegram redelivery.
  let timeoutMs = TRANSCRIBE_TIMEOUT_MS;
  if (options.deadlineAt !== undefined) {
    const budget =
      options.deadlineAt - Date.now() - TRANSCRIBE_DEADLINE_RESERVE_MS;
    if (budget < MIN_TRANSCRIBE_TIMEOUT_MS) return { ok: false, reason: "too-slow" };
    timeoutMs = Math.min(TRANSCRIBE_TIMEOUT_MS, budget);
  }

  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(bytes)], {
      type: options.mime || "audio/ogg",
    }),
    options.filename || "voice.ogg"
  );
  form.append("model", VOICE_MODEL);
  // JSON response, deterministic decoding. NO language param → auto-detect
  // (handles Victoria's EN + RU mix).
  form.append("response_format", "json");
  form.append("temperature", "0");

  try {
    const res = await fetch(GROQ_TRANSCRIBE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      console.error(`[voice] Groq transcription ${res.status}: ${detail}`);
      return { ok: false, reason: "upstream" };
    }
    const data = (await res.json().catch(() => ({}))) as { text?: unknown };
    const text = typeof data.text === "string" ? data.text.trim() : "";
    if (!text) return { ok: false, reason: "empty" };
    return { ok: true, text };
  } catch (error) {
    console.error("[voice] Groq transcription failed:", error);
    return { ok: false, reason: "upstream" };
  }
}
