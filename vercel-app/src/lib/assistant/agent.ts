import { buildVassiliSystemPrompt } from "./prompt";
import {
  TOOLS,
  describeMutation,
  executeTool,
  requiresConfirmation,
  type ToolContext,
} from "./tools";
import {
  appendAudit,
  appendHistory,
  createPendingAction,
  loadHistory,
} from "./state";

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
 * - Overall budget enforced by the route's maxDuration (60 s); each upstream
 *   model call gets its own 30 s timeout.
 */

const MAX_TOOL_ROUNDS = 4;
const UPSTREAM_TIMEOUT_MS = 30_000;
const NUM_PREDICT = 700;

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
  messages: OllamaChatMessage[]
): Promise<OllamaChatMessage> {
  const apiKey = process.env.OLLAMA_API_KEY;
  const baseUrl = apiKey
    ? "https://ollama.com/api/chat"
    : "http://localhost:11434/api/chat";
  const model = process.env.OLLAMA_MODEL || "deepseek-v4-flash:cloud";

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
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
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
  ctx: ToolContext
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

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const finalRound = round === MAX_TOOL_ROUNDS;
    let reply: OllamaChatMessage;
    try {
      reply = await callOllama(messages);
    } catch (error) {
      console.error("[assistant] Model call failed:", error);
      return {
        kind: "text",
        text: "Sorry — my brain is unreachable right now. Please try again in a minute.",
      };
    }

    const toolCalls = reply.tool_calls ?? [];
    if (toolCalls.length === 0 || finalRound) {
      const text =
        (reply.content || "").trim() ||
        "Hmm, I came back empty-handed. Could you rephrase that?";
      await appendHistory(
        { role: "user", content: userText },
        { role: "assistant", content: text }
      );
      return { kind: "text", text };
    }

    // Mutating call? → pending action + keyboard, loop ends here.
    for (const call of toolCalls) {
      const name = call.function?.name ?? "";
      const args = parseArgs(call);
      if (requiresConfirmation(name, args)) {
        const summary = describeMutation(name, args);
        const pending = await createPendingAction({
          chatId: ctx.chatId,
          tool: name,
          args,
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
            tool_calls: [{ function: { name, arguments: args } }],
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
          detail: { id: pending.id, tool: name, args },
        });
        return { kind: "confirm", text, pendingId: pending.id };
      }
    }

    // All read-only — execute and feed results back.
    messages.push(reply);
    for (const call of toolCalls) {
      const name = call.function?.name ?? "";
      const args = parseArgs(call);
      const result = await executeTool(name, args, ctx);
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
