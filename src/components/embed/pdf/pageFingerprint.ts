/**
 * A cheap, content-derived fingerprint of one rendered PDF page.
 *
 * A LaTeX recompile rewrites the WHOLE output file even when one sentence
 * changed, so the viewer's reload had no way to tell "page 7 is different" from
 * "page 7 is byte-identical to what is already painted" — it simply repainted
 * every page on screen. Repainting is what the reader sees as the flash on every
 * build, and on a long document it is also seconds of rasterisation for pages
 * that end up pixel-identical.
 *
 * The fingerprint is taken from the page's OPERATOR LIST — the drawing
 * instructions pdf.js would execute to paint it — not from its extracted text.
 * Text alone would miss a redrawn figure, a moved rule, or a changed font; the
 * operator list is the actual paint program, so anything that would change a
 * pixel changes it too. The one thing it does not reach through is raster image
 * DATA (an image is referenced by object id and painted by `paintImageXObject`),
 * so a figure replaced by a different bitmap of identical size, drawn at an
 * identical position, can fingerprint the same. That is the deliberate limit of
 * this optimisation, and why {@link samePage} is only ever used to skip a
 * repaint of an ALREADY-PAINTED page — never to skip a first paint, and never to
 * decide anything the reader cannot fix with a zoom or a reopen.
 *
 * Cost: `getOperatorList()` is the parse half of rendering, which the render
 * would have done anyway; what a match saves is the rasterisation, the canvas
 * churn, and the flash. It runs only for pages near the viewport (the same ones
 * that would have been repainted).
 */

import type { PDFPageProxy } from "pdfjs-dist";

/** FNV-1a, 32-bit. Small, fast, and good enough to separate two versions of a
 *  page — this is a change DETECTOR, not a security digest. */
function mix(h: number, v: number): number {
  return Math.imul(h ^ (v >>> 0), 0x01000193) >>> 0;
}

function mixString(h: number, s: string): number {
  // Long strings (a font program name, an inline data blob) are sampled rather
  // than walked: length + a bounded prefix separates realistic variants without
  // making the hash the expensive part of a build.
  const n = Math.min(s.length, 256);
  let out = mix(h, s.length);
  for (let i = 0; i < n; i++) out = mix(out, s.charCodeAt(i));
  return out;
}

function mixNumber(h: number, v: number): number {
  if (!Number.isFinite(v)) return mix(h, 0x7ff);
  // Quantise to a thousandth of a big point: far below anything visible at any
  // zoom, but coarse enough that a compiler's float noise is not a "change".
  return mix(h, Math.round(v * 1000));
}

/** Elements of one operator's argument array to walk before summarising the
 *  rest by length. Glyph runs are the long case and stay well under this. */
const MAX_ELEMS = 512;

/**
 * pdf.js names a font — and a cached image or Type3 glyph — after the DOCUMENT
 * that loaded it: `g_d3_f2` is the second font document load 3 met. Both numbers
 * are new on a reload (every `getDocument` is the next `d<n>`, and fonts are
 * numbered in the order pages happened to be parsed), so hashing the name made
 * every text page of a recompiled PDF look changed and the quiet reload repaint
 * all of them. Such a name is hashed as the order it first appears in on this
 * page instead: the same page draws its fonts in the same order whatever the
 * load called them, and a page that switches fonts still changes the order.
 */
const DOC_SCOPED_NAME = /^g_d\d+_/;

/** Per-page numbering of the document-scoped names one fingerprint met. */
type NameOrder = Map<string, number>;

function mixName(h: number, name: string, names: NameOrder): number {
  let n = names.get(name);
  if (n === undefined) names.set(name, (n = names.size));
  return mix(mix(h, 0x6e), n);
}

function mixValue(h: number, v: unknown, depth: number, names: NameOrder): number {
  if (v == null) return mix(h, 1);
  switch (typeof v) {
    case "number":
      return mixNumber(h, v);
    case "string":
      return DOC_SCOPED_NAME.test(v) ? mixName(h, v, names) : mixString(h, v);
    case "boolean":
      return mix(h, v ? 2 : 3);
    case "object":
      break;
    default:
      return mix(h, 4);
  }
  if (ArrayBuffer.isView(v)) {
    // Typed arrays are transform matrices, glyph widths, inline image bytes.
    const arr = v as unknown as ArrayLike<number>;
    let out = mix(h, arr.length);
    const n = Math.min(arr.length, MAX_ELEMS);
    for (let i = 0; i < n; i++) out = mixNumber(out, arr[i]);
    return out;
  }
  if (Array.isArray(v)) {
    let out = mix(h, v.length);
    if (depth <= 0) return out;
    const n = Math.min(v.length, MAX_ELEMS);
    for (let i = 0; i < n; i++) out = mixValue(out, v[i], depth - 1, names);
    return out;
  }
  const o = v as Record<string, unknown>;
  // pdf.js hands `showText` an array of Glyph objects — the page's actual words.
  // Hashing the character and its advance is the whole of what a reader would
  // see change, and skips the dozen bookkeeping fields a Glyph also carries.
  if (typeof o.unicode === "string" || typeof o.fontChar === "string") {
    let out = mixString(h, String(o.unicode ?? ""));
    out = mixString(out, String(o.fontChar ?? ""));
    return mixNumber(out, typeof o.width === "number" ? o.width : 0);
  }
  if (depth <= 0) return mix(h, 5);
  // Any other object (a pattern, a dash spec): its own keys, in a stable order.
  let out = h;
  const keys = Object.keys(o).sort().slice(0, 32);
  for (const k of keys) {
    out = mixString(out, k);
    out = mixValue(out, o[k], depth - 1, names);
  }
  return out;
}

/** What one page painted, as an opaque token. Equal tokens mean the page draws
 *  the same thing (see the caveat about raster image data at the top). */
export type PageFingerprint = string;

/**
 * Fingerprint what `page` would paint. `rot` is the viewer's extra turn, folded
 * in so a rotated sheet never matches its unrotated self.
 *
 * Returns `null` when the page cannot be summarised (a pdf.js error, a page
 * still being written by the compiler). A null fingerprint never compares equal
 * to anything, so the caller falls back to painting — the safe direction.
 */
export async function fingerprintPage(
  page: PDFPageProxy,
  rot = 0,
): Promise<PageFingerprint | null> {
  try {
    const vp = page.getViewport({ scale: 1, rotation: (((page.rotate + rot) % 360) + 360) % 360 });
    let h = 0x811c9dc5;
    h = mixNumber(h, vp.width);
    h = mixNumber(h, vp.height);
    h = mix(h, ((page.rotate + rot) % 360) + 360);
    const ops = await page.getOperatorList();
    const fns = ops.fnArray as ArrayLike<number>;
    const args = ops.argsArray as ArrayLike<unknown>;
    h = mix(h, fns.length);
    for (let i = 0; i < fns.length; i++) h = mix(h, fns[i]);
    const names: NameOrder = new Map();
    for (let i = 0; i < args.length; i++) h = mixValue(h, args[i], 3, names);
    return `${fns.length}:${h.toString(16)}`;
  } catch {
    return null;
  }
}

/**
 * Whether a repaint can be skipped: both fingerprints exist and agree. A null
 * on either side (never painted, or a page that could not be summarised) is
 * always "different", so the caller paints.
 */
export function samePage(
  a: PageFingerprint | null | undefined,
  b: PageFingerprint | null | undefined,
): boolean {
  return a != null && b != null && a === b;
}
