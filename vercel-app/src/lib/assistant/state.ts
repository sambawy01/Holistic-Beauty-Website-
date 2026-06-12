import { del, get, put } from "@vercel/blob";

/**
 * Vassili's state on Vercel Blob (same private store as orders/catalog,
 * authenticated by BLOB_READ_WRITE_TOKEN).
 *
 * Layout:
 * - telegram/owner.json          — the ONE bound owner chat ({ chatId, boundAt })
 * - telegram/history.json        — rolling conversation memory (last ~12 turns)
 * - telegram/pending/<uuid>.json — confirmation-gated actions awaiting a tap
 * - telegram/audit.jsonl         — append-only action log (best effort)
 *
 * All reads use `useCache: false` — every document here is read-modify-write
 * and a stale CDN copy would replay an executed pending action or lose turns.
 */

const OWNER_PATH = "telegram/owner.json";
const HISTORY_PATH = "telegram/history.json";
const AUDIT_PATH = "telegram/audit.jsonl";

/** 15-minute confirmation window for pending mutations. */
export const PENDING_TTL_MS = 15 * 60 * 1000;

/** Conversation memory: keep the last 12 turns (24 messages). */
const HISTORY_MAX_MESSAGES = 24;
/** Cap stored message size so one giant brief doesn't bloat every request. */
const HISTORY_MAX_CHARS = 2000;

async function readJson<T>(pathname: string): Promise<T | null> {
  const result = await get(pathname, { access: "private", useCache: false });
  if (!result || result.statusCode !== 200) return null;
  try {
    return (await new Response(result.stream).json()) as T;
  } catch {
    return null;
  }
}

async function writeJson(pathname: string, value: unknown): Promise<void> {
  await put(pathname, JSON.stringify(value, null, 2), {
    access: "private",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

// --- Owner binding -----------------------------------------------------------

interface OwnerRecord {
  chatId: number;
  boundAt: string;
}

export async function getOwnerChatId(): Promise<number | null> {
  const owner = await readJson<OwnerRecord>(OWNER_PATH);
  return owner && typeof owner.chatId === "number" ? owner.chatId : null;
}

export async function bindOwner(chatId: number): Promise<void> {
  await writeJson(OWNER_PATH, {
    chatId,
    boundAt: new Date().toISOString(),
  } satisfies OwnerRecord);
}

// --- Conversation memory -------------------------------------------------------

/**
 * History stores Ollama-shaped messages, INCLUDING tool-call exchanges for
 * confirmation-gated mutations. This is deliberate: if past mutations appear
 * in history as plain text ("⚠️ Please confirm: …"), the model learns to
 * imitate the text instead of calling the tool — observed empirically with
 * deepseek-v4-flash. Storing the real tool call gives it the right pattern.
 */
export interface HistoryToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

export interface HistoryMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  tool_calls?: HistoryToolCall[];
  tool_name?: string;
}

export async function loadHistory(): Promise<HistoryMessage[]> {
  const history = await readJson<HistoryMessage[]>(HISTORY_PATH);
  if (!Array.isArray(history)) return [];
  return history.filter(
    (m) =>
      (m?.role === "user" || m?.role === "assistant" || m?.role === "tool") &&
      typeof m?.content === "string"
  );
}

/** Append turns and trim to the rolling window. Never throws (best effort). */
export async function appendHistory(
  ...messages: HistoryMessage[]
): Promise<void> {
  try {
    const history = await loadHistory();
    const next = [
      ...history,
      ...messages.map((m) => ({
        ...m,
        content: m.content.slice(0, HISTORY_MAX_CHARS),
      })),
    ].slice(-HISTORY_MAX_MESSAGES);
    // Ollama requires tool messages to follow an assistant tool_calls turn —
    // trimming must never strand a leading tool message.
    while (next.length > 0 && next[0].role === "tool") next.shift();
    await writeJson(HISTORY_PATH, next);
  } catch (error) {
    console.error("[assistant] Failed to persist history:", error);
  }
}

// --- Pending (confirmation-gated) actions ----------------------------------------

export interface PendingAction {
  id: string;
  chatId: number;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  createdAt: string;
}

const PENDING_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function pendingPath(id: string): string {
  if (!PENDING_ID_RE.test(id)) {
    // Defense in depth: ids come back via callback_data from the network.
    throw new Error("Invalid pending action id");
  }
  return `telegram/pending/${id}.json`;
}

export async function createPendingAction(
  action: Omit<PendingAction, "id" | "createdAt">
): Promise<PendingAction> {
  const pending: PendingAction = {
    ...action,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  await writeJson(pendingPath(pending.id), pending);
  return pending;
}

export type TakePendingResult =
  | { ok: true; action: PendingAction }
  | { ok: false; reason: "not-found" | "expired" | "invalid-id" };

/**
 * Fetch a pending action and delete its blob — each action can execute at
 * most once (a second Confirm tap finds nothing). Expired actions are
 * deleted too.
 */
export async function takePendingAction(
  id: string
): Promise<TakePendingResult> {
  if (!PENDING_ID_RE.test(id)) return { ok: false, reason: "invalid-id" };
  const action = await readJson<PendingAction>(pendingPath(id));
  if (!action) return { ok: false, reason: "not-found" };

  try {
    await del(pendingPath(id));
  } catch (error) {
    // If the delete fails we must NOT execute — a retry could double-fire.
    console.error("[assistant] Failed to delete pending action:", error);
    return { ok: false, reason: "not-found" };
  }

  const age = Date.now() - new Date(action.createdAt).getTime();
  if (!Number.isFinite(age) || age > PENDING_TTL_MS) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, action };
}

/** Discard a pending action (Cancel tap). Best effort. */
export async function discardPendingAction(id: string): Promise<void> {
  if (!PENDING_ID_RE.test(id)) return;
  try {
    await del(pendingPath(id));
  } catch (error) {
    console.error("[assistant] Failed to discard pending action:", error);
  }
}

// --- Audit log --------------------------------------------------------------------

export interface AuditEntry {
  at: string;
  chatId: number;
  kind: string;
  detail: Record<string, unknown>;
}

/**
 * Append one line to telegram/audit.jsonl. Read-modify-write (no append API
 * on Blob) and strictly best effort — an audit failure never blocks an action.
 */
export async function appendAudit(
  entry: Omit<AuditEntry, "at">
): Promise<void> {
  try {
    const existing = await get(AUDIT_PATH, {
      access: "private",
      useCache: false,
    });
    let text = "";
    if (existing && existing.statusCode === 200) {
      text = await new Response(existing.stream).text();
    }
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    // Keep the log bounded: retain roughly the last 2000 lines.
    const lines = (text ? text.split("\n").filter(Boolean) : []).slice(-1999);
    lines.push(line);
    await put(AUDIT_PATH, lines.join("\n") + "\n", {
      access: "private",
      contentType: "application/x-ndjson",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  } catch (error) {
    console.error("[assistant] Audit append failed:", error);
  }
}
