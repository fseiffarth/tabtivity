// Frontend-only print pipeline for the in-app file viewers.
//
// The strategy is deliberately dependency-free: instead of generating a PDF on
// disk, each viewer renders the content it already has into a clean, paginated
// standalone HTML document, which we drop into an off-screen iframe and hand to
// the platform's own `window.print()`. The native (GTK/WebKit) print dialog then
// lets the user send it to a printer OR "Print to File → PDF" — so for plain text
// and Markdown this *is* the "transform to PDF before printing" step, with no
// backend and no new dependency.
//
// WebKitGTK has no built-in PDF engine (that's why the app renders PDFs with
// pdf.js onto <canvas>), so a PDF can't be printed by feeding the file to an
// iframe. `renderPdfToPrintImages` re-renders the already-open pages to images
// which then print through the same path as everything else.

import { createElement } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { translate, useI18nStore } from "../i18n";
import { isUntested, type UntestedId } from "../untested";
import { initialPages, isPristine, type PageList } from "./pageModel";
import {
  mountPageStrip,
  type MountedPageStrip,
} from "../../components/common/mountPageStrip";
import type { PageStripProps } from "../../components/common/PageStrip";
import {
  followPrintJob,
  printSnapshot,
  JOB_APPEAR_TIMEOUT_MS,
  type NativePdfPrint,
  type PrintProgress,
} from "../window/printing";
import type { PrintSnapshot } from "../../types/printing";
import { storageKey as brandStorageKey } from "../brand";

// ── Print options ────────────────────────────────────────────────────────────
// The preview overlay exposes the options a printer dialog normally would. They
// are applied by injecting one stylesheet into the *already-loaded* preview
// document (see `printDocument`) rather than by rebuilding it: the HTML/SVG/CSS
// viewer prints a document Tabtivity did not assemble (`buildPreviewDoc`), and an
// injected sheet reaches that one too — and never costs an iframe reload.

export type PaperSize = "A4" | "Letter" | "Legal" | "A3" | "A5";
export type Orientation = "portrait" | "landscape";
export type MarginPreset = "none" | "narrow" | "normal" | "wide";
export type PageSelection = "all" | "odd" | "even" | "custom";

export interface PrintOptions {
  paper: PaperSize;
  orientation: Orientation;
  margin: MarginPreset;
  /** Percent; the printer-dialog "Scale" equivalent. */
  scale: number;
  pages: PageSelection;
  /** Custom page spec, e.g. "1-3, 5". Only read when `pages === "custom"`. */
  range: string;
  grayscale: boolean;
  /** Print background colors/images (off saves ink). */
  background: boolean;
  /** Footer page numbers; only possible on page-based documents (see below). */
  pageNumbers: boolean;
  /** How many times the whole job prints, collated (1-2-3, 1-2-3). Per job, like
   *  the page selection — see `loadPrintOptions`. */
  copies: number;
}

/** Paper dimensions in cm, portrait (width × height). */
export const PAPER_CM: Record<PaperSize, readonly [number, number]> = {
  A3: [29.7, 42],
  A4: [21, 29.7],
  A5: [14.8, 21],
  Letter: [21.59, 27.94],
  Legal: [21.59, 35.56],
};

/** Margin presets in cm. `normal` matches the padding the viewers hardcoded. */
export const MARGIN_CM: Record<MarginPreset, number> = {
  none: 0,
  narrow: 1.27,
  normal: 2.54,
  wide: 3.81,
};

export const SCALE_CHOICES = [50, 75, 90, 100, 110, 125, 150, 200] as const;

export const DEFAULT_PRINT_OPTIONS: PrintOptions = {
  paper: "A4",
  orientation: "portrait",
  margin: "normal",
  scale: 100,
  pages: "all",
  range: "",
  grayscale: false,
  background: true,
  pageNumbers: false,
  copies: 1,
};

/** The most copies one job asks for — a typo of 1000 should not feed a printer. */
export const MAX_COPIES = 99;

/** Sheet box in cm for the chosen paper + orientation (landscape swaps them). */
export function pageBoxCm(opts: PrintOptions): [number, number] {
  const [w, h] = PAPER_CM[opts.paper] ?? PAPER_CM.A4;
  return opts.orientation === "landscape" ? [h, w] : [w, h];
}

/** The printable box in cm: the sheet minus the margin on each side. */
export function contentBoxCm(opts: PrintOptions): [number, number] {
  const [w, h] = pageBoxCm(opts);
  const m = MARGIN_CM[opts.margin] ?? MARGIN_CM.normal;
  return [round2(Math.max(1, w - 2 * m)), round2(Math.max(1, h - 2 * m))];
}

/**
 * Thumbnail box in px for the strip, in the sheet's own proportions — so a
 * landscape sheet gets a landscape card rather than an upright one. Height is
 * fixed so the strip keeps a single row height; the width follows the aspect.
 */
export function thumbSizePx(opts: PrintOptions, height = 84): [number, number] {
  const [w, h] = pageBoxCm(opts);
  return [Math.round((height * w) / h), height];
}

/**
 * Parse a printer-style page spec ("1-3, 5", "2 4", "7-") against a known page
 * count. Deliberately tolerant — it runs on every keystroke of the range input,
 * so garbage is dropped rather than thrown. Result is clamped to 1..total,
 * deduped and sorted.
 */
export function parsePageRange(spec: string, total: number): number[] {
  const pages = new Set<number>();
  if (total <= 0) return [];
  for (const part of spec.split(/[,;\s]+/)) {
    if (!part) continue;
    const m = /^(\d*)(-?)(\d*)$/.exec(part);
    if (!m || (!m[1] && !m[3])) continue;
    const open = m[2] === "-";
    let lo = m[1] ? Number(m[1]) : open ? 1 : NaN;
    let hi = open ? (m[3] ? Number(m[3]) : total) : lo;
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
    if (lo > hi) [lo, hi] = [hi, lo];
    for (let p = Math.max(1, lo); p <= Math.min(total, hi); p++) pages.add(p);
  }
  return [...pages].sort((a, b) => a - b);
}

/** The 1-based pages the current options select out of `total`. */
export function selectedPages(opts: PrintOptions, total: number): number[] {
  if (total <= 0) return [];
  const all = Array.from({ length: total }, (_, i) => i + 1);
  switch (opts.pages) {
    case "odd":
      return all.filter((p) => p % 2 === 1);
    case "even":
      return all.filter((p) => p % 2 === 0);
    case "custom":
      return parsePageRange(opts.range, total);
    default:
      return all;
  }
}

// ── Page arrangement ─────────────────────────────────────────────────────────
// The arrangement itself lives in `lib/viewers/pageModel` — the same model the PDF
// viewer's page rail edits, so reordering/deleting/turning pages behaves identically
// in both places. Only the *print* reading of it belongs here.

/**
 * The sheets that will actually print, in print order: the arrangement, filtered by
 * the page selection. The selection counts *positions* in the current arrangement
 * (so "1-3" means the first three sheets as shown), which is the only reading that
 * stays meaningful once pages have been moved.
 */
export function printSequence(pages: PageList, opts: PrintOptions): PageList {
  const positions = new Set(selectedPages(opts, pages.length));
  return pages.filter((_, i) => positions.has(i + 1));
}

/**
 * The print order with every copy spelled out, collated: each copy is the whole
 * sequence, so a stack comes off the printer ready to hand out rather than as
 * piles of page 1, page 2… to sort by hand.
 */
export function withCopies<T>(sequence: readonly T[], copies: number): T[] {
  const n = clampCopies(copies);
  return Array.from({ length: n }, () => sequence).flat();
}

/**
 * The stylesheet the options translate to, injected last into the print
 * document so it overrides both the `buildPrintDoc` base and the caller's CSS.
 *
 * Margins are body padding and scale is `zoom` — NOT `@page{margin}` — because
 * WebKitGTK does not implement the `@page` margin box (same reason the viewer
 * stylesheets below set `body{padding}`; a bare `@page` margin prints
 * edge-to-edge). On screen the sheet must stay true size while the content
 * scales inside it (that is what a printer's scale does), so the sheet box is
 * divided by the zoom factor, which then multiplies it back. That is the
 * flowing document's arrangement; a paged one takes its page box from the
 * engine and scales the image instead (see the paged block).
 *
 * `paged` says the document is built out of `.print-page` sheets (the PDF and
 * image viewers) rather than flowing text, which changes where the margins live
 * and gives each sheet a real page box to fill — see the block below.
 */
export function buildOptionsCss(opts: PrintOptions, paged = false): string {
  const [w, h] = pageBoxCm(opts);
  const pad = MARGIN_CM[opts.margin] ?? MARGIN_CM.normal;
  const scale = clampScale(opts.scale);
  const zoom = scale / 100;
  const sheetW = round2(w / zoom);
  const sheetH = round2(h / zoom);

  const css = [
    `@page{size:${w}cm ${h}cm;margin:0}`,
    // A flowing document takes its margins from the body; a paged one cannot
    // (see the paged block) and carries them on the sheets instead.
    `body{margin:0;padding:${paged ? 0 : pad}cm;zoom:${zoom};background:#fff}`,
    ".app-print-hidden{display:none!important}",
    // Where a flowing document's next copy starts (see `printDocument`): a new
    // sheet on paper, a visible seam on screen.
    ".app-copy-break{break-before:page;page-break-before:always;height:0}" +
      "@media screen{.app-copy-break{margin:1cm 0;border-top:2px dashed #999}}",
    // Screen-only: show the actual sheet on a backdrop, so the preview is WYSIWYG.
    `@media screen{html{background:#3f4245;padding:18px 0}` +
      `body{width:${sheetW}cm;min-height:${sheetH}cm;margin:0 auto;` +
      `box-shadow:0 2px 12px rgba(0,0,0,.45)}}`,
  ];

  if (opts.grayscale) css.push(`body{filter:grayscale(1)}`);

  if (opts.background) {
    css.push(`body,body *{-webkit-print-color-adjust:exact;print-color-adjust:exact}`);
  } else {
    // Scoped to body's descendants so the sheet itself keeps its white/shadow —
    // and a `.print-page` IS a sheet (a paged document's paper on screen), so it
    // keeps its own too.
    css.push(
      `body *:not(.print-page){background:transparent!important;` +
        `background-image:none!important;box-shadow:none!important}`,
    );
  }

  if (paged) {
    // A sheet IS a page: give `.print-page` the whole page box and let the image
    // fill whatever the margins leave. Without the box the image printed at
    // whatever size its raster happened to be — a page rasterised at 2× is ~2000
    // CSS px, which `max-width:100%` then shrank to the *width* of the margin box
    // and left standing at the top of the sheet, so an A4 page came out around
    // three quarters of A4 with a band of white under it.
    //
    // The page box is taken from the ENGINE, never computed from the paper:
    // `html,body{height:100%}` resolves against the page box in print, and the
    // sheet is 100% of that. It used to be `<paper height − 0.05cm>`, and that
    // printed every second page BLANK: measured headlessly (an offscreen
    // WebKitGTK 2.52 WebView printing to PDF; A4; 0, 6.35 and 12.7 mm printer
    // margins), the page box is 27.84 cm of CSS height for 29.7 cm of paper — WebKitGTK hands
    // WebCore the paper in points and lays out at 1.25× (its shrink-to-fit
    // minimum), so a CSS centimetre lands on paper as 1.066 cm and a sheet sized
    // from the paper always overflows it by ~2 cm, spilling into a blank sheet
    // after every page. Three sheets printed six pages; at 100% they print three.
    // `100vh` is NOT an alternative — it resolves to 0 in this engine's print
    // layout (measured in the same run).
    //
    // The margins cannot be body padding here the way they are for a flowing
    // document: in paged media the block-direction padding of a fragmented box is
    // applied to its first and last fragment only, so body padding indents the
    // top of sheet 1 and the bottom of sheet n and leaves every sheet between them
    // printing flush to the paper edge. Padding on the sheet element repeats on
    // every sheet, each one being a box of its own.
    //
    // Scale is the image's cap, not `zoom` on the body: a zoomed body would make
    // the sheet's 100% mean 100% of a scaled box, and at `margin: none` the old
    // zoom changed nothing at all (the image was capped by the sheet, which zoom
    // multiplied straight back to paper size). An image capped at `scale%` of the
    // printable box prints at that fraction of it, which is what a printer's
    // scale does — and the preview shows the same fraction, since the sheet on
    // screen is the same box at the paper's true size.
    css.push(
      `html,body{height:100%}body{zoom:1}` +
        `.print-page{position:relative;box-sizing:border-box;height:100%;` +
        `padding:${pad}cm;display:flex;align-items:center;justify-content:center;` +
        `overflow:hidden;container-type:size}` +
        // Capped on BOTH axes, sized on neither: the binding axis decides, so the
        // page prints as large as its margins allow whatever its aspect is.
        `.print-page>img{width:auto;height:auto;max-width:${scale}%;max-height:${scale}%}` +
        // Screen-only: the preview is a stack of paper sheets on the backdrop, each
        // at the paper's true size with a gap and its own shadow — so where one
        // page ends and the next begins is visible, which is the one thing this
        // preview exists to answer. The body loses the single white column it is
        // for a flowing document; the sheets carry the paper themselves.
        `@media screen{html{padding-bottom:0}html,body{height:auto}` +
        `body{width:${w}cm;min-height:0;background:transparent;box-shadow:none}` +
        `.print-page{height:${h}cm;margin:0 auto 18px;background:#fff;` +
        `box-shadow:0 2px 12px rgba(0,0,0,.45)}}`,
    );

    // Per-page rotation (classes stamped on the page elements by printDocument;
    // only ever on `.print-page`, hence only ever here). A quarter turn is the
    // awkward one: `transform` does not change the layout box, so a rotated image
    // would reserve its *unrotated* size and overflow the sheet. It is therefore
    // centred out of flow inside the sheet and pre-constrained to the *swapped*
    // printable box — after the turn its bounding box is exactly the printable
    // area. The swapped box is read off the sheet itself in container units
    // (`cqh` for the width, `cqw` for the height — the sheet is a size container
    // for exactly this), so it follows the engine's page box the way the sheet
    // does; a box stated in centimetres would overflow it by the same ~2 cm.
    css.push(
      ".print-page.app-rot-90>img,.print-page.app-rot-270>img{position:absolute;" +
        `left:50%;top:50%;width:auto;height:auto;max-width:${scale}cqh;max-height:${scale}cqw}` +
        ".print-page.app-rot-90>img{transform:translate(-50%,-50%) rotate(90deg)}" +
        ".print-page.app-rot-270>img{transform:translate(-50%,-50%) rotate(270deg)}" +
        ".print-page.app-rot-180>img{transform:rotate(180deg)}",
    );
  }

  if (opts.pageNumbers) {
    // A real running footer would need @page margin boxes, which WebKitGTK does
    // not have — hence numbers are stamped onto the page elements themselves
    // (`data-page`, set by printDocument) and exist only for paged documents.
    // The number sits in the bottom margin band, and the sheet gives up 16px of
    // its printable height to it rather than having the page print over it.
    css.push(
      `.print-page{position:relative;padding-bottom:calc(${pad}cm + 16px)}` +
        `.print-page::after{content:attr(data-page);position:absolute;` +
        `left:0;right:0;bottom:${pad}cm;text-align:center;color:#555;` +
        `font:10px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}`,
    );
  }

  return css.join("\n");
}

const STORAGE_KEY = brandStorageKey("print.options");

/** `common/PrinterIcon` as markup: the preview's Print button is built with
 *  plain DOM, not React. Sized in em so it follows the button's text. */
const PRINTER_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1.2em" height="1.2em" fill="none" ` +
  `style="vertical-align:-0.2em" aria-hidden="true" focusable="false">` +
  `<g stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">` +
  `<path d="M7 8V3.75h10V8"/>` +
  `<path d="M7 17H5.5A2.5 2.5 0 0 1 3 14.5v-4A2.5 2.5 0 0 1 5.5 8h13a2.5 2.5 0 0 1 2.5 2.5v4a2.5 2.5 0 0 1-2.5 2.5H17"/>` +
  `<path d="M7 13.5h10v6.75H7z"/><path d="M9.25 16.75h5.5"/></g>` +
  `<circle cx="17.25" cy="11" r="0.85" fill="currentColor"/></svg>`;

/**
 * The two kinds of print job, which want different *defaults* and remember their
 * settings apart:
 *  - `flow`: markdown, text, code, HTML — content Tabtivity paginates, which needs
 *    real margins or it prints edge-to-edge.
 *  - `page`: a document that already comes as sheets (the PDF and image viewers).
 *    Its natural margin is **none** — a PDF page carries the margins its author
 *    chose, and printing it inside a second set of margins is what shrank it into
 *    the middle of the paper.
 *
 * They are stored separately so choosing "wide" for a memo does not follow the
 * next PDF onto paper, and vice versa.
 */
export type PrintKind = "flow" | "page";

/** Defaults for a sheet-based document: the sheet IS the page. */
export const PAGED_PRINT_OPTIONS: PrintOptions = {
  ...DEFAULT_PRINT_OPTIONS,
  margin: "none",
};

/** The defaults a print job of this kind starts from. */
export function printDefaults(kind: PrintKind): PrintOptions {
  return kind === "page" ? PAGED_PRINT_OPTIONS : DEFAULT_PRINT_OPTIONS;
}

function storageKey(kind: PrintKind): string {
  return kind === "page" ? `${STORAGE_KEY}.page` : STORAGE_KEY;
}

/**
 * Last used options for this kind of document, or its defaults. Never throws
 * (private mode, junk JSON).
 *
 * The page *selection* is deliberately not restored: a range like "2-3" belongs
 * to the document it was typed for, and silently re-applying it to the next file
 * would drop pages the user never chose to drop. Nor is the copy count — ten
 * handouts of one agenda must not become ten copies of the next PDF. Printer
 * settings (paper, margins, scale…) do carry over, which is what a printer
 * dialog does.
 */
export function loadPrintOptions(kind: PrintKind = "flow"): PrintOptions {
  const defaults = printDefaults(kind);
  const stored = (() => {
    try {
      const raw = localStorage.getItem(storageKey(kind));
      return raw ? sanitizePrintOptions(JSON.parse(raw), defaults) : { ...defaults };
    } catch {
      return { ...defaults };
    }
  })();
  return { ...stored, pages: defaults.pages, range: defaults.range, copies: defaults.copies };
}

export function savePrintOptions(opts: PrintOptions, kind: PrintKind = "flow"): void {
  try {
    localStorage.setItem(storageKey(kind), JSON.stringify(opts));
  } catch {
    /* storage unavailable: options simply don't persist */
  }
}

/** Coerce arbitrary stored JSON back into a valid `PrintOptions`. */
export function sanitizePrintOptions(
  v: unknown,
  defaults: PrintOptions = DEFAULT_PRINT_OPTIONS,
): PrintOptions {
  const o = (v && typeof v === "object" ? v : {}) as Partial<PrintOptions>;
  const pick = <T extends string>(val: unknown, allowed: readonly T[], fallback: T): T =>
    allowed.includes(val as T) ? (val as T) : fallback;
  return {
    paper: pick(o.paper, Object.keys(PAPER_CM) as PaperSize[], defaults.paper),
    orientation: pick(o.orientation, ["portrait", "landscape"], defaults.orientation),
    margin: pick(o.margin, ["none", "narrow", "normal", "wide"], defaults.margin),
    scale: clampScale(typeof o.scale === "number" ? o.scale : defaults.scale),
    pages: pick(o.pages, ["all", "odd", "even", "custom"], defaults.pages),
    range: typeof o.range === "string" ? o.range : "",
    grayscale: o.grayscale === true,
    background: o.background !== false,
    pageNumbers: o.pageNumbers === true,
    copies: clampCopies(typeof o.copies === "number" ? o.copies : defaults.copies),
  };
}

/** `translate` at the live language — this dialog is DOM-built outside React,
 *  so its strings are read here (once, when it opens) rather than via `useT`. */
function tr(
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
): string {
  return translate(useI18nStore.getState().lang, key, params);
}

export function clampScale(n: number): number {
  if (!Number.isFinite(n)) return 100;
  return Math.min(400, Math.max(10, Math.round(n)));
}

export function clampCopies(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_COPIES, Math.max(1, Math.round(n)));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Assemble a complete, self-contained print document. Pure (no DOM), so the
 * scaffolding + escaping is unit-testable. `bodyHtml` is trusted markup the
 * caller has already sanitised/escaped; `css` is inlined into a <style> after a
 * small print-oriented base (page margins, reset). The print options are layered
 * on later, by `printDocument`, as an injected stylesheet.
 */
export function buildPrintDoc(bodyHtml: string, css: string, title = "Print"): string {
  const base = `*{box-sizing:border-box}html,body{margin:0;padding:0}` +
    `@page{margin:1.5cm}` +
    `body{background:#fff;color:#111;` +
    `font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;` +
    `font-size:12px;line-height:1.5}`;
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<title>${escapeAttr(title)}</title>` +
    `<style>${base}\n${css}</style>` +
    `</head><body>${bodyHtml}</body></html>`
  );
}

/**
 * Show a print preview and, on confirmation, hand the document to the platform
 * print dialog. Mounts a modal overlay whose visible iframe renders the exact
 * standalone document that will print (WYSIWYG for paper), an options row with
 * the settings a printer dialog normally carries (paper, orientation, margins,
 * scale, page selection, backgrounds, grayscale, page numbers), and a Print
 * button that calls `print()` on the iframe's own window — so only the document,
 * not the surrounding app, prints. The overlay stays open after the dialog closes
 * (so the user can adjust and print again) and tears down on Close / backdrop
 * click / Escape, which is when the returned promise resolves.
 *
 * Page selection *and* rearranging are exact for *paged* documents — those built
 * out of `.print-page` elements (the PDF and image viewers) — because those pages
 * are real elements we can reorder, hide and drop. Those documents also get a
 * thumbnail strip for drag-to-reorder and per-page delete. Flowing documents
 * (markdown, text, HTML) have no such elements; there the page controls are
 * disabled and the system dialog's own range field does the job.
 */
/**
 * A viewer that can print its document as ITSELF — the PDF viewer, whose sheets
 * the preview can only show as images — passes this to {@link printDocument}.
 * Print then hands it the preview's final sheets (print order, turns, selection)
 * and options instead of printing the preview, so the arranging stays here and
 * the printer gets the real document. `unsupported` → the preview prints itself.
 */
export type NativePrint = (sheets: PageList, opts: PrintOptions) => Promise<NativePdfPrint>;

export function printDocument(fullHtml: string, native?: NativePrint): Promise<void> {
  return new Promise<void>((resolve) => {
    // ── Overlay chrome (reuses the app's shared modal classes) ──────────────
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop print-preview-backdrop";

    const dialog = document.createElement("div");
    dialog.className = "settings-dialog print-preview-dialog";

    const titlebar = document.createElement("div");
    titlebar.className = "print-preview-titlebar";

    const title = document.createElement("span");
    title.className = "print-preview-title";
    title.textContent = tr("print.title");

    const actions = document.createElement("div");
    actions.className = "print-preview-actions";

    const printBtn = document.createElement("button");
    printBtn.className = "print-preview-print";
    printBtn.type = "button";
    // Disabled with a "Preparing…" affordance until images decode; mirrors the
    // viewer toolbar's PrintButton busy state.
    printBtn.disabled = true;
    printBtn.innerHTML =
      `<span class="file-viewer-save-spinner" aria-hidden="true"></span>${escapeAttr(tr("print.preparing"))}`;

    // Where the last job is once it has left for the printer (see `followJob`).
    const progressEl = document.createElement("span");
    progressEl.className = "print-preview-progress";
    progressEl.setAttribute("role", "status");
    progressEl.setAttribute("aria-live", "polite");
    progressEl.hidden = true;

    const closeBtn = document.createElement("button");
    closeBtn.className = "dialog-close-btn print-preview-close";
    closeBtn.type = "button";
    closeBtn.textContent = tr("common.close");

    const iframe = document.createElement("iframe");
    iframe.className = "print-preview-frame";
    iframe.setAttribute("title", tr("print.title"));
    // The sandbox is load-bearing and the token list is exactly two, deliberately.
    //
    // What lands in `srcdoc` is not always a document Tabtivity assembled: for an
    // HTML/SVG file `buildPreviewDoc` returns the file's **own source** (plus,
    // for HTML, one `<base>` line of Tabtivity's — nothing that makes it safer),
    // so a hostile file in a cloned repo reaches this frame the moment someone
    // hits Print. The rendered *preview* of that same file has always been
    // `sandbox=""` (`FileViewerPane`'s `RenderedPreview`); this frame is the same
    // bytes and needs the same containment.
    //
    // `allow-scripts` is **absent**, which is the whole point — that is what makes
    // the file inert, rather than relying on the app CSP being inherited into
    // `about:srcdoc`. That inheritance does hold today, but it is precisely the
    // mechanism the mail and reader frames refuse to lean on ("a bonus, never the
    // mechanism"), because a policy that lives somewhere else is a policy that can
    // be relaxed by an edit that never mentions printing.
    //
    // The two tokens that ARE here are the ones the preview cannot work without:
    //  - `allow-same-origin`: this module reads `contentDocument` to inject the
    //    options stylesheet and to collect `.print-page` elements. Safe only
    //    because `allow-scripts` is absent — the two together are a sandbox
    //    escape, since a script could then remove the sandbox attribute itself.
    //  - `allow-modals`: `frameWin.print()` opens a modal on this browsing
    //    context, which the sandbox otherwise blocks — the Print button would
    //    silently do nothing.
    iframe.setAttribute("sandbox", "allow-same-origin allow-modals");

    // ── Options row ─────────────────────────────────────────────────────────
    // The kind is not known until the document has loaded and its `.print-page`
    // sheets (if any) have been counted, so the dialog opens on the flowing
    // settings and adopts the paged ones in `iframe.onload`.
    let kind: PrintKind = "flow";
    let opts = loadPrintOptions(kind);
    const optionsRow = document.createElement("div");
    optionsRow.className = "print-preview-options";

    const paper = selectField(
      tr("print.paper"),
      (Object.keys(PAPER_CM) as PaperSize[]).sort().map((p) => [p, p] as const),
      opts.paper,
      (v) => set({ paper: v as PaperSize }),
    );
    const orientation = selectField(
      tr("print.layout"),
      [
        ["portrait", tr("print.portrait")],
        ["landscape", tr("print.landscape")],
      ],
      opts.orientation,
      (v) => set({ orientation: v as Orientation }),
    );
    const margin = selectField(
      tr("print.margins"),
      [
        ["none", tr("print.marginNone")],
        ["narrow", tr("print.marginNarrow")],
        ["normal", tr("print.marginNormal")],
        ["wide", tr("print.marginWide")],
      ],
      opts.margin,
      (v) => set({ margin: v as MarginPreset }),
    );
    const scale = selectField(
      tr("print.scale"),
      SCALE_CHOICES.map((s) => [String(s), `${s}%`] as const),
      String(opts.scale),
      (v) => set({ scale: Number(v) }),
    );
    const pages = selectField(
      tr("print.pages"),
      [
        ["all", tr("print.pagesAll")],
        ["odd", tr("print.pagesOdd")],
        ["even", tr("print.pagesEven")],
        ["custom", tr("print.pagesCustom")],
      ],
      opts.pages,
      (v) => set({ pages: v as PageSelection }),
    );

    const rangeInput = document.createElement("input");
    rangeInput.className = "print-opt-range";
    rangeInput.type = "text";
    rangeInput.placeholder = tr("print.rangePlaceholder");
    rangeInput.value = opts.range;
    rangeInput.setAttribute("aria-label", tr("print.rangeAria"));
    rangeInput.addEventListener("input", () => set({ range: rangeInput.value }));

    const background = checkField(tr("print.backgrounds"), opts.background, (v) =>
      set({ background: v }),
    );
    const grayscale = checkField(tr("print.grayscale"), opts.grayscale, (v) => set({ grayscale: v }));
    const pageNumbers = checkField(tr("print.pageNumbers"), opts.pageNumbers, (v) =>
      set({ pageNumbers: v }),
    );

    // A number rather than a select: 1–99 is too long a list to scroll. It is
    // clamped on commit, not per keystroke, so clearing the box to type "12"
    // does not snap back to 1 in between.
    const copies = numberField(tr("print.copies"), opts.copies, (v) => set({ copies: v }));

    optionsRow.append(
      copies.wrap,
      paper.wrap,
      orientation.wrap,
      margin.wrap,
      scale.wrap,
      pages.wrap,
      rangeInput,
      background.wrap,
      grayscale.wrap,
      pageNumbers.wrap,
    );

    // ── Page strip (paged documents only) ───────────────────────────────────
    const strip = document.createElement("div");
    strip.className = "print-preview-strip";
    strip.hidden = true;

    const stripHint = document.createElement("span");
    stripHint.className = "print-strip-hint";
    stripHint.textContent = tr("print.stripHint");

    const resetBtn = document.createElement("button");
    resetBtn.className = "print-strip-reset";
    resetBtn.type = "button";
    resetBtn.textContent = tr("print.resetPages");
    resetBtn.addEventListener("click", () => {
      arrangement = initialPages(pageEls.length);
      opts = { ...opts, pages: "all", range: "" };
      pages.select.value = "all";
      rangeInput.value = "";
      apply();
    });

    const stripBar = document.createElement("div");
    stripBar.className = "print-strip-bar";
    stripBar.append(stripHint, resetBtn);

    const stripPages = document.createElement("div");
    stripPages.className = "print-strip-pages";
    strip.append(stripBar, stripPages);

    actions.append(printBtn, closeBtn);
    titlebar.append(title, progressEl, actions);
    dialog.append(titlebar, optionsRow, strip, iframe);
    backdrop.append(dialog);

    // ── Live state of the previewed document ────────────────────────────────
    let frameWin: Window | null = null;
    let styleEl: HTMLStyleElement | null = null;
    /** Page elements indexed by original page number − 1; never reordered. */
    let pageEls: HTMLElement[] = [];
    /** Working arrangement (see `pageModel`): the sheets, moved/dropped/turned by
     *  the strip. Every entry's `src` is SELF — a print job never merges documents. */
    let arrangement: PageList = [];
    let ready = false; // images decoded — safe to print
    /** The mounted <PageStrip>; created on the first paged render. */
    let stripUi: MountedPageStrip | null = null;
    /** What copies 2..n put into the document: cloned sheets, or for a flowing
     *  document a page break plus its body again. Rebuilt from the originals, so
     *  nothing here is ever the source of another clone. */
    let copyNodes: Node[] = [];
    /** A flowing document's own body content, captured before any copy exists. */
    let flowNodes: Node[] = [];
    /** The copy count `copyNodes` holds for a flowing document (its copies do not
     *  depend on any other option, so they are only rebuilt when this changes). */
    let flowCopies = 1;

    const NO_PAGES_HINT = tr("print.noPagesHint");

    /** Push the arrangement + options into the previewed document and the UI. */
    const apply = () => {
      savePrintOptions(opts, kind);
      const paged = pageEls.length > 0;
      pages.select.disabled = !paged;
      pageNumbers.input.disabled = !paged;
      rangeInput.disabled = !paged || opts.pages !== "custom";
      pages.wrap.title = paged ? "" : NO_PAGES_HINT;
      pageNumbers.wrap.title = paged ? "" : NO_PAGES_HINT;
      rangeInput.title = paged ? "" : NO_PAGES_HINT;
      strip.hidden = !paged;
      resetBtn.disabled = isPristine(arrangement, pageEls.length) && opts.pages === "all";

      if (styleEl) styleEl.textContent = buildOptionsCss(opts, paged);

      // Cards take the sheet's proportions, so a landscape sheet gets a landscape
      // card instead of an upright one. Set on the host, inherited by the cards.
      const [thumbW, thumbH] = thumbSizePx(opts);
      stripPages.style.setProperty("--page-thumb-w", `${thumbW}px`);
      stripPages.style.setProperty("--page-thumb-h", `${thumbH}px`);

      const sequence = printSequence(arrangement, opts);
      const printing = new Set(sequence.map((r) => r.page));
      const parent = pageEls[0]?.parentElement ?? null;
      // `pageEls` is indexed by original page number − 1 and never reordered.
      pageEls.forEach((el, i) =>
        el.classList.toggle("app-print-hidden", !printing.has(i + 1)),
      );
      // The DOM *is* the print order, so realise the arrangement by re-appending
      // the pages in sequence. The page break is set inline per page rather than
      // left to `.print-page + .print-page`, whose sibling match would also fire
      // on the first printed page when a removed one still precedes it in the DOM
      // — one blank leading sheet.
      sequence.forEach((ref, i) => {
        const el = pageEls[ref.page - 1];
        if (!el) return;
        parent?.appendChild(el);
        el.style.pageBreakBefore = i === 0 ? "auto" : "always";
        el.style.breakBefore = i === 0 ? "auto" : "page";
        el.setAttribute("data-page", String(i + 1));
        el.classList.remove("app-rot-90", "app-rot-180", "app-rot-270");
        if (ref.rot) el.classList.add(`app-rot-${ref.rot}`);
      });

      realiseCopies(sequence, paged);

      // Safe to re-render mid-drag: React reorders the SAME card elements (they are
      // keyed by page id), so the dragged card keeps its identity — and its grab.
      renderStrip(sequence);

      if (!ready) return;
      const empty = paged && sequence.length === 0;
      printBtn.disabled = empty;
      if (empty) {
        printBtn.textContent = tr("print.noneSelected");
      } else {
        const label =
          (paged && sequence.length < pageEls.length
            ? sequence.length === 1
              ? tr("print.printOnePage")
              : tr("print.printPages", { count: sequence.length })
            : tr("print.print")) +
          (opts.copies > 1 ? tr("print.copiesSuffix", { count: opts.copies }) : "");
        printBtn.innerHTML = `${PRINTER_SVG} ${escapeAttr(label)}`;
      }
    };

    /**
     * Put copies 2..n into the previewed document after the first. The document
     * is what prints, so a copy has to be real content in it: `window.print()`
     * takes no copy count, and the system dialog's own field would leave the
     * preview showing one copy of a job that prints several.
     *
     * A paged copy clones the sheets as `apply` just arranged them (turns
     * included) and numbers them from 1 again, each copy being a whole document.
     * A flowing copy is a page break and the body's original content once more.
     */
    const realiseCopies = (sequence: PageList, paged: boolean) => {
      const n = clampCopies(opts.copies);
      if (!paged && n === flowCopies) return;
      copyNodes.forEach((node) => node.parentNode?.removeChild(node));
      copyNodes = [];
      flowCopies = 1;
      if (n <= 1) return;
      if (paged) {
        const parent = pageEls[0]?.parentElement;
        if (!parent || sequence.length === 0) return;
        // The first copy is the arranged originals themselves; clone the rest.
        withCopies(sequence, n)
          .slice(sequence.length)
          .forEach((ref, i) => {
            const el = pageEls[ref.page - 1];
            if (!el) return;
            const copy = el.cloneNode(true) as HTMLElement;
            copy.style.pageBreakBefore = "always";
            copy.style.breakBefore = "page";
            copy.setAttribute("data-page", String((i % sequence.length) + 1));
            parent.appendChild(copy);
            copyNodes.push(copy);
          });
      } else {
        const body = iframe.contentDocument?.body;
        if (!body) return;
        for (let c = 1; c < n; c++) {
          const seam = body.ownerDocument.createElement("div");
          seam.className = "app-copy-break";
          body.appendChild(seam);
          copyNodes.push(seam);
          for (const node of flowNodes) {
            const copy = node.cloneNode(true);
            body.appendChild(copy);
            copyNodes.push(copy);
          }
        }
        flowCopies = n;
      }
    };

    /** Whether the user has touched the options row — after which nothing this
     *  module derives (see the orientation below) may overrule them. */
    let touched = false;

    /** Merge an option change and re-apply. */
    const set = (patch: Partial<PrintOptions>) => {
      touched = true;
      opts = { ...opts, ...patch };
      apply();
    };

    /** Push `opts` back into the controls — for the changes this module makes
     *  itself (adopting the paged settings, taking the sheet's orientation). */
    const syncControls = () => {
      paper.select.value = opts.paper;
      orientation.select.value = opts.orientation;
      margin.select.value = opts.margin;
      scale.select.value = String(opts.scale);
      pages.select.value = opts.pages;
      rangeInput.value = opts.range;
      background.input.checked = opts.background;
      grayscale.input.checked = opts.grayscale;
      pageNumbers.input.checked = opts.pageNumbers;
      copies.input.value = String(opts.copies);
    };

    /**
     * Push the current arrangement into the strip.
     *
     * The strip is the shared `<PageStrip>` — the very component the PDF viewer's
     * page rail uses — so dragging, shift-selecting, turning and deleting pages
     * behave the same in both. It owns the gesture and reports each edit back
     * through `onChange`; `arrangement` (and thus the preview) follows.
     */
    const renderStrip = (sequence: PageList) => {
      if (pageEls.length === 0) return;
      const printing = new Set(sequence.map((r) => r.id));
      const props: PageStripProps = {
        pages: arrangement,
        orientation: "row",
        onChange: (next) => {
          arrangement = next;
          apply();
        },
        // The thumbnail is the page's own already-rasterised image, taken straight
        // from the previewed document (the PDF viewer rasterises pages itself).
        renderThumb: (ref) => {
          const src = pageEls[ref.page - 1]?.querySelector("img")?.src;
          return src
            ? createElement("img", { src, alt: "" })
            : createElement("span", { className: "page-strip-blank" }, String(ref.page));
        },
        badgeFor: (ref) =>
          printing.has(ref.id)
            ? String(sequence.findIndex((r) => r.id === ref.id) + 1)
            : "—",
        isExcluded: (ref) => !printing.has(ref.id),
        titleFor: (ref) =>
          tr("print.pageOf", { page: ref.page }) +
          (ref.rot ? ` · ${tr("print.turned", { deg: ref.rot })}` : ""),
      };
      if (stripUi) stripUi.update(props);
      else stripUi = mountPageStrip(stripPages, props);
    };

    // ── Job progress ────────────────────────────────────────────────────────
    /** The newest queue reading — the "before" a new job is told apart from. */
    let lastSnapshot: PrintSnapshot | null = null;
    /** Bumped per Print; a follow loop whose number is stale stops. */
    let followRun = 0;

    const showProgress = (progress: PrintProgress) => {
      progressEl.hidden = false;
      progressEl.dataset.phase = progress.phase;
      progressEl.replaceChildren();
      const busy = ["waiting", "queued", "printing"].includes(progress.phase);
      if (busy) {
        const spinner = document.createElement("span");
        spinner.className = "file-viewer-save-spinner";
        spinner.setAttribute("aria-hidden", "true");
        progressEl.append(spinner);
      }
      // Sent → queued → printing → done, filled as far as the job has come.
      const reached = PROGRESS_STEPS[progress.phase];
      const steps = document.createElement("span");
      steps.className = "print-progress-steps";
      steps.setAttribute("aria-hidden", "true");
      for (let i = 0; i < 4; i++) {
        const step = document.createElement("i");
        if (i < reached) step.className = "on";
        else if (i === reached && busy) step.className = "next";
        // The printing step fills as its pages go out.
        if (i === reached && progress.phase === "printing" && progress.page && progress.total) {
          const fill = Math.round(((progress.page - 1) / progress.total) * 100);
          step.style.setProperty("--fill", `${fill}%`);
        }
        steps.append(step);
      }
      const text = document.createElement("span");
      text.className = "print-progress-text";
      // Printer names come from the print system: a text node, never markup.
      text.textContent = progressText(progress);
      progressEl.title =
        progress.phase === "printing" && progress.page !== null
          ? `${text.textContent}\n${tr("print.progressPagesNote")}`
          : text.textContent;
      progressEl.append(steps, text, ...untestedTag("print.queueProgress"));
    };

    /**
     * Follow the job this Print submitted through the queue until it leaves it.
     * `window.print()` reports nothing about the job, so the queue is the only
     * witness; on a machine without a readable print system there is nothing
     * to show and the status stays hidden rather than guessing.
     */
    const followJob = async () => {
      const run = ++followRun;
      const docTitle = iframe.contentDocument?.title ?? "";
      // What this Print put into the job, for when the queue has no page count:
      // exact for sheets, unknown for flowing text (the engine paginates it).
      const expectedPages =
        pageEls.length > 0
          ? printSequence(arrangement, opts).length * clampCopies(opts.copies)
          : null;
      const before = lastSnapshot ?? (await printSnapshot());
      if (done || run !== followRun || !before.supported) return;
      const baseline = new Set(before.jobs.map((job) => job.id));
      const started = Date.now();
      let tracked: string[] = [];
      showProgress({ phase: "waiting" });
      while (!done && run === followRun) {
        await new Promise((r) => setTimeout(r, JOB_POLL_MS));
        if (done || run !== followRun) return;
        const snap = await printSnapshot();
        if (done || run !== followRun) return;
        // A reading with a note is a failed one (a timed-out lpstat): an empty
        // job list from it must not be mistaken for the job having finished.
        if (!snap.supported || snap.note) {
          if (tracked.length === 0 && Date.now() - started > JOB_APPEAR_TIMEOUT_MS) {
            showProgress({ phase: "unseen" });
            return;
          }
          continue;
        }
        lastSnapshot = snap;
        const step = followPrintJob(
          snap,
          baseline,
          tracked,
          docTitle,
          Date.now() - started,
          expectedPages,
        );
        tracked = step.tracked;
        showProgress(step.progress);
        if (step.progress.phase === "done" || step.progress.phase === "unseen") return;
      }
    };

    // ── Teardown (single-shot) ──────────────────────────────────────────────
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKeyDown);
      stripUi?.destroy();
      stripUi = null;
      backdrop.remove();
      resolve();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        cleanup();
      }
    };

    closeBtn.addEventListener("click", cleanup);
    // Backdrop click closes; clicks inside the dialog must not bubble to it.
    backdrop.addEventListener("mousedown", (e) => {
      if (e.target === backdrop) cleanup();
    });
    document.addEventListener("keydown", onKeyDown);

    const printFrame = () => {
      if (!frameWin) return;
      try {
        frameWin.focus();
        frameWin.print();
      } catch {
        /* printing unsupported / dialog refused: leave preview open */
        return;
      }
      void followJob();
    };

    /** A native print that failed says so where the user is looking. */
    const showFailure = (e: unknown) => {
      progressEl.hidden = false;
      progressEl.dataset.phase = "failed";
      const text = document.createElement("span");
      text.className = "print-progress-text";
      text.textContent = tr("print.failed", { msg: e instanceof Error ? e.message : String(e) });
      progressEl.title = text.textContent;
      progressEl.replaceChildren(text);
    };

    printBtn.addEventListener("click", () => {
      if (printBtn.disabled || !frameWin) return;
      if (!native || pageEls.length === 0) {
        printFrame();
        return;
      }
      printBtn.disabled = true;
      native(printSequence(arrangement, opts), opts)
        .then((outcome) => {
          if (done) return;
          if (outcome === "unsupported") printFrame();
          else if (outcome === "sent") void followJob();
        })
        .catch((e) => {
          if (!done) showFailure(e);
        })
        .finally(() => {
          if (!done) printBtn.disabled = printSequence(arrangement, opts).length === 0;
        });
    });

    iframe.onload = () => {
      const win = iframe.contentWindow;
      const doc = iframe.contentDocument;
      if (!win || !doc) return;
      frameWin = win;

      // Injected last, so it wins over the document's own rules at equal
      // specificity — including for documents Tabtivity did not assemble.
      styleEl = doc.createElement("style");
      styleEl.id = "app-print-options";
      (doc.head ?? doc.documentElement).appendChild(styleEl);

      pageEls = Array.from(doc.querySelectorAll<HTMLElement>(".print-page"));
      flowNodes = doc.body ? Array.from(doc.body.childNodes) : [];
      arrangement = initialPages(pageEls.length);
      // A document made of sheets keeps its own printer settings (see `PrintKind`):
      // its margins default to none, because the sheet already carries the ones its
      // author chose. Adopting them here rather than at the call site means any
      // viewer that emits `.print-page` gets it, without having to declare it.
      if (pageEls.length > 0) {
        kind = "page";
        opts = loadPrintOptions(kind);
        syncControls();
      }
      apply(); // style the preview immediately; the button stays "Preparing…"

      Promise.all(
        Array.from(doc.images).map((img) =>
          Promise.resolve(img.decode?.()).catch(() => {
            /* broken/missing image: preview what loaded rather than block */
          }),
        ),
      ).then(() => {
        if (done) return;
        // Now the sheets have measurable dimensions, put the paper the right way
        // up: a wide page (a poster, a slide deck, an A1 drawing) on an upright
        // sheet fits to the width and leaves half the paper empty, which is the
        // same "why is it so small" as printing inside margins it does not need.
        // Like the page selection, this is derived per job rather than restored —
        // it belongs to the document, not to the user's printer preferences — and
        // the orientation control still overrides it for this job.
        const first = pageEls[0]?.querySelector("img");
        if (!touched && kind === "page" && first?.naturalWidth && first.naturalHeight) {
          const wanted: Orientation =
            first.naturalWidth > first.naturalHeight ? "landscape" : "portrait";
          if (wanted !== opts.orientation) {
            opts = { ...opts, orientation: wanted };
            syncControls();
          }
        }
        ready = true;
        apply();
      });
    };

    document.body.appendChild(backdrop);
    iframe.srcdoc = fullHtml;
    // The queue as it stands before anything is printed, read in the background
    // so Print never waits on a slow print server for it.
    void printSnapshot().then((snap) => {
      if (!done && snap.supported && !snap.note) lastSnapshot ??= snap;
    });
  });
}

/** A labelled `<select>` for the options row. */
function selectField(
  label: string,
  choices: readonly (readonly [string, string])[],
  value: string,
  onChange: (value: string) => void,
): { wrap: HTMLLabelElement; select: HTMLSelectElement } {
  const wrap = document.createElement("label");
  wrap.className = "print-opt";
  const text = document.createElement("span");
  text.className = "print-opt-label";
  text.textContent = label;
  const select = document.createElement("select");
  select.className = "print-opt-select";
  for (const [v, l] of choices) {
    const option = document.createElement("option");
    option.value = v;
    option.textContent = l;
    select.appendChild(option);
  }
  select.value = value;
  select.addEventListener("change", () => onChange(select.value));
  wrap.append(text, select);
  return { wrap, select };
}

/** A labelled whole-number input for the options row, clamped to 1..MAX_COPIES. */
function numberField(
  label: string,
  value: number,
  onChange: (value: number) => void,
): { wrap: HTMLLabelElement; input: HTMLInputElement } {
  const wrap = document.createElement("label");
  wrap.className = "print-opt";
  const text = document.createElement("span");
  text.className = "print-opt-label";
  text.textContent = label;
  const input = document.createElement("input");
  input.className = "print-opt-range print-opt-number";
  input.type = "number";
  input.min = "1";
  input.max = String(MAX_COPIES);
  input.step = "1";
  input.value = String(value);
  input.addEventListener("input", () => {
    if (input.value.trim() === "") return; // mid-edit: wait for a number
    onChange(clampCopies(Number(input.value)));
  });
  input.addEventListener("change", () => {
    const n = clampCopies(Number(input.value));
    input.value = String(n);
    onChange(n);
  });
  wrap.append(text, input, ...untestedTag("print.copiesField"));
  return { wrap, input };
}

/**
 * Not yet live-verified — the DOM twin of `<UntestedTag/>`, reading the same
 * register in `lib/untested`. Returns a list so a caller can spread it into
 * `append()`: once the row is stamped tested, it spreads to nothing.
 */
function untestedTag(id: UntestedId): HTMLSpanElement[] {
  if (!isUntested(id)) return [];
  const tag = document.createElement("span");
  tag.className = "untested-tag";
  tag.title = tr("untested.title");
  tag.textContent = tr("untested.label");
  return [tag];
}

/** How often the queue is re-read while a job is followed. */
const JOB_POLL_MS = 1500;

/** Steps of sent → queued → printing → done a phase has reached. */
const PROGRESS_STEPS: Record<PrintProgress["phase"], number> = {
  waiting: 1,
  queued: 2,
  held: 2,
  printing: 3,
  done: 4,
  unseen: 1,
};

/** A rough time left: to the next 5 s under a minute, whole minutes above —
 *  it is an estimate, and more digits would claim otherwise. */
function formatEta(secs: number): string {
  return secs < 60
    ? tr("print.durationSecs", { count: Math.max(5, Math.ceil(secs / 5) * 5) })
    : tr("print.durationMins", { count: Math.ceil(secs / 60) });
}

function progressText(progress: PrintProgress): string {
  switch (progress.phase) {
    case "waiting":
      return tr("print.progressWaiting");
    case "queued":
      return progress.ahead > 0
        ? tr("print.progressAhead", { printer: progress.printer, count: progress.ahead })
        : tr("print.progressQueued", { printer: progress.printer });
    case "printing": {
      const parts = [tr("print.progressPrinting", { printer: progress.printer })];
      if (progress.page !== null) {
        parts.push(
          progress.total !== null
            ? tr("print.progressPage", { page: progress.page, total: progress.total })
            : tr("print.progressPageOnly", { page: progress.page }),
        );
      }
      if (progress.etaSecs !== null) {
        parts.push(tr("print.progressEta", { time: formatEta(progress.etaSecs) }));
      }
      if (progress.behind > 0) {
        parts.push(tr("print.progressBehind", { count: progress.behind }));
      }
      return parts.join(" · ");
    }
    case "held":
      return tr("print.progressHeld", { printer: progress.printer });
    case "done":
      return tr("print.progressDone");
    case "unseen":
      return tr("print.progressUnseen");
  }
}

/** A labelled checkbox for the options row. */
function checkField(
  label: string,
  checked: boolean,
  onChange: (checked: boolean) => void,
): { wrap: HTMLLabelElement; input: HTMLInputElement } {
  const wrap = document.createElement("label");
  wrap.className = "print-opt print-opt-check";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  const text = document.createElement("span");
  text.className = "print-opt-label";
  text.textContent = label;
  wrap.append(input, text);
  return { wrap, input };
}

/** Convenience: build the document from a body + css and print it. */
export function printHtmlBody(
  bodyHtml: string,
  css: string,
  title?: string,
  native?: NativePrint,
): Promise<void> {
  return printDocument(buildPrintDoc(bodyHtml, css, title), native);
}

/**
 * Rasterise an ARRANGEMENT — the sheets the PDF viewer is currently showing, in its
 * current order and with its turns applied — to PNG data URLs for printing, pulling
 * each sheet from its own already-open pdf.js document. So printing an edited PDF
 * prints what you see, without first having to save it. `scale` trades size for print
 * sharpness; the default is {@link PDF_PRINT_SCALE}.
 */
/**
 * Print resolution for a PDF sheet, in dots per inch. The raster is the ONLY
 * resolution the paper ever gets: WebKitGTK embeds the `<img>` in the print job
 * pixel for pixel (measured with a headless print-to-PDF of an A4 page: a
 * 1191×1684 raster came out as a 171 ppi image, a 2481×3508 one as 356 ppi —
 * nothing resampled). The old 2× (144 dpi) therefore printed text visibly soft
 * and stair-stepped; 300 dpi is ordinary laser resolution. An A4 sheet at this
 * scale is 8.7 Mpx, inside the canvas limits below, and ~150 KB as a PNG.
 */
export const PDF_PRINT_DPI = 300;
/** {@link PDF_PRINT_DPI} as a pdf.js viewport scale (one unit = 1/72 in). */
export const PDF_PRINT_SCALE = PDF_PRINT_DPI / 72;
/**
 * The ceiling on one rasterised sheet, in pixels. A canvas past the engine's
 * limit does not fail loudly — it comes back blank, and a blank sheet prints as
 * a blank sheet. An A4 page at print scale is 8.7 Mpx and inside it; an A0/A1
 * drawing or a plotter page is (A1 at 300 dpi is 70 Mpx), so those rasterise at
 * whatever scale fits instead. They are being fitted onto a much smaller sheet
 * anyway, so the resolution lost is resolution that would not have printed.
 */
const MAX_RASTER_PX = 12_000_000;
const MAX_RASTER_SIDE = 8192;

/** `scale` reduced until the page's raster fits inside the canvas limits. */
export function rasterScaleFor(
  pageW: number,
  pageH: number,
  scale: number,
): number {
  if (!(pageW > 0) || !(pageH > 0)) return scale;
  const fit = Math.min(
    1,
    MAX_RASTER_SIDE / Math.max(pageW * scale, pageH * scale),
    Math.sqrt(MAX_RASTER_PX / (pageW * scale * pageH * scale)),
  );
  return fit >= 1 ? scale : Math.max(0.1, scale * fit);
}

export async function renderPdfPagesToImages(
  refs: readonly {
    src: string;
    page: number;
    rot: number;
    /** Pending blackouts (#pdf-redact), in big points in the sheet's rotated space.
     *  Printing an arrangement prints what is on screen, and on a marked sheet that
     *  includes the black areas — a print that leaked the text a save would have
     *  destroyed would be the same failure by another route. */
    marks?: readonly { x: number; y: number; w: number; h: number }[];
  }[],
  docFor: (src: string) => PDFDocumentProxy | undefined,
  scale = PDF_PRINT_SCALE,
): Promise<string[]> {
  const urls: string[] = [];
  for (const ref of refs) {
    const doc = docFor(ref.src);
    if (!doc) continue;
    const page = await doc.getPage(ref.page);
    // The viewer's turn rides ON TOP of whatever the page already carried, and
    // pdf.js' `rotation` is the total — so the two are added, not substituted.
    const rotation = (((page.rotate + ref.rot) % 360) + 360) % 360;
    const base = page.getViewport({ scale: 1, rotation });
    const viewport = page.getViewport({
      scale: rasterScaleFor(base.width, base.height, scale),
      rotation,
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) continue;
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    if (ref.marks?.length) {
      // In big points, so they follow the viewport that was actually used — which
      // is not `scale` when an outsized page had to be rasterised smaller.
      const k = viewport.scale;
      ctx.fillStyle = "#000000";
      for (const m of ref.marks) ctx.fillRect(m.x * k, m.y * k, m.w * k, m.h * k);
    }
    urls.push(canvas.toDataURL("image/png"));
    // Give the backing store back before rasterising the next sheet. An A4 page at
    // print scale is ~9 megapixels — 35 MB of pixels — and the canvas is only garbage
    // once the collector gets to it, so printing a 200-page document otherwise held
    // every page's raster AND its data URL at the same time. The URL is already
    // taken; the pixels are finished with.
    canvas.width = 0;
    canvas.height = 0;
    // The page's parse is finished with too: this walks the whole arrangement, and
    // a print of a long document must not leave every sheet's decoded images behind
    // in the worker (the viewer repaints from the file on its own).
    page.cleanup();
  }
  return urls;
}

/** Escape a string for use inside a double-quoted HTML attribute. */
function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// ── Print stylesheets ────────────────────────────────────────────────────────
// Concrete light-on-white colors: the app's themed `var(--…)` tokens don't exist
// inside the print iframe, and print output is on paper.

/** Print styling for `renderMarkdown` output wrapped in `.markdown-body`.
 *
 * Margins come from body padding, NOT `@page{margin}`: WebKitGTK (the Linux
 * webview) does not implement the `@page` margin box, so an `@page` margin alone
 * prints edge-to-edge. Body padding is honored by every engine. `@page` margin
 * is zeroed so Chromium-based WebView2 doesn't add its own on top (double
 * margin). This overrides the `html,body{padding:0}` reset in `buildPrintDoc`. */
export const MARKDOWN_PRINT_CSS = `
@page{margin:0}
body{padding:2.54cm}
.markdown-body{max-width:100%;color:#111}
.markdown-body h1,.markdown-body h2,.markdown-body h3,
.markdown-body h4,.markdown-body h5,.markdown-body h6{
  line-height:1.25;margin:1.2em 0 .5em;font-weight:600;page-break-after:avoid}
.markdown-body h1{font-size:1.9em;border-bottom:1px solid #ddd;padding-bottom:.2em}
.markdown-body h2{font-size:1.5em;border-bottom:1px solid #eee;padding-bottom:.2em}
.markdown-body h3{font-size:1.25em}
.markdown-body p,.markdown-body ul,.markdown-body ol,.markdown-body blockquote{margin:.6em 0}
.markdown-body ul,.markdown-body ol{padding-left:1.6em}
.markdown-body a{color:#0645ad;text-decoration:underline}
.markdown-body code{
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:.9em;background:#f4f4f4;padding:.1em .3em;border-radius:3px}
.markdown-body pre{
  background:#f6f8fa;border:1px solid #e1e4e8;border-radius:4px;padding:.8em;
  overflow:auto;page-break-inside:avoid}
.markdown-body pre code{background:none;padding:0}
.markdown-body blockquote{
  border-left:4px solid #ddd;color:#555;padding-left:1em;margin-left:0}
.markdown-body table{border-collapse:collapse;margin:.6em 0;page-break-inside:avoid}
.markdown-body th,.markdown-body td{border:1px solid #ccc;padding:.35em .6em;text-align:left}
.markdown-body th{background:#f4f4f4}
.markdown-body img,.markdown-body svg{max-width:100%;height:auto}
.markdown-body hr{border:0;border-top:1px solid #ddd;margin:1.2em 0}
`;

/** Print styling for plain text / source shown in a single `<pre>`.
 * Margins via body padding — see MARKDOWN_PRINT_CSS for why `@page{margin}`
 * alone prints borderless on WebKitGTK. */
export const TEXT_PRINT_CSS = `
@page{margin:0}
body{padding:2.54cm}
pre.print-pre{
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:11px;line-height:1.45;color:#111;margin:0;
  white-space:pre-wrap;word-break:break-word}
`;

/** Print styling for a single image / one image per PDF page.
 *
 *  The page box itself comes from `buildOptionsCss`, which knows the paper and
 *  the margins; this is the shape that has to hold without it — centred, capped
 *  on both axes so neither one can overflow the sheet, and never *stretched*
 *  (`width/height:auto`), so a page keeps its aspect whatever the sheet is. */
export const IMAGE_PRINT_CSS = `
.print-page{display:flex;align-items:center;justify-content:center;text-align:center}
.print-page img{width:auto;height:auto;max-width:100%;max-height:100%}
.print-page + .print-page{page-break-before:always}
`;

/** Alias — PDF prints as one image per page with the same rules. */
export const PDF_PRINT_CSS = IMAGE_PRINT_CSS;
