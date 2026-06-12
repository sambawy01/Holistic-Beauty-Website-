import { readFile } from "node:fs/promises";
import { join } from "node:path";
import PDFDocument from "pdfkit";

/**
 * Company-letterhead PDF for Vassili's `document_create` tool.
 *
 * Design mirrors the branded email shell (@/lib/branded-email):
 * - Dark band (#100D0B) across the top with the white logo PNG
 *   (fetched from the live site, falling back to public/logo-white.png,
 *   falling back to a typeset wordmark).
 * - "Earthen Calm" palette: #3A332C ink, #847866 muted, #E5DCCB hairlines.
 * - Headings in letter-spaced uppercase Helvetica (the closest built-in to
 *   the site's Tenor Sans — standard 14 fonts only, no font embedding).
 * - Footer hairline with contacts.
 *
 * Body text is "markdownish": blank lines split paragraphs, `# `/`## ` lines
 * become headings, `- `/`* ` lines become bullets. Everything else renders
 * as body paragraphs.
 *
 * Limitation (deliberate): the built-in fonts are WinAnsi-encoded, so only
 * Latin text renders. `unsupportedCharsStripped` flags when non-Latin
 * characters (e.g. Cyrillic) had to be removed so the tool can warn.
 */

const LOGO_URL = "https://victoriaholisticbeauty.com/assets/logo-white.png";
const BRAND_NAME = "VICTORIA VASILYEVA — HOLISTIC BEAUTY";
const FOOTER_TEXT =
  "victoriaholisticbeauty.com  ·  victoria@victoriaholisticbeauty.com";

const INK = "#3A332C";
const MUTED = "#847866";
const HAIRLINE = "#E5DCCB";
const BAND = "#100D0B";

const PAGE_MARGIN = 64;
const BAND_HEIGHT = 110;

export interface LetterheadDocumentInput {
  title: string;
  /** Markdownish body (see module docs). */
  body: string;
  /** Optional "To: ..." recipient line. */
  recipient?: string;
  /** Injectable for tests. */
  now?: Date;
}

export interface LetterheadDocumentResult {
  pdf: Buffer;
  /** True when non-WinAnsi characters were stripped from the text. */
  unsupportedCharsStripped: boolean;
}

/**
 * Keep WinAnsi-safe characters only (built-in fonts cannot encode the rest).
 * `onStrip` fires when characters had to be dropped — per-render closure, no
 * shared module state.
 */
function makeSanitizer(onStrip: () => void): (text: string) => string {
  return (text: string): string => {
    const safe = text
      .replace(/[‘’ʼ]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/…/g, "...")
      .replace(/[–—]/g, "-")
      .replace(/ /g, " ")
      // WinAnsi is roughly Latin-1; drop anything outside it.
      .replace(/[^\x20-\x7E¡-ÿ\n\t]/g, "");
    if (safe.replace(/\s/g, "").length < text.replace(/\s/g, "").length) {
      onStrip();
    }
    return safe;
  };
}

async function loadLogo(): Promise<Buffer | null> {
  try {
    const res = await fetch(LOGO_URL, { signal: AbortSignal.timeout(8_000) });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
  } catch {
    // fall through to the local copy
  }
  try {
    return await readFile(join(process.cwd(), "public", "logo-white.png"));
  } catch {
    return null;
  }
}

export async function renderLetterheadPdf(
  input: LetterheadDocumentInput
): Promise<LetterheadDocumentResult> {
  let strippedChars = false;
  const sanitize = makeSanitizer(() => {
    strippedChars = true;
  });

  const logo = await loadLogo();
  const now = input.now ?? new Date();
  const dateLine = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Cairo",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(now);

  const doc = new PDFDocument({
    size: "A4",
    margins: {
      top: BAND_HEIGHT + 56,
      bottom: 96,
      left: PAGE_MARGIN,
      right: PAGE_MARGIN,
    },
    info: { Title: input.title, Author: "Victoria Vasilyeva Holistic Beauty" },
  });

  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) =>
    doc.on("end", () => resolve(Buffer.concat(chunks)))
  );

  const pageWidth = doc.page.width;
  const contentWidth = pageWidth - PAGE_MARGIN * 2;

  const drawBandAndFooter = () => {
    // Decoration must never disturb the text flow: pdfkit auto-paginates any
    // text drawn past the bottom margin, so we lift the margin while drawing
    // the footer and restore the cursor afterwards.
    const savedX = doc.x;
    const savedY = doc.y;
    const savedBottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;

    // Dark band with the white logo (760×387 PNG — fit by HEIGHT so it can
    // never overflow the band).
    doc.save();
    doc.rect(0, 0, pageWidth, BAND_HEIGHT).fill(BAND);
    if (logo) {
      const boxWidth = 240;
      const boxHeight = 82;
      doc.image(logo, (pageWidth - boxWidth) / 2, (BAND_HEIGHT - boxHeight) / 2, {
        fit: [boxWidth, boxHeight],
        align: "center",
        valign: "center",
      });
    } else {
      doc
        .font("Helvetica")
        .fontSize(13)
        .fillColor("#FFFDF9")
        .text(BRAND_NAME, PAGE_MARGIN, BAND_HEIGHT / 2 - 8, {
          width: contentWidth,
          align: "center",
          characterSpacing: 2,
        });
    }
    // Footer hairline + contacts.
    const footerY = doc.page.height - 64;
    doc
      .moveTo(PAGE_MARGIN, footerY)
      .lineTo(pageWidth - PAGE_MARGIN, footerY)
      .lineWidth(0.5)
      .strokeColor(HAIRLINE)
      .stroke();
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor(MUTED)
      .text(FOOTER_TEXT, PAGE_MARGIN, footerY + 12, {
        width: contentWidth,
        align: "center",
        characterSpacing: 0.5,
      });
    doc.restore();

    doc.page.margins.bottom = savedBottomMargin;
    doc.x = savedX;
    doc.y = savedY;
  };

  drawBandAndFooter();
  doc.on("pageAdded", drawBandAndFooter);

  // --- Letter head matter -------------------------------------------------
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor(MUTED)
    .text(sanitize(BRAND_NAME), PAGE_MARGIN, BAND_HEIGHT + 40, {
      width: contentWidth,
      characterSpacing: 2.2,
    });
  doc.moveDown(0.6);
  doc
    .font("Helvetica")
    .fontSize(20)
    .fillColor(INK)
    .text(sanitize(input.title).toUpperCase(), {
      width: contentWidth,
      characterSpacing: 1.6,
      lineGap: 4,
    });
  doc.moveDown(0.5);
  doc.font("Helvetica").fontSize(10).fillColor(MUTED);
  doc.text(sanitize(dateLine), { width: contentWidth });
  if (input.recipient) {
    doc.text(sanitize(`To: ${input.recipient}`), { width: contentWidth });
  }
  doc.moveDown(0.4);
  const ruleY = doc.y;
  doc
    .moveTo(PAGE_MARGIN, ruleY)
    .lineTo(PAGE_MARGIN + contentWidth, ruleY)
    .lineWidth(0.5)
    .strokeColor(HAIRLINE)
    .stroke();
  doc.moveDown(1.2);

  // --- Markdownish body -------------------------------------------------------
  const paragraphs = sanitize(input.body).split(/\n{2,}/);
  for (const para of paragraphs) {
    const lines = para.split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines) {
      const trimmed = line.trim();
      const heading = /^#{1,3}\s+(.*)$/.exec(trimmed);
      const bullet = /^[-*]\s+(.*)$/.exec(trimmed);
      if (heading) {
        doc.moveDown(0.6);
        doc
          .font("Helvetica-Bold")
          .fontSize(12)
          .fillColor(INK)
          .text(heading[1].toUpperCase(), {
            width: contentWidth,
            characterSpacing: 1.4,
            lineGap: 3,
          });
        doc.moveDown(0.2);
      } else if (bullet) {
        doc
          .font("Times-Roman")
          .fontSize(11.5)
          .fillColor(INK)
          .text(`·  ${bullet[1]}`, {
            width: contentWidth - 14,
            indent: 14,
            lineGap: 4,
          });
      } else {
        doc
          .font("Times-Roman")
          .fontSize(11.5)
          .fillColor(INK)
          .text(trimmed, { width: contentWidth, lineGap: 5 });
      }
    }
    doc.moveDown(0.8);
  }

  // --- Signature ---------------------------------------------------------------
  doc.moveDown(0.6);
  doc
    .font("Times-Roman")
    .fontSize(11.5)
    .fillColor(INK)
    .text("Warmly,", { width: contentWidth });
  doc.moveDown(0.2);
  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor(MUTED)
    .text("VICTORIA VASILYEVA", { width: contentWidth, characterSpacing: 1.8 });

  doc.end();
  const pdf = await done;
  return { pdf, unsupportedCharsStripped: strippedChars };
}
