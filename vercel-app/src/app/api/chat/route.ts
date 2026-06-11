import { NextRequest, NextResponse } from "next/server";
import { buildSystemPrompt } from "@/lib/concierge-prompt";
import { getCatalog, SEED, type Product } from "@/lib/catalog";
import { corsHeaders, isAllowedOrigin } from "@/lib/cors";

export const runtime = "nodejs";

const MAX_MESSAGES = 12;
const MAX_MESSAGE_CHARS = 1000;
const UPSTREAM_TIMEOUT_MS = 30_000;

// --- CORS (shared allowlist in @/lib/cors) -------------------------------

export async function OPTIONS(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!isAllowedOrigin(origin)) {
    return new NextResponse(null, { status: 403 });
  }
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
}

// --- Rate limiting --------------------------------------------------------
// NOTE: simple in-memory per-IP sliding window. This is per-instance,
// best-effort only — on serverless each instance keeps its own counters.

const RATE_LIMIT = 10; // requests
const RATE_WINDOW_MS = 60_000; // per minute
const hits = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const windowStart = now - RATE_WINDOW_MS;
  const recent = (hits.get(ip) ?? []).filter((t) => t > windowStart);
  if (recent.length >= RATE_LIMIT) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  // Opportunistic cleanup so the map doesn't grow unbounded.
  if (hits.size > 5000) {
    for (const [key, times] of hits) {
      if (times.every((t) => t <= windowStart)) hits.delete(key);
    }
  }
  return false;
}

function clientIp(request: NextRequest): string {
  const fwd = request.headers.get("x-forwarded-for");
  return fwd ? fwd.split(",")[0].trim() : "unknown";
}

// --- Chat handler ----------------------------------------------------------

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

function jsonError(
  message: string,
  status: number,
  headers: Record<string, string>
) {
  return NextResponse.json({ error: message }, { status, headers });
}

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!isAllowedOrigin(origin)) {
    return NextResponse.json({ error: "Origin not allowed" }, { status: 403 });
  }
  const cors = corsHeaders(origin);

  if (isRateLimited(clientIp(request))) {
    return jsonError("Too many requests. Please try again in a minute.", 429, cors);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400, cors);
  }

  const { messages, lang } = (body ?? {}) as {
    messages?: unknown;
    lang?: unknown;
  };

  if (!Array.isArray(messages) || messages.length === 0) {
    return jsonError("`messages` must be a non-empty array", 400, cors);
  }
  if (messages.length > MAX_MESSAGES) {
    return jsonError(`Too many messages (max ${MAX_MESSAGES})`, 400, cors);
  }

  const validated: ChatMessage[] = [];
  for (const m of messages) {
    const msg = m as { role?: unknown; content?: unknown };
    if (
      (msg?.role !== "user" && msg?.role !== "assistant") ||
      typeof msg?.content !== "string" ||
      msg.content.length === 0
    ) {
      return jsonError(
        "Each message must be { role: 'user'|'assistant', content: string }",
        400,
        cors
      );
    }
    if (msg.content.length > MAX_MESSAGE_CHARS) {
      return jsonError(
        `Message too long (max ${MAX_MESSAGE_CHARS} characters)`,
        400,
        cors
      );
    }
    validated.push({ role: msg.role, content: msg.content });
  }

  const language: "en" | "ru" = lang === "ru" ? "ru" : "en";

  // Live shop knowledge: prices, availability and the manufacturer's usage
  // directions come from the dynamic catalog. A blob failure must never
  // break the concierge — degrade to the built-in SEED catalog (which also
  // carries usage texts).
  let catalog: readonly Product[];
  try {
    catalog = await getCatalog();
  } catch (error) {
    console.error("[chat] Catalog read failed — using seed:", error);
    catalog = SEED;
  }
  const systemPrompt = buildSystemPrompt(
    language,
    catalog.filter((p) => p.active)
  );

  // Ollama Cloud when a key is configured, otherwise local ollama
  // (local dev: the machine's ollama is signed into Ollama Cloud,
  // so :cloud models work through localhost too).
  const apiKey = process.env.OLLAMA_API_KEY;
  const baseUrl = apiKey
    ? "https://ollama.com/api/chat"
    : "http://localhost:11434/api/chat";
  const model = process.env.OLLAMA_MODEL || "deepseek-v4-flash:cloud";

  try {
    const upstream = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        stream: false,
        options: { num_predict: 350 },
        messages: [{ role: "system", content: systemPrompt }, ...validated],
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    if (!upstream.ok) {
      // Never leak upstream details (could include auth hints) to the client.
      console.error(
        "Ollama upstream error:",
        upstream.status,
        (await upstream.text()).slice(0, 500)
      );
      return jsonError("The concierge is temporarily unavailable", 502, cors);
    }

    const data = (await upstream.json()) as {
      message?: { role?: string; content?: string };
    };
    const reply = data?.message?.content;
    if (typeof reply !== "string" || reply.length === 0) {
      console.error("Ollama returned empty/invalid reply");
      return jsonError("The concierge is temporarily unavailable", 502, cors);
    }

    return NextResponse.json({ reply }, { headers: cors });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    console.error("Ollama request failed:", err instanceof Error ? err.message : err);
    return jsonError(
      timedOut
        ? "The concierge took too long to respond. Please try again."
        : "The concierge is temporarily unavailable",
      timedOut ? 504 : 502,
      cors
    );
  }
}
