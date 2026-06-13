/**
 * Ollama web search / fetch helper.
 *
 * Ollama exposes a hosted web-search API at https://ollama.com/api/web_search
 * and a page reader at https://ollama.com/api/web_fetch, both authenticated
 * with the account's cloud API key (Authorization: Bearer OLLAMA_API_KEY).
 *
 * IMPORTANT — enablement state on THIS account (verified empirically):
 * - POST https://ollama.com/api/web_search with the key from .env.local →
 *   401 Unauthorized (the key in .env.local is blank; chat runs through the
 *   locally signed-in ollama instead).
 * - The local ollama server (localhost:11434) does NOT expose /api/web_search
 *   → 404. Web search is a cloud-only API.
 * So with the current configuration web search is NOT available. The two
 * tools are wired everywhere and gated behind `webSearchEnabled()`: when the
 * account can't use web search they return a clean "not enabled" message
 * instead of breaking. Provide a real cloud API key with web search enabled
 * (and set WEB_SEARCH_ENABLED=1, or just a non-empty OLLAMA_API_KEY) to turn
 * them on — no code change needed.
 *
 * SECURITY: web_fetch pulls UNTRUSTED third-party page text into the agent's
 * context. It is read-only and every third-party-visible action still passes
 * through Victoria's [Confirm] gate, so containment holds — but the system
 * prompt tells the model to treat fetched content as data, never instructions.
 */

const WEB_SEARCH_URL = "https://ollama.com/api/web_search";
const WEB_FETCH_URL = "https://ollama.com/api/web_fetch";
const TIMEOUT_MS = 15_000;

/** Max characters of page/snippet text we hand back to the model per result. */
const MAX_SNIPPET_CHARS = 600;
/** Max characters of a fetched page body we hand back to the model. */
const MAX_FETCH_CHARS = 4_000;
/** Default number of search results to request/return. */
const DEFAULT_MAX_RESULTS = 5;
const HARD_MAX_RESULTS = 10;

export const WEB_SEARCH_DISABLED_MESSAGE =
  "Web search isn't enabled on this account yet — I can't look things up online right now. " +
  "(To enable it: add an Ollama Cloud API key with web search turned on and set WEB_SEARCH_ENABLED=1.)";

/**
 * Is web search usable right now? Web search is a cloud-only API that needs a
 * real Bearer key, so the default gate is "a non-empty OLLAMA_API_KEY exists".
 * WEB_SEARCH_ENABLED forces the flag either way (1 = on, 0 = off).
 */
export function webSearchEnabled(): boolean {
  const flag = (process.env.WEB_SEARCH_ENABLED || "").trim();
  if (flag === "1" || flag.toLowerCase() === "true") return true;
  if (flag === "0" || flag.toLowerCase() === "false") return false;
  return Boolean((process.env.OLLAMA_API_KEY || "").trim());
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export type WebSearchOutcome =
  | { ok: true; results: WebSearchResult[] }
  | { ok: false; error: string };

export type WebFetchOutcome =
  | { ok: true; title: string; url: string; text: string }
  | { ok: false; error: string };

function clip(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

async function postJson(
  url: string,
  body: Record<string, unknown>
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  const apiKey = (process.env.OLLAMA_API_KEY || "").trim();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      // Don't surface upstream auth detail to the model — keep it generic.
      const status = res.status;
      const reason =
        status === 401 || status === 403
          ? "web search isn't authorized on this account"
          : `web search upstream error ${status}`;
      return { ok: false, error: reason };
    }
    return { ok: true, data: await res.json() };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return {
      ok: false,
      error: timedOut ? "web search timed out" : "web search is unreachable",
    };
  }
}

/** Top web results for a query (title, url, snippet). Read-only. */
export async function ollamaWebSearch(
  query: string,
  maxResults: number = DEFAULT_MAX_RESULTS
): Promise<WebSearchOutcome> {
  const q = (query || "").trim();
  if (q.length < 2) return { ok: false, error: "query is too short" };
  if (!webSearchEnabled()) {
    return { ok: false, error: WEB_SEARCH_DISABLED_MESSAGE };
  }
  const limit = Math.max(
    1,
    Math.min(HARD_MAX_RESULTS, Math.floor(maxResults) || DEFAULT_MAX_RESULTS)
  );
  const res = await postJson(WEB_SEARCH_URL, { query: q, max_results: limit });
  if (!res.ok) return res;

  // Ollama returns { results: [{ title, url, content }] }.
  const raw = (res.data as { results?: unknown })?.results;
  if (!Array.isArray(raw)) return { ok: false, error: "no results" };
  const results: WebSearchResult[] = raw.slice(0, limit).map((r) => {
    const item = (r ?? {}) as {
      title?: unknown;
      url?: unknown;
      content?: unknown;
      snippet?: unknown;
    };
    return {
      title: clip(item.title, 200) || "(untitled)",
      url: clip(item.url, 500),
      snippet: clip(item.snippet ?? item.content, MAX_SNIPPET_CHARS),
    };
  });
  return { ok: true, results };
}

/** Fetch a single page's readable text. Read-only; content is UNTRUSTED. */
export async function ollamaWebFetch(url: string): Promise<WebFetchOutcome> {
  const target = (url || "").trim();
  if (!/^https?:\/\//i.test(target)) {
    return { ok: false, error: "url must start with http:// or https://" };
  }
  if (!webSearchEnabled()) {
    return { ok: false, error: WEB_SEARCH_DISABLED_MESSAGE };
  }
  const res = await postJson(WEB_FETCH_URL, { url: target });
  if (!res.ok) return res;

  // Ollama returns { title, content, links }.
  const data = (res.data ?? {}) as {
    title?: unknown;
    content?: unknown;
  };
  const text = clip(data.content, MAX_FETCH_CHARS);
  if (!text) return { ok: false, error: "page had no readable text" };
  return {
    ok: true,
    title: clip(data.title, 200) || target,
    url: target,
    text,
  };
}
