import { buildVassiliSystemPrompt } from "./prompt";
import {
  TOOLS,
  describeMutation,
  executeTool,
  requiresConfirmation,
  validateMutationArgs,
  type ToolContext,
} from "./tools";
import {
  appendAudit,
  appendHistory,
  createPendingAction,
  loadHistory,
} from "./state";
import {
  createWebFetchAllowlist,
  WEB_TOOL_TIMEOUT_MS,
} from "./ollama-search";

/**
 * Vassili's agent loop — Ollama chat with NATIVE tool calling.
 *
 * Verified empirically against deepseek-v4-flash:cloud (Ollama 0.30):
 * the model advertises the "tools" capability, returns
 * `message.tool_calls[].function = { name, arguments: object }`, and accepts
 * tool results as `{ role: "tool", tool_name, content }` messages.
 *
 * Loop shape:
 * - ≤ MAX_TOOL_ROUNDS rounds (each round = one model call, possibly with
 *   several tool calls). Read-only tools execute inline; the FIRST mutating
 *   tool call short-circuits the loop into a pending action + confirmation
 *   keyboard (the model never gets to see mutating results directly — those
 *   arrive via the callback handler editing the Telegram message).
 * - Overall budget: callers pass an absolute `deadlineAt` (the webhook route
 *   derives it from its maxDuration). No NEW model call starts with less
 *   than DEADLINE_MIN_MODEL_MS remaining, and each call's own timeout is
 *   capped so it cannot run past the deadline minus the reply reserve —
 *   otherwise the function gets killed mid-run and Telegram redelivers the
 *   update, double-running the agent.
 */

const MAX_TOOL_ROUNDS = 4;
const UPSTREAM_TIMEOUT_MS = 30_000;
const NUM_PREDICT = 700;
/** Don't START a model call with less budget than this before the deadline. */
const DEADLINE_MIN_MODEL_MS = 20_000;
/** Time reserved after the last model call to send the Telegram reply. */
const REPLY_RESERVE_MS = 8_000;
/**
 * Below this much remaining budget we DOWNGRADE a heavy-routed call to the
 * fast model: heavy models can run slower, and a request must never be lost to
 * routing. Empirically the chosen heavy model (deepseek-v4-pro:cloud) returns
 * in ~2–3s, well under this, but the worst-case sibling (kimi-k2.6) has spiked
 * to ~10s — so leave generous headroom before the deadline.
 */
const HEAVY_MIN_REMAINING_MS = 35_000;

// --- Model routing -----------------------------------------------------------
//
// Two models, picked per task (see pickModel):
// - FAST (deepseek-v4-flash:cloud): default for everyday ops — bookings,
//   orders, quick Q&A. Keeps Telegram latency low.
// - HEAVY (deepseek-v4-pro:cloud): document / long-form generation — when the
//   user asks to write/draft/compose a letter, offer, proposal or document, or
//   the run is about to produce one (document_create / finance_pnl_document /
//   draft_client_email). Chosen empirically over kimi-k2.6 / glm-5.1: across
//   repeated probes deepseek-v4-pro ALWAYS emitted a well-formed tool_call with
//   every REQUIRED argument present (kimi-k2.6 dropped a required arg and had
//   ~10s latency spikes), returned in ~2.2s consistently, and — being the
//   heavyweight sibling of the fast default — keeps the persona/formatting the
//   existing prompt is tuned for. Tool-calling support is REQUIRED and proven.
//
// Both are env-overridable. Routing FAILS SAFE: if the heavy call errors (e.g.
// the model isn't pulled on this host) the loop retries once on the fast model
// rather than failing the request (see runAgent).

export const FAST_MODEL_DEFAULT = "deepseek-v4-flash:cloud";
export const HEAVY_MODEL_DEFAULT = "deepseek-v4-pro:cloud";

/** The everyday fast model (OLLAMA_MODEL override, else the flash default). */
export function fastModel(): string {
  return process.env.OLLAMA_MODEL || FAST_MODEL_DEFAULT;
}
/** The heavyweight model for long-form generation (OLLAMA_MODEL_HEAVY). */
export function heavyModel(): string {
  return process.env.OLLAMA_MODEL_HEAVY || HEAVY_MODEL_DEFAULT;
}

// Generation verbs + document nouns. Heavy routing fires when the user is
// asking the assistant to AUTHOR a document/long-form piece — not when they
// dictate content for an ops action (e.g. "send an email with exactly this
// body: …" has no generation verb, so it stays fast).
const GEN_VERB_RE =
  /\b(write|draft|compose|prepare|prep|produce|generate|create|make|put together|drafting|compose)\b/i;
const DOC_NOUN_RE =
  /\b(letter|offer|proposal|document|doc|pdf|memo|contract|agreement|statement|p&l|p&amp;l|profit\s*(?:&|and)\s*loss|invoice|quote|quotation|cover\s*note|email)\b/i;
const RU_GEN_VERB_RE =
  /(напиш|состав|подготов|оформ|сделай|сгенерир|подготовь|сочини)/i;
const RU_DOC_NOUN_RE =
  /(письм|предложени|документ|оффер|договор|памятк|счёт|счет|pdf|коммерческ)/i;
// Phrases that are document-generation on their own.
const HEAVY_PHRASE_RE =
  /(коммерческ\w*\s+предложени|offer\s+document|offer\s+letter|p&l\s+(?:document|statement|pdf)|letterhead)/i;

/** Does this user message ask the assistant to author a document / long-form? */
export function isHeavyIntent(userText: string): boolean {
  const t = (userText || "").slice(0, 2000);
  if (HEAVY_PHRASE_RE.test(t)) return true;
  if (GEN_VERB_RE.test(t) && DOC_NOUN_RE.test(t)) return true;
  if (RU_GEN_VERB_RE.test(t) && RU_DOC_NOUN_RE.test(t)) return true;
  return false;
}

export interface ModelRoute {
  model: string;
  heavy: boolean;
  reason: string;
}

/**
 * Pick the model for a run from the user's message. Pure + env-overridable so
 * it can be unit-tested in isolation. Document/long-form intent → heavy; every
 * other (ops) request → fast.
 */
export function pickModel(ctx: { userText: string }): ModelRoute {
  if (isHeavyIntent(ctx.userText)) {
    return {
      model: heavyModel(),
      heavy: true,
      reason: "document/long-form generation intent",
    };
  }
  return { model: fastModel(), heavy: false, reason: "default ops" };
}

interface OllamaToolCall {
  function: { name: string; arguments?: Record<string, unknown> | string };
}

interface OllamaChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}

async function callOllama(
  messages: OllamaChatMessage[],
  model: string,
  timeoutMs: number = UPSTREAM_TIMEOUT_MS
): Promise<OllamaChatMessage> {
  const apiKey = process.env.OLLAMA_API_KEY;
  const baseUrl = apiKey
    ? "https://ollama.com/api/chat"
    : "http://localhost:11434/api/chat";

  const res = await fetch(baseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      stream: false,
      options: { num_predict: NUM_PREDICT },
      messages,
      tools: TOOLS,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 500);
    throw new Error(`Ollama upstream error ${res.status}: ${detail}`);
  }
  const data = (await res.json()) as { message?: OllamaChatMessage };
  if (!data.message) throw new Error("Ollama returned no message");
  return data.message;
}

function parseArgs(call: OllamaToolCall): Record<string, unknown> {
  const raw = call.function.arguments;
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object")
        return parsed as Record<string, unknown>;
    } catch {
      // fall through
    }
  }
  return {};
}

export type AgentOutcome =
  | { kind: "text"; text: string }
  | {
      kind: "confirm";
      /** Text to send above the [Confirm | Cancel] keyboard. */
      text: string;
      pendingId: string;
    };

/**
 * Run one user message through the agent. Returns either a final text reply
 * or a confirmation request (the caller attaches the inline keyboard).
 * Conversation history is loaded from / persisted to Blob here.
 */
export async function runAgent(
  userText: string,
  ctx: ToolContext,
  opts: { deadlineAt?: number } = {}
): Promise<AgentOutcome> {
  const history = await loadHistory();
  const messages: OllamaChatMessage[] = [
    { role: "system", content: buildVassiliSystemPrompt() },
    // History keeps full tool-call exchanges (see state.ts) — pass through.
    ...history.map(
      (m): OllamaChatMessage => ({
        role: m.role,
        content: m.content,
        ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
        ...(m.tool_name ? { tool_name: m.tool_name } : {}),
      })
    ),
    { role: "user", content: userText },
  ];

  // Most recent validation-refusal error, kept so that when the round budget
  // runs out with no usable model text, the user still sees WHY nothing
  // happened instead of a generic empty-handed shrug.
  let lastRefusal: string | null = null;

  // Route once from the user's intent; the whole run uses this model so the
  // call that AUTHORS a document (emitting document_create / draft / P&L args)
  // is the heavy one. Per-call we may still downgrade to fast if the deadline
  // is tight, and fall back to fast if the heavy call errors.
  const route = pickModel({ userText });
  // Latched once the heavy model fails in this run, so later rounds go straight
  // to fast instead of re-attempting (and re-failing) the heavy model.
  let heavyDisabled = false;

  // Fresh per-run web_fetch allowlist: web_search records its result URLs into
  // it; web_fetch is restricted to those exact URLs (anti-exfiltration). A new
  // run gets a new allowlist, so URLs from other runs are never fetchable.
  const runCtx: ToolContext = {
    ...ctx,
    webFetchAllowlist: createWebFetchAllowlist(),
  };

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const finalRound = round === MAX_TOOL_ROUNDS;

    // Deadline gate: never start a model call that could outlive the route's
    // execution budget (the function would be killed and Telegram would
    // redeliver the update, double-running the agent).
    const remainingMs =
      opts.deadlineAt !== undefined
        ? opts.deadlineAt - Date.now()
        : Number.POSITIVE_INFINITY;
    if (remainingMs < DEADLINE_MIN_MODEL_MS) {
      const text =
        "Sorry — this one is taking me too long to work through. Please try again in a moment.";
      await appendHistory(
        { role: "user", content: userText },
        { role: "assistant", content: text }
      );
      return { kind: "text", text };
    }

    // Budget-aware model choice for THIS call: heavy only when there is room
    // for its (potentially slower) response and it hasn't already failed this
    // run; otherwise fall to fast.
    const useHeavy =
      route.heavy && !heavyDisabled && remainingMs >= HEAVY_MIN_REMAINING_MS;
    const callModel = useHeavy ? route.model : fastModel();
    const callTimeout = Math.min(
      UPSTREAM_TIMEOUT_MS,
      remainingMs - REPLY_RESERVE_MS
    );

    let reply: OllamaChatMessage;
    try {
      reply = await callOllama(messages, callModel, callTimeout);
    } catch (error) {
      console.error(
        `[assistant] Model call failed (model=${callModel}):`,
        error
      );
      // FAIL SAFE: never lose a request to routing. If the HEAVY model failed
      // (e.g. not pulled on this host, or upstream hiccup), retry once on the
      // fast model — but only if budget still allows a fresh call. Latch heavy
      // off so the remaining rounds skip it.
      heavyDisabled = true;
      const fast = fastModel();
      const retryRemaining =
        opts.deadlineAt !== undefined
          ? opts.deadlineAt - Date.now()
          : Number.POSITIVE_INFINITY;
      if (callModel !== fast && retryRemaining >= DEADLINE_MIN_MODEL_MS) {
        try {
          reply = await callOllama(
            messages,
            fast,
            Math.min(UPSTREAM_TIMEOUT_MS, retryRemaining - REPLY_RESERVE_MS)
          );
        } catch (fallbackError) {
          console.error(
            "[assistant] Fast-model fallback also failed:",
            fallbackError
          );
          return {
            kind: "text",
            text: "Sorry — my brain is unreachable right now. Please try again in a minute.",
          };
        }
      } else {
        return {
          kind: "text",
          text: "Sorry — my brain is unreachable right now. Please try again in a minute.",
        };
      }
    }

    const toolCalls = reply.tool_calls ?? [];
    if (toolCalls.length === 0 || finalRound) {
      const text =
        (reply.content || "").trim() ||
        (lastRefusal
          ? `I can't do that as asked — ${lastRefusal}. Nothing was queued. Please rephrase and I'll try again.`
          : "Hmm, I came back empty-handed. Could you rephrase that?");
      await appendHistory(
        { role: "user", content: userText },
        { role: "assistant", content: text }
      );
      return { kind: "text", text };
    }

    // Mutating call? → pending action + keyboard, loop ends here.
    let refusedThisRound = false;
    for (const call of toolCalls) {
      const name = call.function?.name ?? "";
      const args = parseArgs(call);
      if (requiresConfirmation(name, args)) {
        // Validate/normalize ONCE — summary and executor must consume the
        // SAME validated object, so what Victoria confirms is exactly what
        // executes. Invalid args (wrong types, empty required strings, bad
        // emails) are REFUSED outright, never queued: a malformed value
        // could render blank on the confirmation card while the executor's
        // String() coercion acts on the real payload (prompt injection).
        const validated = validateMutationArgs(name, args);
        if (!validated.ok) {
          // Don't end the loop with a user-facing refusal over a fixable
          // slip (e.g. '"priceEgp": "abc"'): rounds always remain here
          // (finalRound returned above), so feed REFUSED back as a tool
          // result and let the model self-correct. Victoria only sees a
          // refusal if the round budget runs out without usable text
          // (the lastRefusal fallback above).
          lastRefusal = validated.error;
          await appendAudit({
            chatId: ctx.chatId,
            kind: "tool-refused",
            detail: { tool: name, args, error: validated.error },
          });
          messages.push(reply);
          for (const c of toolCalls) {
            messages.push({
              role: "tool",
              tool_name: c.function?.name ?? "",
              content:
                c === call
                  ? `REFUSED — ${validated.error}. Nothing was queued or executed. Correct the arguments and call the tool again.`
                  : "NOT EXECUTED — another tool call in this turn was refused; correct it and retry.",
            });
          }
          refusedThisRound = true;
          break;
        }
        const summary = describeMutation(name, validated.args);
        const pending = await createPendingAction({
          chatId: ctx.chatId,
          tool: name,
          args: validated.args,
          summary,
        });
        const text = `⚠️ Please confirm:\n${summary}`;
        // Persist the exchange as a REAL tool call (not the prompt text):
        // text-shaped confirmations in history teach the model to imitate
        // text instead of calling tools (observed with deepseek-v4-flash).
        await appendHistory(
          { role: "user", content: userText },
          {
            role: "assistant",
            content: "",
            tool_calls: [{ function: { name, arguments: validated.args } }],
          },
          {
            role: "tool",
            tool_name: name,
            content: `Queued — Victoria was shown a [Confirm | Cancel] button for: ${summary}. The system will report the outcome; do not retry.`,
          }
        );
        await appendAudit({
          chatId: ctx.chatId,
          kind: "pending-created",
          detail: { id: pending.id, tool: name, args: validated.args },
        });
        return { kind: "confirm", text, pendingId: pending.id };
      }
    }
    if (refusedThisRound) continue; // refusal already fed back — next round

    // All read-only — execute and feed results back.
    messages.push(reply);
    for (const call of toolCalls) {
      const name = call.function?.name ?? "";
      const args = parseArgs(call);
      // Deadline gate for the web tools: each carries a ~8s upstream timeout
      // and read-only tools run with no per-tool budget check, so two of them
      // could push past the function's maxDuration kill (→ Telegram redelivers
      // and double-runs the agent). If less than one web-tool timeout remains,
      // skip the call with a "ran out of time" result instead of risking it.
      const isWebTool = name === "web_search" || name === "web_fetch";
      let result: string;
      if (
        isWebTool &&
        opts.deadlineAt !== undefined &&
        opts.deadlineAt - Date.now() < WEB_TOOL_TIMEOUT_MS
      ) {
        result =
          "Ran out of time to look that up just now — please ask me again in a moment.";
      } else {
        result = await executeTool(name, args, runCtx);
      }
      await appendAudit({
        chatId: ctx.chatId,
        kind: "tool-executed",
        detail: { tool: name, args, result: result.slice(0, 500) },
      });
      messages.push({
        role: "tool",
        tool_name: name,
        content: result.slice(0, 6000),
      });
    }
  }

  // Unreachable (finalRound returns above), but keep TypeScript satisfied.
  return { kind: "text", text: "Something went sideways — please try again." };
}
