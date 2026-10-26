/**
 * Text metrics and line breaking for the deck — **the single source of truth for
 * both the editor and the PDF exporter**.
 *
 * This module exists to close the classic failure of a WYSIWYG-over-PDF editor:
 * the editor wraps text using the browser's font metrics, the exporter wraps it
 * using the PDF's, the two disagree by a few percent, and the export silently
 * reflows — usually one word onto a new line, usually on the slide you cared
 * about. Nothing about the editor's rendering can prevent that; only sharing the
 * measurement can.
 *
 * So the deck measures with **pdf-lib's own metrics on both sides**. One
 * throwaway `PDFDocument` is created at startup purely to embed the standard-14
 * fonts and expose their `widthOfTextAtSize`; the stage lays out with it, the
 * exporter lays out with it, and the export is identical to the screen by
 * construction rather than by luck.
 *
 * The accepted cost is that a deck can use **only the standard-14 fonts**.
 * Arbitrary TTFs would need `@pdf-lib/fontkit`, a font-embedding UI, and would
 * reintroduce exactly the drift this avoids. On Linux, Helvetica/Times/Courier
 * resolve to the metric-compatible Nimbus and Liberation families, so the painted
 * glyphs match the measured advances too.
 */

import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { type FontFamily, type ListStyle, type TextStyle, customFontPath, fontKey } from "./model";

/** The 12 built-in faces: three families × regular/bold/italic/bold-italic. */
const FACES: Record<"sans" | "serif" | "mono", Record<string, StandardFonts>> = {
  sans: {
    r: StandardFonts.Helvetica,
    b: StandardFonts.HelveticaBold,
    i: StandardFonts.HelveticaOblique,
    bi: StandardFonts.HelveticaBoldOblique,
  },
  serif: {
    r: StandardFonts.TimesRoman,
    b: StandardFonts.TimesRomanBold,
    i: StandardFonts.TimesRomanItalic,
    bi: StandardFonts.TimesRomanBoldItalic,
  },
  mono: {
    r: StandardFonts.Courier,
    b: StandardFonts.CourierBold,
    i: StandardFonts.CourierOblique,
    bi: StandardFonts.CourierBoldOblique,
  },
};

/** Which of the four variants a style selects. */
export function faceKey(bold: boolean, italic: boolean): string {
  return bold && italic ? "bi" : bold ? "b" : italic ? "i" : "r";
}

/**
 * The pdf-lib standard font a style maps to — used by the exporter to embed.
 *
 * A *custom* family has no standard equivalent, so it falls back to `sans`: the
 * exporter asks this only after failing to find an embedded face, i.e. when the
 * font file could not be read. Substituting a face the reader can see beats
 * dropping the text.
 */
export function standardFontFor(style: {
  family: FontFamily;
  bold: boolean;
  italic: boolean;
}): StandardFonts {
  const family = typeof style.family === "string" ? style.family : "sans";
  return FACES[family][faceKey(style.bold, style.italic)];
}

export interface TextMetrics {
  /** Advance width of `text` at `size` points, in points. */
  width(text: string, style: MeasureStyle, size?: number): number;
  /** Ascender-to-descender height at `size` points. */
  height(style: MeasureStyle, size?: number): number;
  /**
   * Baseline offset from the top of a line, in points.
   *
   * The exporter needs this and the renderer does not: pdf-lib's `drawText`
   * positions a **baseline**, while CSS positions a line box. Without it every
   * exported line sits one ascender too high.
   */
  ascent(style: MeasureStyle, size?: number): number;
  /**
   * Make an embedded face available for measurement, keyed by its file path.
   *
   * **This is the single-source-of-truth rule made explicit.** A custom face can
   * only be measured here if these exact bytes are also what the export embeds,
   * so both sides key on the path and read the same map. Registering the same
   * path twice is a no-op; a file fontkit cannot parse resolves `false` and the
   * caller substitutes a standard face rather than laying out against one font
   * and drawing with another.
   */
  register(path: string, bytes: Uint8Array): Promise<boolean>;
  /** Whether a custom face is available under this path. */
  has(path: string): boolean;
}

export type MeasureStyle = Pick<TextStyle, "family" | "bold" | "italic" | "size">;

let cached: Promise<TextMetrics> | null = null;

/**
 * Embed the standard-14 faces once and expose their metrics.
 *
 * Memoized at module scope: the document exists only to own the font objects, is
 * never written, and building a second one per deck tab would be pure waste.
 * `fontkit` is registered on it so embedded faces measured through `register`
 * come from the same document as the built-ins.
 */
export function loadMetrics(): Promise<TextMetrics> {
  if (cached) return cached;
  cached = (async () => {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const fonts = new Map<string, PDFFont>();
    for (const family of Object.keys(FACES) as Array<"sans" | "serif" | "mono">) {
      for (const variant of Object.keys(FACES[family])) {
        fonts.set(`${family}-${variant}`, await doc.embedFont(FACES[family][variant]));
      }
    }
    const custom = new Map<string, PDFFont>();
    const failed = new Set<string>();

    const pick = (s: MeasureStyle): PDFFont => {
      const path = customFontPath(s.family);
      if (path) {
        const hit = custom.get(path);
        if (hit) return hit;
        // Not (yet) registered, or unreadable: fall through to the standard face
        // the exporter substitutes, so measurement and drawing still agree.
      }
      const family = typeof s.family === "string" ? s.family : "sans";
      return fonts.get(`${family}-${faceKey(s.bold, s.italic)}`) ?? fonts.get("sans-r")!;
    };

    return {
      width(text, style, size) {
        if (!text) return 0;
        try {
          return pick(style).widthOfTextAtSize(text, size ?? style.size);
        } catch {
          // A character outside WinAnsi throws rather than measuring. Falling
          // back to an em-based estimate keeps the layout sane instead of
          // collapsing the line to zero — the export will substitute the glyph
          // anyway, and a slightly wrong width beats a broken paragraph.
          return text.length * (size ?? style.size) * 0.5;
        }
      },
      height(style, size) {
        return pick(style).heightAtSize(size ?? style.size);
      },
      ascent(style, size) {
        // `descender: false` gives the ascent alone, which is exactly the drop
        // from a line box's top to its baseline.
        return pick(style).heightAtSize(size ?? style.size, { descender: false });
      },
      async register(path, bytes) {
        if (custom.has(path)) return true;
        if (failed.has(path)) return false;
        try {
          // `subset: false` — the metrics document is never written, and a subset
          // built from the text seen so far would measure a glyph it had not been
          // asked about yet as missing.
          custom.set(path, await doc.embedFont(bytes, { subset: false }));
          return true;
        } catch {
          failed.add(path);
          return false;
        }
      },
      has(path) {
        return custom.has(path);
      },
    };
  })();
  return cached;
}

/** A CSS `font-family` stack for a family, for the DOM renderer. A custom face
 *  is named by the `@font-face` the viewer installs (see `deckFonts.ts`). */
export function cssFontFor(family: FontFamily, stacks: Record<string, string>): string {
  const path = customFontPath(family);
  if (path) return `"${cssFontName(path)}", ${stacks.sans}`;
  return stacks[family as string] ?? stacks.sans;
}

/** The `@font-face` family name a custom font file is installed under. Derived
 *  from the path so the renderer and the installer cannot disagree. */
export function cssFontName(path: string): string {
  return `eldeck-${fontKey({ custom: path }).replace(/[^A-Za-z0-9]+/g, "-")}`;
}

// ---------------------------------------------------------------------------
// Encodability
// ---------------------------------------------------------------------------

/**
 * The characters a standard-14 face **cannot** write, in order, deduplicated.
 *
 * The standard-14 fonts are WinAnsi-encoded, so a Greek letter (`σ`, `μ`, `α`),
 * a CJK glyph or a maths symbol has no code point in them at all — and pdf-lib
 * *throws* rather than substituting. On screen none of this shows, because the
 * renderer uses CSS font stacks that will happily find a glyph somewhere; the
 * failure only appears at export, which for a talk means the night before.
 *
 * So both the exporter (as a per-object fallback) and the editor (as a
 * pre-export scan) ask this the same question, and the author learns at edit
 * time rather than at 23:00. The check is against the *encoding*, not the file:
 * whether a face happens to be installed is irrelevant to what a PDF can carry.
 *
 * See TODO V #120 for the real fix — embedding a real face via fontkit — which
 * this is deliberately not a substitute for, only a safety net under it.
 */
export function unencodableIn(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const ch of text) {
    if (isWinAnsi(ch) || seen.has(ch)) continue;
    seen.add(ch);
    out.push(ch);
  }
  return out;
}

/** True when every character of `text` can be written by a standard-14 face. */
export function encodableIn(text: string): boolean {
  for (const ch of text) if (!isWinAnsi(ch)) return false;
  return true;
}

/**
 * Drop every character a standard-14 face cannot write.
 *
 * Deliberately *drops* rather than substituting a `?`: the export already
 * carries a warning naming the object and the offending characters, and a line
 * of question marks reads as corruption rather than as the omission it is.
 */
export function toEncodable(text: string): string {
  let out = "";
  for (const ch of text) if (isWinAnsi(ch)) out += ch;
  return out;
}

/**
 * The 32 code points WinAnsi (CP1252) maps into the 0x80–0x9F range, which is
 * where it differs from Latin-1 and where the euro sign, the curly quotes and
 * the dashes people actually paste into slides live.
 */
const WIN_ANSI_HIGH = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160,
  0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

function isWinAnsi(ch: string): boolean {
  const c = ch.codePointAt(0);
  if (c == null) return true;
  // Tab and newline never reach `drawText` (the wrapper splits on them) and a
  // control character is not a glyph, so neither is worth reporting.
  if (c === 9 || c === 10 || c === 13) return true;
  if (c >= 0x20 && c <= 0x7e) return true;
  if (c >= 0xa0 && c <= 0xff) return true;
  return WIN_ANSI_HIGH.has(c);
}

// ---------------------------------------------------------------------------
// Line breaking
// ---------------------------------------------------------------------------

/** Gap between a list marker and its text, as a multiple of the font size. */
export const MARKER_GAP = 0.45;

export interface WrappedLine {
  text: string;
  /** The bullet/number, on the first visual line of a list item only. */
  marker?: string;
  /** Left inset for this line's text, in points. */
  indent: number;
  /** Measured advance width of `text`, in points. */
  width: number;
  /** Which source line (0-based) this came from — the build-step key for a
   *  staggered list reveal. */
  source: number;
}

/** The bullet/number a list line gets. Pure, and shared with the renderer so the
 *  editor and the export never spell an enumeration differently. */
export function listMarker(kind: ListStyle["kind"], index: number, start: number): string {
  const n = start + index;
  switch (kind) {
    case "number":
      return `${n}.`;
    case "alpha":
      // Wraps past 26 rather than going to "aa": a slide with 27 list items has
      // a bigger problem than its numbering.
      return `${String.fromCharCode(97 + ((n - 1) % 26))}.`;
    case "roman":
      return `${toRoman(n)}.`;
    default:
      return "•";
  }
}

const ROMAN: ReadonlyArray<readonly [number, string]> = [
  [1000, "m"],
  [900, "cm"],
  [500, "d"],
  [400, "cd"],
  [100, "c"],
  [90, "xc"],
  [50, "l"],
  [40, "xl"],
  [10, "x"],
  [9, "ix"],
  [5, "v"],
  [4, "iv"],
  [1, "i"],
];

function toRoman(n: number): string {
  let out = "";
  let left = Math.max(1, Math.floor(n));
  for (const [value, sym] of ROMAN) {
    while (left >= value) {
      out += sym;
      left -= value;
    }
  }
  return out;
}

/**
 * Break `text` to fit `width` points.
 *
 * Greedy word wrapping, which is what every slide tool does and what readers
 * expect; a Knuth–Plass optimum would be prettier and would also disagree with
 * every other renderer the author compares against.
 *
 * A word longer than the whole line is broken by character rather than allowed
 * to overflow — a pasted URL should look cramped, not spill off the slide.
 * Explicit newlines always break, and each becomes its own list item.
 */
export function wrapText(
  metrics: TextMetrics,
  text: string,
  style: MeasureStyle,
  width: number,
  list?: ListStyle,
): WrappedLine[] {
  const out: WrappedLine[] = [];
  const paragraphs = text.split("\n");
  const markerIndent = list
    ? Math.max(
        ...paragraphs.map((_p, i) =>
          metrics.width(listMarker(list.kind, i, list.start), style),
        ),
      ) + style.size * MARKER_GAP
    : 0;
  const avail = Math.max(1, width - markerIndent);

  paragraphs.forEach((para, pi) => {
    const marker = list ? listMarker(list.kind, pi, list.start) : undefined;
    const words = para.split(/(\s+)/).filter((w) => w !== "");
    let line = "";
    let first = true;

    const push = () => {
      out.push({
        text: line,
        ...(first && marker ? { marker } : {}),
        indent: markerIndent,
        width: metrics.width(line, style),
        source: pi,
      });
      first = false;
      line = "";
    };

    if (words.length === 0) {
      push();
      return;
    }

    for (const word of words) {
      const candidate = line + word;
      if (metrics.width(candidate, style) <= avail || line === "") {
        // A single word wider than the line must still be broken, or it spills.
        if (line === "" && metrics.width(word, style) > avail && !/^\s+$/.test(word)) {
          let chunk = "";
          for (const ch of word) {
            if (chunk && metrics.width(chunk + ch, style) > avail) {
              line = chunk;
              push();
              chunk = "";
            }
            chunk += ch;
          }
          line = chunk;
          continue;
        }
        line = candidate;
      } else {
        // Trailing whitespace never justifies a break of its own.
        line = line.replace(/\s+$/, "");
        push();
        line = /^\s+$/.test(word) ? "" : word;
      }
    }
    line = line.replace(/\s+$/, "");
    push();
  });

  return out;
}

/**
 * Where a line's text starts, in points from the box's left inner edge, honouring
 * alignment. Shared by the renderer and the exporter — a centred line that is
 * centred differently in the export is the same bug as a reflowed one.
 */
export function lineOffset(line: WrappedLine, style: TextStyle, width: number): number {
  const avail = width - line.indent;
  switch (style.align) {
    case "center":
      return line.indent + Math.max(0, (avail - line.width) / 2);
    case "right":
      return line.indent + Math.max(0, avail - line.width);
    default:
      return line.indent;
  }
}
