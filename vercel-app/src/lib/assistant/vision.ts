/**
 * Photo / vision understanding for Vassili.
 *
 * TWO-STAGE design (chosen empirically — see decision note below):
 *   Stage 1 (HERE): a multimodal model TRIAGES + EXTRACTS the photo into
 *     structured JSON — { kind, vendor, total, date, category, productName,
 *     productDesc, text } plus a hard skin-assessment refusal flag.
 *   Stage 2 (webhook): for a receipt/product we synthesize a plain-language
 *     instruction and run it through the EXISTING text agent + tools, so the
 *     mutating action (log_expense / product_add) parks behind Victoria's
 *     unchanged [Confirm | Cancel] gate. Nothing mutating ever executes from a
 *     photo without her tap.
 *
 * WHY two-stage (not let the vision model tool-call directly): the agent's
 * native tool-calling is proven only on the deepseek text models; the cloud
 * multimodal models (gemini-3-flash-preview / gemma3:27b) emit clean,
 * reliable JSON in probes but their tool_call support is unproven on this
 * account. Extracting JSON then handing it to the proven text-agent gate is
 * the robust path AND reuses every existing validation / disclosure / confirm
 * guarantee unchanged. Model: gemini-3-flash-preview (see visionModel()) —
 * lower latency than gemma3:27b on the same probes (~3–5s vs ~6–9s, which
 * matters because a second text-agent round follows under the webhook
 * deadline) with comparable extraction and correct skin-assessment refusal.
 *
 * CRITICAL GUARDRAIL — NO SKIN / FACE ASSESSMENT. Vassili must REFUSE to
 * analyze a person's face or skin for any cosmetic / medical / treatment
 * assessment ("what treatment does her skin need", "analyze my wrinkles").
 * Victoria's professional eye is the product; an AI skin diagnosis is both
 * off-brand and a medical-advice risk. This is enforced in THREE layers:
 *   1. the extraction system prompt instructs the model to classify any such
 *      request as kind "skin_assessment" with refuse=true and give NO advice;
 *   2. a code-level caption check (skinAssessmentIntent) forces refusal even if
 *      the model misclassifies — defense in depth;
 *   3. analyzePhoto returns the polite refusal + a booking suggestion and NEVER
 *      reaches the agent/tools for that case.
 * Legitimate ops photos (receipts, product jars, documents) are unaffected.
 */

import { EXPENSE_CATEGORIES } from "../finance";
import { visionModel } from "./agent";

const OLLAMA_CHAT_URL = "https://ollama.com/api/chat";

/** Per-request upstream timeout for the vision extraction call. */
const VISION_TIMEOUT_MS = 30_000;

/** Cap the extracted free-text (description/translation) we relay back. */
const MAX_TEXT_CHARS = 1500;

/**
 * Is photo understanding usable right now? The multimodal models are
 * cloud-only, so this needs the Ollama Cloud key (same one the agent uses).
 * When absent the webhook tells Victoria photos can't be processed.
 */
export function visionEnabled(): boolean {
  return Boolean((process.env.OLLAMA_API_KEY || "").trim());
}

/** The polite refusal for any skin/face-assessment intent (+ booking nudge). */
export const SKIN_REFUSAL =
  "I can't assess skin or faces from a photo — reading skin is Victoria's " +
  "professional craft, not something I'd ever guess at (and it wouldn't be " +
  "fair to you). If this is for a client, the right next step is a proper " +
  "consultation — I can help you set one up. Happy to help with receipts, " +
  "product photos, or documents anytime. 🙏";

/** Reply when vision is disabled (no cloud key). */
export const VISION_DISABLED =
  "I can't look at photos right now (vision isn't configured) — send it as " +
  "text and I'll help.";

/** Reply when the model couldn't make sense of the image. */
const VISION_UNCLEAR =
  "I couldn't make out anything useful in that photo. If it's a receipt or a " +
  "product, try a clearer, well-lit shot — or just tell me the details.";

// --- code-level skin-assessment intent (defense in depth) --------------------
//
// Targets ASSESSMENT phrasing about a person's face/skin, EN + RU. Kept
// deliberately tight so it doesn't trip on legitimate product captions like
// "new skin cream for the shop" (no assessment verb / possessive face).
const SKIN_INTENT_RE =
  /\b(analy[sz]e|assess|evaluate|diagnos\w*|check|look at|rate|examine|what(?:'s| is| does)|how(?:'s| is)|treat(?:ment)?|fix|improve|advise|recommend)\b[\s\S]{0,40}\b(skin|face|facial|complexion|wrinkl\w*|acne|pores?|blemish\w*|pigmentation|rosacea|breakout\w*|under[\s-]?eye|dark circles?)\b/i;
const SKIN_INTENT_RE_RU =
  /(кож\w*|лиц\w*|морщин\w*|акне|поры|пигментац\w*|прыщ\w*|высыпан\w*)[\s\S]{0,40}(анализ\w*|оцен\w*|диагноз\w*|提|что|как|лечен\w*|улучш\w*|посоветуй|порекоменд)|((анализ\w*|оцен\w*|посмотр\w*|лечен\w*|что с|как улучш)[\s\S]{0,40}(кож\w*|лиц\w*|морщин\w*|акне))/i;

/** Does this caption ask for a face/skin assessment? (forces refusal) */
export function skinAssessmentIntent(caption: string): boolean {
  const c = (caption || "").slice(0, 500);
  if (!c.trim()) return false;
  return SKIN_INTENT_RE.test(c) || SKIN_INTENT_RE_RU.test(c);
}

// --- extraction --------------------------------------------------------------

export type VisionKind = "receipt" | "product" | "general" | "skin_assessment";

interface VisionExtraction {
  kind: VisionKind;
  refuse: boolean;
  vendor: string;
  totalEgp: number | null;
  date: string;
  category: string;
  method: string;
  productName: string;
  productDesc: string;
  text: string;
}

function buildVisionPrompt(): string {
  return `You are the image-triage and extraction step for Vassili, the private ops assistant of a women's holistic beauty studio in Egypt. You receive ONE image plus an optional caption from the studio owner. Classify it and extract structured data. Respond with ONLY a single JSON object — no prose, no markdown fences.

Choose exactly one "kind":
- "receipt": a receipt, invoice or proof of a business expense/purchase.
- "product": a retail skincare/beauty PRODUCT (a jar, bottle, box) the owner wants to add to her shop.
- "general": the owner wants you to read, transcribe, translate or plainly describe what's in the image (a document, a note, a label).
- "skin_assessment": ANY request — by caption OR implied by a photo of a person's face/skin — to assess, diagnose, rate, or recommend treatment for someone's face, skin, wrinkles, acne, complexion or the like.

ABSOLUTE RULE: if kind is "skin_assessment" you MUST set "refuse": true and give NO skin/face/treatment assessment, observation or advice of any kind — not even a hint. Skin reading is the human esthetician's job, never the AI's. When unsure whether a face photo is an assessment request, prefer "skin_assessment" + refuse.

For "receipt", extract: vendor (string), total_egp (number, the grand total in EGP), date (YYYY-MM-DD or ""), category (best guess, ONE of: ${EXPENSE_CATEGORIES.join(", ")}), method (how paid: one of cash, bank-transfer, card, other; "" if unknown).
For "product", extract: product_name (the product's name in English) and product_desc (a short one-line description, e.g. type + size).
For "general", put the read/translated/described text in "text".

JSON shape (use null/"" for fields that don't apply):
{"kind":"receipt|product|general|skin_assessment","refuse":false,"vendor":"","total_egp":null,"date":"","category":"","method":"","product_name":"","product_desc":"","text":""}`;
}

function parseJsonLoose(raw: string): Record<string, unknown> | null {
  let s = (raw || "").trim();
  // Strip ``` / ```json fences the models sometimes add.
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s);
  if (fence) s = fence[1].trim();
  // Fall back to the first {...} block if there's leading/trailing prose.
  if (!s.startsWith("{")) {
    const m = /\{[\s\S]*\}/.exec(s);
    if (m) s = m[0];
  }
  try {
    const parsed = JSON.parse(s) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function str(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  return typeof v === "string" ? v.trim() : "";
}

async function callVision(
  imageBase64: string,
  caption: string,
  timeoutMs: number
): Promise<VisionExtraction | null> {
  const key = (process.env.OLLAMA_API_KEY || "").trim();
  if (!key) return null;
  let content: string;
  try {
    const res = await fetch(OLLAMA_CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: visionModel(),
        stream: false,
        options: { temperature: 0 },
        messages: [
          { role: "system", content: buildVisionPrompt() },
          {
            role: "user",
            content: `Caption from the owner: ${caption.trim() || "(none)"}`,
            images: [imageBase64],
          },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      console.error(`[vision] Ollama vision ${res.status}: ${detail}`);
      return null;
    }
    const data = (await res.json().catch(() => ({}))) as {
      message?: { content?: unknown };
    };
    content =
      typeof data.message?.content === "string" ? data.message.content : "";
  } catch (error) {
    console.error("[vision] Ollama vision call failed:", error);
    return null;
  }

  const obj = parseJsonLoose(content);
  if (!obj) return null;

  const kindRaw = str(obj, "kind").toLowerCase();
  const kind: VisionKind = (
    ["receipt", "product", "general", "skin_assessment"].includes(kindRaw)
      ? kindRaw
      : "general"
  ) as VisionKind;
  const totalRaw = obj["total_egp"];
  const totalEgp =
    typeof totalRaw === "number" && Number.isFinite(totalRaw)
      ? totalRaw
      : typeof totalRaw === "string" && totalRaw.trim() && Number.isFinite(Number(totalRaw))
        ? Number(totalRaw)
        : null;

  return {
    kind,
    refuse: obj["refuse"] === true,
    vendor: str(obj, "vendor"),
    totalEgp,
    date: str(obj, "date"),
    category: str(obj, "category"),
    method: str(obj, "method"),
    productName: str(obj, "product_name"),
    productDesc: str(obj, "product_desc"),
    text: str(obj, "text").slice(0, MAX_TEXT_CHARS),
  };
}

// --- public outcome ----------------------------------------------------------

export type PhotoOutcome =
  // Direct reply — refusal, general read/describe, disabled, or unclear.
  | { kind: "reply"; text: string }
  // Feed `instruction` into the text agent (it tool-calls → confirm gate);
  // `echo` is shown first so Victoria sees what was understood from the photo.
  | { kind: "agent"; instruction: string; echo: string };

/**
 * Analyze a photo (already-downloaded bytes) + its caption. Returns either a
 * direct reply or an agent instruction. NEVER throws — disabled/failed paths
 * return a friendly reply. The skin-assessment guardrail short-circuits to a
 * refusal before any extraction is acted upon.
 */
export async function analyzePhoto(
  imageBytes: Buffer,
  caption: string,
  opts: { deadlineAt?: number } = {}
): Promise<PhotoOutcome> {
  if (!visionEnabled()) return { kind: "reply", text: VISION_DISABLED };

  // LAYER 2 (pre-model backstop): a caption that plainly asks for a skin/face
  // assessment is refused without even calling the model.
  if (skinAssessmentIntent(caption)) {
    return { kind: "reply", text: SKIN_REFUSAL };
  }

  const timeoutMs = opts.deadlineAt
    ? Math.max(5_000, Math.min(VISION_TIMEOUT_MS, opts.deadlineAt - Date.now() - 20_000))
    : VISION_TIMEOUT_MS;
  const ex = await callVision(imageBytes.toString("base64"), caption, timeoutMs);
  if (!ex) return { kind: "reply", text: VISION_UNCLEAR };

  // LAYER 1+3: the model flagged a skin/face assessment → refuse, no analysis.
  if (ex.kind === "skin_assessment" || ex.refuse) {
    return { kind: "reply", text: SKIN_REFUSAL };
  }

  if (ex.kind === "receipt") {
    const cat = (EXPENSE_CATEGORIES as readonly string[]).includes(ex.category)
      ? ex.category
      : "other";
    const method = ["cash", "bank-transfer", "card", "other"].includes(ex.method)
      ? ex.method
      : "cash";
    const amount =
      ex.totalEgp !== null ? `${ex.totalEgp} EGP` : "(amount unclear)";
    const noteBits = [ex.vendor && `from ${ex.vendor}`, "receipt photo"]
      .filter(Boolean)
      .join(", ");
    const instruction =
      `I photographed a receipt. Log it as a business expense by calling log_expense with: ` +
      `amountEgp ${ex.totalEgp ?? 0}, category "${cat}", method "${method}"` +
      `${ex.date ? `, date "${ex.date}"` : ""}, note "${noteBits}". ` +
      `Use exactly these values; do not invent anything. If the amount is unclear, ask me for it instead.`;
    const echo =
      `🧾 From the receipt I read:\n` +
      `— vendor: ${ex.vendor || "(unclear)"}\n` +
      `— total: ${amount}\n` +
      `— date: ${ex.date || "(unclear)"}\n` +
      `— category guess: ${cat} · paid: ${method}`;
    return { kind: "agent", instruction, echo };
  }

  if (ex.kind === "product") {
    const name = ex.productName || "(unnamed product)";
    const instruction =
      `I photographed a product to add to the shop. Call product_add for it. ` +
      `English name: "${name}". Short English description: "${ex.productDesc}". ` +
      `${caption.trim() ? `My caption: "${caption.trim()}". ` : ""}` +
      `product_add REQUIRES a Russian name and a price in EGP — if my caption didn't give them, ASK me for the Russian name and the EGP price before calling the tool; do not guess them.`;
    const echo =
      `📦 From the product photo I read:\n` +
      `— name: ${name}` +
      `${ex.productDesc ? `\n— description: ${ex.productDesc}` : ""}`;
    return { kind: "agent", instruction, echo };
  }

  // general: just relay what was read/described.
  const text = ex.text || VISION_UNCLEAR;
  return { kind: "reply", text };
}
