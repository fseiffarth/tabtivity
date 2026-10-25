/**
 * Flattening a deck into a PDF — **the only place a deck is written as a PDF**,
 * mirroring the rule `pdf/pdfDoc.ts` already keeps for the PDF viewer.
 *
 * Three things make the export trustworthy rather than approximate:
 *
 * **It lays text out with the same metrics the editor did.** `deck/fonts.ts` is
 * shared, so a paragraph breaks into identical lines here and on screen. That is
 * the whole reason the deck is limited to the standard-14 fonts.
 *
 * **All geometry goes through `deck/transform.ts`.** The normalized-y-down →
 * points-y-up flip and the rotate-about-centre anchor are written once, tested,
 * and never re-derived inline.
 *
 * **Every drawing primitive is `drawSvgPath`, `drawText` or `drawImage`.** Shapes
 * and icons are already path data for exactly this reason — one geometry source
 * for the stage and the page.
 *
 * The caller supplies bytes, not paths: this module never touches the
 * filesystem, so it stays testable and works identically for a local project and
 * a remote one.
 */

import { translate, useI18nStore, translateNow } from "../../i18n";
import {
  PDFDocument,
  degrees,
  rgb,
  type PDFFont,
  type PDFPage,
  type PDFImage,
} from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { type Deck, type DeckObject, customFontPath, footerObject, slidePageBox } from "./model";
import {
  type TextMetrics,
  lineOffset,
  standardFontFor,
  toEncodable,
  unencodableIn,
  wrapText,
} from "./fonts";
import { ICON_VIEWBOX, iconByKey } from "./icons";
import { arrowHeadPath, isClosedShape, lineAngle, shapePath } from "./shapes";
import { fitSquare, parseColor, pdfPlacement, toPdfRect } from "./transform";

export interface ExportInputs {
  deck: Deck;
  /**
   * Pristine bytes of the base PDF, or null for a deck with no plate.
   *
   * Pristine matters: pdf.js *detaches* the buffer it renders from, so these must
   * be a separate copy — the same trap `pdf/pdfDoc.ts` documents.
   */
  baseBytes: Uint8Array | null;
  /** Deck-relative image `src` → its file bytes (PNG or JPEG). */
  images: ReadonlyMap<string, Uint8Array>;
  /**
   * Interstitial id → PNG bytes of its poster frame.
   *
   * A GIF cannot be a PDF page, so an interstitial exports as a still. Encoding
   * that still needs a canvas, which is the caller's business, not this module's.
   */
  posters: ReadonlyMap<string, Uint8Array>;
  metrics: TextMetrics;
  /**
   * Custom font path → the file's bytes.
   *
   * **The same bytes `metrics.register` was given.** That is the whole contract
   * of `fonts.ts`: if the exporter embedded a different file from the one the
   * layout was measured against, the export would reflow — the exact failure the
   * shared-metrics design exists to prevent (TODO V #120). A path missing here
   * falls back to the standard face, with a warning, rather than drawing text
   * laid out for a font that is not in the document.
   */
  fonts?: ReadonlyMap<string, Uint8Array>;
}

export interface ExportResult {
  bytes: Uint8Array;
  /** Pages written. */
  pages: number;
  /** Things that could not be drawn, in plain words, for the caller to surface. */
  warnings: string[];
}

/** PNG and JPEG magic numbers — pdf-lib needs to be told which embedder to use. */
function imageKind(bytes: Uint8Array): "png" | "jpg" | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return "png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
  return null;
}

const color = (hex: string | undefined, fallback?: { r: number; g: number; b: number }) => {
  const c = parseColor(hex);
  if (!c) return fallback ? rgb(fallback.r, fallback.g, fallback.b) : undefined;
  return rgb(c.r, c.g, c.b);
};

/** Opacity carried separately: pdf-lib takes it as its own option, not in the colour. */
const alphaOf = (hex: string | undefined): number => parseColor(hex)?.a ?? 1;

export async function exportDeck(input: ExportInputs): Promise<ExportResult> {
  const { deck, baseBytes, images, posters, metrics, fonts: fontBytes } = input;
  const warnings: string[] = [];
  const out = await PDFDocument.create();
  // Needed before any `embedFont(bytes)`; harmless for a deck that uses none.
  out.registerFontkit(fontkit);

  // --- base plate --------------------------------------------------------
  // Copy the pages the slides point at, in slide order, so a reordered deck
  // exports reordered. One `copyPages` call for the whole set, so shared fonts
  // and images cross once rather than per page.
  // A slide marked `skip` is in the deck but not in the talk (#106), so it is
  // not in the handout either. Resolved once, up front, because the base-page
  // copy and the slide loop must agree on which slides exist or every page after
  // the first skipped one draws the wrong layers.
  const slides = deck.slides.filter((s) => !s.skip);

  let copied: PDFPage[] = [];
  if (baseBytes) {
    try {
      const src = await PDFDocument.load(baseBytes);
      const wanted = slides.map((s) => Math.min(src.getPageCount(), Math.max(1, s.anchor.page)) - 1);
      copied = await out.copyPages(src, wanted);
    } catch (e) {
      warnings.push(`The base PDF could not be read, so slides export blank (${String(e)}).`);
    }
  }

  // Fonts are embedded lazily and cached: a deck using one face must not carry
  // twelve.
  const fontCache = new Map<string, PDFFont>();
  const fontFor = async (o: Extract<DeckObject, { kind: "text" }>): Promise<PDFFont> => {
    const path = customFontPath(o.style.family);
    if (path) {
      const hit = fontCache.get(`custom:${path}`);
      if (hit) return hit;
      const bytes = fontBytes?.get(path);
      if (bytes) {
        try {
          const f = await out.embedFont(bytes);
          fontCache.set(`custom:${path}`, f);
          return f;
        } catch (e) {
          warnings.push(`Font "${path}" could not be embedded (${String(e)}); Helvetica was used.`);
        }
      } else {
        warnings.push(`Font "${path}" was not available; Helvetica was used instead.`);
      }
      // Fall through to the standard face — which is exactly what `fonts.ts`
      // measured with too, since `register` failed there for the same reason.
    }
    const std = standardFontFor(o.style);
    const hit = fontCache.get(std);
    if (hit) return hit;
    const f = await out.embedFont(std);
    fontCache.set(std, f);
    return f;
  };

  const imageCache = new Map<string, PDFImage | null>();
  const imageFor = async (src: string): Promise<PDFImage | null> => {
    if (imageCache.has(src)) return imageCache.get(src) ?? null;
    const bytes = images.get(src);
    let embedded: PDFImage | null = null;
    if (!bytes) {
      warnings.push(`Image "${src}" was not available and is missing from the export.`);
    } else {
      const kind = imageKind(bytes);
      try {
        if (kind === "png") embedded = await out.embedPng(bytes);
        else if (kind === "jpg") embedded = await out.embedJpg(bytes);
        else warnings.push(`Image "${src}" is not a PNG or JPEG; PDF can embed neither.`);
      } catch (e) {
        warnings.push(`Image "${src}" could not be embedded (${String(e)}).`);
      }
    }
    imageCache.set(src, embedded);
    return embedded;
  };

  // --- slides ------------------------------------------------------------
  for (let i = 0; i < slides.length; i += 1) {
    const slide = slides[i];
    const box = slidePageBox(deck, slide);
    const page = copied[i] ? out.addPage(copied[i]) : out.addPage([box.width, box.height]);
    const { width: pw, height: ph } = page.getSize();

    for (const obj of slide.objects) {
      if (obj.hidden) continue;
      await drawObject(page, obj, pw, ph, { fontFor, imageFor, metrics, warnings });
    }

    // The deck-wide footer, drawn last so it sits over the layers, and through
    // the ordinary text path so it cannot look different from the screen (#117).
    const footer = footerObject(deck, i, slides.length, box.height);
    if (footer) await drawObject(page, footer, pw, ph, { fontFor, imageFor, metrics, warnings });

    // --- the interstitial that follows this slide ---
    if (slide.after && deck.theme.exportInterstitials) {
      const png = posters.get(slide.after.id);
      const poster = out.addPage([pw, ph]);
      const bg = parseColor(slide.after.background) ?? { r: 0, g: 0, b: 0, a: 1 };
      poster.drawRectangle({ x: 0, y: 0, width: pw, height: ph, color: rgb(bg.r, bg.g, bg.b) });
      if (png) {
        try {
          const img = await out.embedPng(png);
          // `contain`: the poster is evidence of what played, so it must not be
          // cropped even when the interstitial itself was set to `cover`.
          const scale = Math.min(pw / img.width, ph / img.height);
          const w = img.width * scale;
          const h = img.height * scale;
          poster.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
        } catch (e) {
          warnings.push(`The poster frame for an animation could not be embedded (${String(e)}).`);
        }
      } else {
        warnings.push(
          `An animation had no poster frame, so its page in the export is blank.`,
        );
      }
    }
  }

  if (out.getPageCount() === 0) {
    // pdf-lib refuses to save a document with no pages, and a deck with no
    // slides should produce an empty-looking PDF rather than an exception.
    out.addPage([deck.pageWidth, deck.pageHeight]);
    warnings.push(translateNow("deckExport.noSlides"));
  }

  return { bytes: await out.save(), pages: out.getPageCount(), warnings };
}

interface DrawCtx {
  fontFor: (o: Extract<DeckObject, { kind: "text" }>) => Promise<PDFFont>;
  imageFor: (src: string) => Promise<PDFImage | null>;
  metrics: TextMetrics;
  warnings: string[];
}

async function drawObject(
  page: PDFPage,
  obj: DeckObject,
  pw: number,
  ph: number,
  ctx: DrawCtx,
): Promise<void> {
  const rect = toPdfRect(obj, pw, ph);

  switch (obj.kind) {
    case "shape": {
      const sw = obj.strokeWidth;
      // Same half-stroke inset the stage uses, so a stroked edge sits inside the
      // box in both places and a snapped edge stays snapped.
      const iw = Math.max(0, rect.w - sw);
      const ih = Math.max(0, rect.h - sw);
      const place = pdfPlacement(rect, obj.rot, sw / 2, sw / 2);
      const fill = isClosedShape(obj.shape) ? color(obj.fill) : undefined;
      page.drawSvgPath(shapePath(obj.shape, iw, ih, obj.radius ?? 0.12), {
        x: place.x,
        y: place.y,
        rotate: degrees(place.rotate),
        borderColor: color(obj.stroke, { r: 0, g: 0, b: 0 }),
        borderWidth: sw,
        borderOpacity: obj.opacity,
        ...(fill ? { color: fill, opacity: obj.opacity * alphaOf(obj.fill) } : {}),
      });
      const angle = lineAngle(iw, ih);
      for (const [head, hx, hy, a] of [
        [obj.head, iw, ih, angle],
        [obj.tail, 0, 0, angle + Math.PI],
      ] as const) {
        if (!head || head === "none") continue;
        page.drawSvgPath(arrowHeadPath(head, hx, hy, a, sw), {
          x: place.x,
          y: place.y,
          rotate: degrees(place.rotate),
          color: color(obj.stroke, { r: 0, g: 0, b: 0 }),
          opacity: obj.opacity,
          borderColor: color(obj.stroke, { r: 0, g: 0, b: 0 }),
          borderWidth: sw,
          borderOpacity: obj.opacity,
        });
      }
      return;
    }

    case "icon": {
      const def = iconByKey(obj.icon);
      if (!def) {
        ctx.warnings.push(`Icon "${obj.icon}" is not in this build's library and was skipped.`);
        return;
      }
      const { scale, offsetX, offsetY } = fitSquare(rect, ICON_VIEWBOX);
      // The glyph's own rotation composes with the object's: both turn about the
      // same centre, because the glyph box is centred in the object box.
      const place = pdfPlacement(rect, obj.rot + (def.rotate ?? 0), offsetX, offsetY);
      for (const d of def.paths) {
        page.drawSvgPath(d, {
          x: place.x,
          y: place.y,
          scale,
          rotate: degrees(place.rotate),
          ...(def.filled
            ? { color: color(obj.color, { r: 0, g: 0, b: 0 }), opacity: obj.opacity }
            : {
                borderColor: color(obj.color, { r: 0, g: 0, b: 0 }),
                // Stroke width is in points and `scale` multiplies it, so divide
                // it back out to keep the drawn weight the author chose.
                borderWidth: obj.strokeWidth / (scale || 1),
                borderOpacity: obj.opacity,
              }),
        });
      }
      return;
    }

    case "image": {
      const img = await ctx.imageFor(obj.src);
      if (!img) return;
      // Reproduce `object-fit`. `cover` would need a clip path, which pdf-lib
      // does not expose — so it degrades to `contain` and says so, rather than
      // silently overflowing the box across the rest of the slide.
      let w = rect.w;
      let h = rect.h;
      let dx = 0;
      let dy = 0;
      if (obj.fit !== "stretch") {
        if (obj.fit === "cover") {
          ctx.warnings.push(
            `Image "${obj.src}" uses "cover", which PDF cannot crop; it was fitted instead.`,
          );
        }
        const s = Math.min(rect.w / img.width, rect.h / img.height);
        w = img.width * s;
        h = img.height * s;
        dx = (rect.w - w) / 2;
        dy = (rect.h - h) / 2;
      }
      const place = pdfPlacement(rect, obj.rot, dx, dy + h);
      page.drawImage(img, {
        x: place.x,
        y: place.y,
        width: w,
        height: h,
        rotate: degrees(place.rotate),
        opacity: obj.opacity,
      });
      return;
    }

    case "text": {
      const font = await ctx.fontFor(obj);
      const s = obj.style;
      const pad = obj.padding;

      if (obj.fill) {
        const place = pdfPlacement(rect, obj.rot, 0, rect.h);
        page.drawRectangle({
          x: place.x,
          y: place.y,
          width: rect.w,
          height: rect.h,
          rotate: degrees(place.rotate),
          color: color(obj.fill),
          opacity: obj.opacity * alphaOf(obj.fill),
          ...(obj.stroke
            ? {
                borderColor: color(obj.stroke),
                borderWidth: obj.strokeWidth ?? 1,
                borderOpacity: obj.opacity,
              }
            : {}),
        });
      }

      const inner = Math.max(1, rect.w - pad * 2);
      const lines = wrapText(ctx.metrics, obj.text, s, inner, obj.list);
      const lineH = s.size * s.lineHeight;
      const ascent = ctx.metrics.ascent(s);
      const textColor = color(s.color, { r: 0, g: 0, b: 0 })!;

      /**
       * Write one run, surviving a character the face cannot encode.
       *
       * The standard-14 fonts are WinAnsi, so a Greek letter or a CJK glyph makes
       * pdf-lib *throw* — which, uncaught, took the whole export down with a raw
       * error and no partial PDF. It renders fine on screen (CSS font stacks), so
       * the first anyone learned of it was the export, the night before the talk.
       * Falling back to the encodable subset keeps the other twenty slides, and
       * the warning names the object and the exact characters so the author can
       * fix the one that matters.
       */
      const write = (text: string, x: number, y: number, rotate: number) => {
        try {
          page.drawText(text, {
            x,
            y,
            size: s.size,
            font,
            color: textColor,
            opacity: obj.opacity,
            rotate: degrees(rotate),
          });
        } catch {
          const embedded = customFontPath(s.family) != null;
          const bad = unencodableIn(text);
          const safe = toEncodable(text);
          const lang = useI18nStore.getState().lang;
          ctx.warnings.push(
            translate(
              lang,
              bad.length === 1
                ? "deckExport.unencodableTextOne"
                : "deckExport.unencodableText",
              {
                text: preview(obj.text),
                chars: bad.length
                  ? bad.map((c) => `"${c}"`).join(", ")
                  : translate(lang, "deckExport.unencodableCharsWord"),
                why: translate(
                  lang,
                  embedded ? "deckExport.whyNoGlyphs" : "deckExport.whyBuiltinFont",
                ),
              },
            ),
          );
          if (!safe) return;
          try {
            page.drawText(safe, {
              x,
              y,
              size: s.size,
              font,
              color: textColor,
              opacity: obj.opacity,
              rotate: degrees(rotate),
            });
          } catch {
            // Nothing left to salvage on this line; the warning already said so.
          }
        }
      };

      lines.forEach((line, i) => {
        // `drawText` positions a BASELINE; the wrap positions line BOXES. The
        // ascent is the drop between them — without it every line sits high.
        const baseline = pad + i * lineH + ascent;
        if (line.marker) {
          const mp = pdfPlacement(rect, obj.rot, pad, baseline);
          write(line.marker, mp.x, mp.y, mp.rotate);
        }
        if (!line.text) return;
        const p = pdfPlacement(rect, obj.rot, pad + lineOffset(line, s, inner), baseline);
        write(line.text, p.x, p.y, p.rotate);
      });
      return;
    }
  }
}

/** A short, single-line excerpt of an object's text, for naming it in a warning. */
function preview(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > 40 ? `${one.slice(0, 40)}…` : one;
}

/** The export's default filename: `talk.eldeck.json` → `talk.export.pdf`. */
export function exportPathFor(deckPath: string): string {
  return `${deckPath.replace(/\.eldeck\.json$/i, "")}.export.pdf`;
}
