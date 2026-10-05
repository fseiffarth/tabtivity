/**
 * Reading, writing and — the part that matters — **re-anchoring** a deck sidecar
 * (`docs/deck_presenter_plan.md` §2.1/§2.2). All pure: nothing here touches the
 * filesystem, so every branch is testable and the viewer owns the I/O. The one
 * outside read is the current language, for the loss reasons this hands back as
 * finished sentences (`lib/i18n`, synchronous and English by default in tests).
 *
 * Two jobs, and the second is the reason the feature is usable at all.
 *
 * **Parsing is defensive, not trusting.** A deck is hand-editable text under git,
 * so it arrives having possibly been merged badly, half-edited in the YAML tree,
 * or written by a newer build. `normalizeDeck` coerces every field to something
 * renderable and drops what it cannot, because a viewer that throws on a bad
 * merge is a viewer that loses the author's other twenty slides too.
 *
 * **Re-anchoring survives a recompile.** TeX rewrites the base PDF whenever the
 * author fixes a typo, and inserting one slide shifts every page number after it.
 * `reconcile` re-attaches layers to the pages they belong to, and — the invariant
 * the whole design hangs on — **never silently drops one**. Anything it cannot
 * place lands in `deck.detached` for the re-attach UI. A recompile that quietly
 * eats annotations is what makes people stop trusting a tool.
 */

import { translate, useI18nStore } from "../../i18n";
import {
  DECK_VERSION,
  type Deck,
  type DeckFooter,
  type DetachedLayer,
  type FontFamily,
  type Slide,
  blankSlide,
  defaultFooter,
  defaultTheme,
  defaultTextStyle,
  emptyDeck,
  newSlideId,
  type DeckObject,
  type ObjectList,
  type TextAlign,
  type TextStyle,
  type Transition,
  type Interstitial,
  newObjectId,
  DEFAULT_PAGE_WIDTH,
  DEFAULT_PAGE_HEIGHT,
} from "./model";
import { BRAND } from "../../brand";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** The deck sidecar beside a base PDF: `talk.pdf` → `talk.eldeck.json`. */
export function deckPathForPdf(pdfPath: string): string {
  return `${pdfPath.replace(/\.pdf$/i, "")}.eldeck.json`;
}

/** The base PDF a deck sidecar names by convention, when it records none. */
export function pdfPathForDeck(deckPath: string): string {
  return `${deckPath.replace(/\.eldeck\.json$/i, "")}.pdf`;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Two-space JSON with a trailing newline — the deck is a *tracked source file*,
 * so it is formatted to diff line-by-line rather than to be compact. A one-line
 * deck would make every edit a whole-file conflict.
 */
export function serializeDeck(deck: Deck): string {
  return `${JSON.stringify(deck, null, 2)}\n`;
}

export interface ParseResult {
  deck: Deck;
  /** Set when the text could not be read at all and `deck` is a fresh empty one. */
  error?: string;
  /** Set when the file parsed but something in it was repaired or discarded. */
  repaired?: string;
  /**
   * The version the *file* declared (not the one this build writes). `deck.version`
   * carries it through verbatim, so saving a newer deck cannot silently downgrade
   * the field even if the caller decides to save anyway.
   */
  version: number;
  /**
   * True when reading this file **discarded something**: a higher declared
   * version, an object kind this build cannot model, or a slide it could not
   * read at all.
   *
   * The distinction from `repaired` is what makes it worth its own flag.
   * `repaired` covers a coercion that lost nothing an author would miss (a
   * numeric field that arrived as a string). `lossy` means writing this deck back
   * would **destroy** part of the file — so the viewer must not autosave over it
   * without the author saying so. Everything a deck goes through — a bad merge, a
   * newer build on another machine, a hand edit — funnels into exactly this case.
   */
  lossy: boolean;
  /** Why, in plain words, when `lossy`. */
  lossReason?: string;
}

/**
 * Read a sidecar.
 *
 * **Empty is not broken.** A zero-byte file, whitespace, or `{}` is what the file
 * tree's "New file" and a fresh `touch` produce, and treating those as a parse
 * failure made the from-blank authoring path unreachable — the deck editor
 * refused to open the very file it needed you to create. They are read as a fresh
 * empty deck instead; a file with *content* that will not parse is still an error,
 * because overwriting an author's malformed-but-real JSON with a blank deck is the
 * loss this module exists to prevent.
 */
export function parseDeck(text: string, base: string | null = null): ParseResult {
  if (text.trim() === "") {
    return { deck: emptyDeck(base), version: DECK_VERSION, lossy: false };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return {
      deck: emptyDeck(base),
      error: `not valid JSON: ${String(e)}`,
      version: DECK_VERSION,
      lossy: false,
    };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      deck: emptyDeck(base),
      error: "not a deck object",
      version: DECK_VERSION,
      lossy: false,
    };
  }
  if (Object.keys(raw as Record<string, unknown>).length === 0) {
    return { deck: emptyDeck(base), version: DECK_VERSION, lossy: false };
  }
  return normalizeDeck(raw as Record<string, unknown>, base);
}

// --- coercion helpers ------------------------------------------------------
// Each returns the fallback rather than throwing: see the module note on why a
// malformed field must never cost the author the rest of the deck.

const num = (v: unknown, fb: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fb;

const str = (v: unknown, fb: string): string => (typeof v === "string" ? v : fb);

const bool = (v: unknown, fb: boolean): boolean =>
  typeof v === "boolean" ? v : fb;

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fb: T): T =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fb;

/** A hex color, or the fallback. Accepts `#rgb`, `#rrggbb`, `#rrggbbaa`. */
const color = (v: unknown, fb: string): string =>
  typeof v === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v) ? v : fb;

/** Clamp into 0..1. Geometry outside the page is legal (an object can hang off
 *  the edge) so only genuinely unbounded fields use this. */
const unit = (v: unknown, fb: number): number => {
  const n = num(v, fb);
  return Math.min(1, Math.max(0, n));
};

/**
 * A font family: one of the three built-ins, or `{ custom: "<path>" }` for an
 * embedded face (#120). An unrecognisable value falls back to the default rather
 * than to nothing — a deck whose font file was renamed must still render.
 */
function normalizeFamily(v: unknown, fb: FontFamily): FontFamily {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const c = (v as Record<string, unknown>).custom;
    if (typeof c === "string" && c) return { custom: c };
    return fb;
  }
  return oneOf(v, ["sans", "serif", "mono"] as const, typeof fb === "string" ? fb : "sans");
}

function normalizeTextStyle(v: unknown): TextStyle {
  const d = defaultTextStyle();
  if (!v || typeof v !== "object") return d;
  const o = v as Record<string, unknown>;
  return {
    family: normalizeFamily(o.family, d.family),
    size: Math.max(1, num(o.size, d.size)),
    bold: bool(o.bold, d.bold),
    italic: bool(o.italic, d.italic),
    color: color(o.color, d.color),
    align: oneOf(o.align, ["left", "center", "right"] as const, d.align),
    lineHeight: Math.max(0.5, num(o.lineHeight, d.lineHeight)),
  };
}

/**
 * Mint an id for a normalized slide/object, defending against **duplicates**.
 *
 * The id design exists to survive a git merge that lands the same object twice
 * (`model.ts`'s note), but the reader only ever minted one when the field was
 * *missing* — so a merge that duplicated an object left two objects sharing an
 * id, and every `updateObjects`/`removeObjects`/selection acted on both at once.
 * A duplicated *slide* id is worse: it corrupts `reconcile`'s `placed` map.
 * Re-minting on collision is counted as a repair, so the author is told.
 */
function claimId(
  raw: unknown,
  seen: Set<string>,
  mint: () => string,
  report: (what: string) => void,
): string {
  const declared = str(raw, "");
  if (declared && !seen.has(declared)) {
    seen.add(declared);
    return declared;
  }
  if (declared) report("duplicate id");
  let id = mint();
  while (seen.has(id)) id = mint();
  seen.add(id);
  return id;
}

function normalizeObject(
  v: unknown,
  seen: Set<string>,
  report: (what: string) => void,
): DeckObject | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const kind = o.kind;
  const common = {
    id: claimId(o.id, seen, newObjectId, report),
    x: num(o.x, 0),
    y: num(o.y, 0),
    w: Math.max(0, num(o.w, 0.2)),
    h: Math.max(0, num(o.h, 0.1)),
    rot: num(o.rot, 0),
    opacity: unit(o.opacity, 1),
    ...(bool(o.locked, false) ? { locked: true } : {}),
    ...(bool(o.hidden, false) ? { hidden: true } : {}),
    ...(o.build && typeof o.build === "object"
      ? {
          build: {
            step: Math.max(0, Math.round(num((o.build as Record<string, unknown>).step, 0))),
            effect: oneOf(
              (o.build as Record<string, unknown>).effect,
              ["none", "fade", "rise", "scale", "wipe", "draw"] as const,
              "fade",
            ),
          },
        }
      : {}),
  };

  switch (kind) {
    case "text":
      return {
        ...common,
        kind: "text",
        text: str(o.text, ""),
        style: normalizeTextStyle(o.style),
        ...(o.list && typeof o.list === "object"
          ? {
              list: {
                kind: oneOf(
                  (o.list as Record<string, unknown>).kind,
                  ["bullet", "number", "alpha", "roman"] as const,
                  "bullet",
                ),
                start: Math.max(1, Math.round(num((o.list as Record<string, unknown>).start, 1))),
              },
            }
          : {}),
        ...(typeof o.fill === "string" ? { fill: color(o.fill, "#ffffff") } : {}),
        ...(typeof o.stroke === "string" ? { stroke: color(o.stroke, "#111111") } : {}),
        ...(typeof o.strokeWidth === "number" ? { strokeWidth: Math.max(0, o.strokeWidth) } : {}),
        padding: Math.max(0, num(o.padding, 2)),
      };
    case "image":
      // An image with no source cannot render and cannot be repaired — dropping
      // it is the honest outcome, and it is reported as a repair.
      if (typeof o.src !== "string" || !o.src) return null;
      return {
        ...common,
        kind: "image",
        src: o.src,
        fit: oneOf(o.fit, ["contain", "cover", "stretch"] as const, "contain"),
        ...(typeof o.texSrc === "string" && o.texSrc ? { texSrc: o.texSrc } : {}),
      };
    case "shape":
      return {
        ...common,
        kind: "shape",
        shape: oneOf(
          o.shape,
          ["rect", "roundrect", "ellipse", "line", "arrow", "callout"] as const,
          "rect",
        ),
        ...(typeof o.fill === "string" ? { fill: color(o.fill, "#ffffff") } : {}),
        stroke: color(o.stroke, "#111111"),
        strokeWidth: Math.max(0, num(o.strokeWidth, 1.5)),
        ...(typeof o.radius === "number" ? { radius: unit(o.radius, 0.1) } : {}),
        ...(typeof o.head === "string"
          ? { head: oneOf(o.head, ["none", "arrow", "dot", "bar"] as const, "none") }
          : {}),
        ...(typeof o.tail === "string"
          ? { tail: oneOf(o.tail, ["none", "arrow", "dot", "bar"] as const, "none") }
          : {}),
      };
    case "icon":
      if (typeof o.icon !== "string" || !o.icon) return null;
      return {
        ...common,
        kind: "icon",
        icon: o.icon,
        color: color(o.color, "#111111"),
        strokeWidth: Math.max(0, num(o.strokeWidth, 1.5)),
      };
    default:
      // An unknown kind is most likely a NEWER build's object. Dropping it is
      // lossy but unavoidable — we cannot render or round-trip what we can't
      // model — so it is counted as a repair rather than passed over in silence.
      return null;
  }
}

function normalizeInterstitial(v: unknown): Interstitial | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.src !== "string" || !o.src) return null;
  const adv = (o.advance ?? {}) as Record<string, unknown>;
  const on = oneOf(adv.on, ["manual", "end", "end-after"] as const, "manual");
  return {
    id: str(o.id, "") || `g${Math.random().toString(36).slice(2, 8)}`,
    src: o.src,
    fit: oneOf(o.fit, ["contain", "cover"] as const, "contain"),
    background: color(o.background, "#000000"),
    advance:
      on === "end-after"
        ? { on, loops: Math.max(1, Math.round(num(adv.loops, 1))) }
        : { on },
    poster: Math.max(0, Math.round(num(o.poster, 0))),
  };
}

function normalizeObjects(
  v: unknown,
  seen: Set<string>,
  report: (what: string) => void,
  lose: (why: string) => void,
): ObjectList {
  if (!Array.isArray(v)) return [];
  const out: ObjectList = [];
  for (const raw of v) {
    const o = normalizeObject(raw, seen, report);
    if (o) out.push(o);
    else {
      report("object");
      lose(translate(useI18nStore.getState().lang, "deckSidecar.lossUnknownObject"));
    }
  }
  return out;
}

function normalizeSlide(
  v: unknown,
  seen: Set<string>,
  report: (what: string) => void,
  lose: (why: string) => void,
): Slide | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const anchorRaw = (o.anchor ?? {}) as Record<string, unknown>;
  const page = Math.max(1, Math.round(num(anchorRaw.page, 1)));
  const after = normalizeInterstitial(o.after);
  return {
    id: claimId(o.id, seen, newSlideId, report),
    anchor: {
      page,
      ...(typeof anchorRaw.line === "number"
        ? { line: Math.max(1, Math.round(anchorRaw.line)) }
        : {}),
      ...(typeof anchorRaw.print === "string" ? { print: anchorRaw.print } : {}),
    },
    objects: normalizeObjects(o.objects, seen, report, lose),
    notes: str(o.notes, ""),
    transition: oneOf(
      o.transition,
      ["none", "fade", "push", "wipe"] as const satisfies readonly Transition[],
      "none",
    ),
    ...(after ? { after } : {}),
    ...(bool(o.skip, false) ? { skip: true } : {}),
    // A per-slide page box is only recorded when it genuinely differs, so the
    // common deck stays free of two redundant numbers per slide.
    ...(typeof o.pageWidth === "number" && Number.isFinite(o.pageWidth) && o.pageWidth > 0
      ? { pageWidth: o.pageWidth }
      : {}),
    ...(typeof o.pageHeight === "number" && Number.isFinite(o.pageHeight) && o.pageHeight > 0
      ? { pageHeight: o.pageHeight }
      : {}),
  };
}

function normalizeFooter(v: unknown): DeckFooter | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const d = defaultFooter();
  return {
    text: str(o.text, d.text),
    align: oneOf(o.align, ["left", "center", "right"] as const satisfies readonly TextAlign[], d.align),
    size: Math.max(1, num(o.size, d.size)),
    color: color(o.color, d.color),
    offset: unit(o.offset, d.offset),
    skipFirst: bool(o.skipFirst, d.skipFirst),
  };
}

/**
 * Coerce an arbitrary parsed object into a renderable {@link Deck}, reporting
 * whatever had to be repaired. Never throws.
 */
export function normalizeDeck(
  raw: Record<string, unknown>,
  base: string | null = null,
): ParseResult {
  const repairs: string[] = [];
  const report = (what: string) => repairs.push(what);
  const losses: string[] = [];
  const lose = (why: string) => {
    if (!losses.includes(why)) losses.push(why);
  };
  // One namespace for slide and object ids: they are minted from disjoint
  // prefixes, and sharing the set means a hand-edit that collided the two is
  // repaired rather than trusted.
  const seen = new Set<string>();

  const themeRaw = (raw.theme ?? {}) as Record<string, unknown>;
  const dt = defaultTheme();

  const slides: Slide[] = [];
  if (Array.isArray(raw.slides)) {
    for (const s of raw.slides) {
      const slide = normalizeSlide(s, seen, report, lose);
      if (slide) slides.push(slide);
      else {
        report("slide");
        lose(translate(useI18nStore.getState().lang, "deckSidecar.lossUnreadableSlide"));
      }
    }
  }

  const detached: DetachedLayer[] = [];
  if (Array.isArray(raw.detached)) {
    for (const d of raw.detached) {
      if (!d || typeof d !== "object") continue;
      const o = d as Record<string, unknown>;
      const fromRaw = (o.from ?? {}) as Record<string, unknown>;
      detached.push({
        from: { page: Math.max(1, Math.round(num(fromRaw.page, 1))) },
        objects: normalizeObjects(o.objects, seen, report, lose),
        notes: str(o.notes, ""),
      });
    }
  }

  const version = num(raw.version, DECK_VERSION);

  const deck: Deck = {
    // The version the FILE declared, carried through verbatim rather than
    // stamped with this build's. Stamping is what turned "open a newer deck" into
    // "silently downgrade it", because the autosave 800 ms later then wrote the
    // coerced result back under a version number claiming it was fine.
    version,
    base: typeof raw.base === "string" ? raw.base : base,
    source: typeof raw.source === "string" ? raw.source : null,
    pageWidth: Math.max(1, num(raw.pageWidth, DEFAULT_PAGE_WIDTH)),
    pageHeight: Math.max(1, num(raw.pageHeight, DEFAULT_PAGE_HEIGHT)),
    slides,
    detached,
    theme: {
      text: normalizeTextStyle(themeRaw.text),
      shapeFill: color(themeRaw.shapeFill, dt.shapeFill),
      shapeStroke: color(themeRaw.shapeStroke, dt.shapeStroke),
      shapeStrokeWidth: Math.max(0, num(themeRaw.shapeStrokeWidth, dt.shapeStrokeWidth)),
      iconColor: color(themeRaw.iconColor, dt.iconColor),
      iconStrokeWidth: Math.max(0, num(themeRaw.iconStrokeWidth, dt.iconStrokeWidth)),
      margin: unit(themeRaw.margin, dt.margin),
      exportInterstitials: bool(themeRaw.exportInterstitials, dt.exportInterstitials),
      ...(normalizeFooter(themeRaw.footer) ? { footer: normalizeFooter(themeRaw.footer)! } : {}),
    },
    ...(Array.isArray(raw.skippedPrints)
      ? { skippedPrints: raw.skippedPrints.filter((p): p is string => typeof p === "string") }
      : {}),
  };

  if (version > DECK_VERSION) {
    repairs.push(`written by a newer ${BRAND.display} (deck v${version})`);
    lose(translate(useI18nStore.getState().lang, "deckSidecar.lossNewerVersion", { version }));
  }

  return {
    deck,
    version,
    lossy: losses.length > 0,
    ...(losses.length ? { lossReason: losses.join("; ") } : {}),
    ...(repairs.length ? { repaired: summarize(repairs) } : {}),
  };
}

function summarize(repairs: string[]): string {
  const counts = new Map<string, number>();
  for (const r of repairs) counts.set(r, (counts.get(r) ?? 0) + 1);
  return [...counts.entries()]
    .map(([what, n]) => (n > 1 ? `${n} ${what}s` : what))
    .join(", ");
}

// ---------------------------------------------------------------------------
// Anchoring
// ---------------------------------------------------------------------------

/** A page of the base PDF, as the viewer reads it out of pdf.js. */
export interface BasePage {
  /** 1-based. */
  page: number;
  /** Page box in points. */
  width: number;
  height: number;
  /** Extracted text, already collapsed to single spaces by the caller. */
  text: string;
  /**
   * How many text runs pdf.js found on the page. Part of the fingerprint — see
   * {@link fingerprint} on why a character prefix alone is not enough.
   */
  items?: number;
  /**
   * Source lines SyncTeX says contributed to this page, when the deck has a
   * `.tex`. This is the *good* anchor — see {@link SlideAnchor}.
   */
  lines?: number[];
}

/** How many characters of page text each half of the fingerprint covers. Enough
 *  to tell two slides apart, short enough that editing a slide's body does not
 *  break it. */
export const FINGERPRINT_CHARS = 200;

/**
 * A stable id for a base page's *content*.
 *
 * It has to survive the author fixing a typo (or a deck re-anchors constantly)
 * while still telling two pages apart (or it re-anchors *wrongly*, which is
 * worse). Text before layout, so a font change does not move it.
 *
 * **Why it is not just the first 200 characters.** A Beamer `\pause` — the single
 * most common thing in an academic deck — emits consecutive pages whose leading
 * text is identical *by construction*. A prefix-only fingerprint gives them the
 * same value, which step 3 of `reconcile` then refuses to trust (rightly: two
 * pages claiming one fingerprint carry no information), so every overlay page
 * fell through to the order fallback. So the fingerprint also carries:
 *
 *  - the **run count**, which grows with each revealed overlay and is completely
 *    unmoved by fixing a typo — the ideal discriminator here; and
 *  - a hash of the **last** 200 characters, since an overlay's new content
 *    arrives at the end.
 *
 * Both are chosen for that asymmetry: they separate overlays without making an
 * ordinary edit invalidate every page's anchor.
 */
export function fingerprint(p: Pick<BasePage, "width" | "height" | "text" | "items">): string {
  const collapsed = p.text.replace(/\s+/g, " ").trim().toLowerCase();
  const head = collapsed.slice(0, FINGERPRINT_CHARS);
  const tail = collapsed.slice(-FINGERPRINT_CHARS);
  return [
    `${Math.round(p.width)}x${Math.round(p.height)}`,
    p.items ?? 0,
    hash(head),
    hash(tail),
  ].join(":");
}

/** FNV-1a, 32-bit, hex. Not cryptographic — it only has to be stable and cheap. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export interface ReconcileResult {
  deck: Deck;
  /** Slides whose base page moved under them. */
  moved: number;
  /** Slides added because the base gained pages. */
  added: number;
  /** Layers that could not be re-attached and went to `deck.detached`. */
  detached: number;
  /** True when nothing had to change — the overwhelmingly common case. */
  unchanged: boolean;
  /**
   * More than one slide **carrying content** was placed by the order fallback
   * alone — i.e. with no line and no unique fingerprint to go on.
   *
   * The order fallback hands out uncovered pages in *deck* order, so on a deck
   * the author has manually reordered it can re-anchor layers onto the wrong
   * pages. One such slide is the ordinary "you edited a slide" case; several at
   * once means the base changed in a way nothing here can match, and the caller
   * must **hold the autosave** rather than persist a guess.
   */
  ambiguous: boolean;
}

/** Does a slide hold anything worth preserving? An empty one is free to drop. */
function hasContent(s: Slide): boolean {
  return s.objects.length > 0 || s.notes.trim() !== "" || s.after != null;
}

/**
 * Re-attach `deck`'s slides to `pages` after the base PDF changed.
 *
 * Resolution order, cheapest and most trustworthy first:
 *
 *  1. **Nothing moved** — same page count and every recorded fingerprint still
 *     matches its page. Returns untouched (bar refreshed fingerprints).
 *  2. **SyncTeX line** — a slide anchored to source line *L* claims the page
 *     whose `lines` contain *L*. Survives insertion/deletion/reordering of other
 *     slides, because it is anchored to the author's own source.
 *  3. **Fingerprint** — for an imported PDF with no source.
 *  4. **Order** — remaining slides fill remaining pages front to back.
 *
 * Slides with content that still find no page go to `deck.detached`; empty ones
 * are dropped, since there is nothing to lose. Pages with no slide get a blank
 * one, so the deck always covers the whole base.
 */
export function reconcile(deck: Deck, pages: BasePage[]): ReconcileResult {
  if (pages.length === 0) {
    // A base that reports no pages is a failed load, not an empty document.
    // Changing nothing is the only safe response — wiping every layer because
    // pdf.js hiccuped would be exactly the silent loss this module exists to
    // prevent.
    return { deck, moved: 0, added: 0, detached: 0, unchanged: true, ambiguous: false };
  }

  const prints = pages.map((p) => fingerprint(p));

  /**
   * Record a page's own box on a slide, but **only when it differs from the
   * deck's** — a deck that keeps one size stays free of two redundant numbers
   * per slide, and one that mixes sizes (a portrait appendix, an inserted
   * landscape figure) stops scaling every layer by page 1's box (#112).
   */
  const boxOf = (p: BasePage): Pick<Slide, "pageWidth" | "pageHeight"> =>
    Math.abs(p.width - pages[0].width) < 0.5 && Math.abs(p.height - pages[0].height) < 0.5
      ? {}
      : { pageWidth: p.width, pageHeight: p.height };

  // 1 — fast path.
  const sameCount = deck.slides.length === pages.length;
  const allMatch =
    sameCount &&
    deck.slides.every((s, i) => {
      if (s.anchor.page !== i + 1) return false;
      return s.anchor.print == null || s.anchor.print === prints[i];
    });
  if (allMatch) {
    return {
      deck: {
        ...deck,
        pageWidth: pages[0].width,
        pageHeight: pages[0].height,
        slides: deck.slides.map((s, i) => ({
          ...s,
          ...boxOf(pages[i]),
          anchor: {
            ...s.anchor,
            page: i + 1,
            print: prints[i],
            ...lineOf(pages[i]),
          },
        })),
      },
      moved: 0,
      added: 0,
      detached: 0,
      unchanged: true,
      ambiguous: false,
    };
  }

  // A page may be backed by MORE THAN ONE slide — that is what makes duplicating a
  // slide durable: the copy shares its original's page (same line/fingerprint) and
  // both survive a reload. So placement records which pages are *covered* rather
  // than reserving each page for a single slide; only the order fallback (step 4),
  // which has no evidence to share on, still hands out one uncovered page apiece.
  const placed = new Map<string, number>(); // slide id → 0-based page index
  const covered = new Set<number>();
  const place = (slide: Slide, idx: number): void => {
    if (idx < 0 || idx >= pages.length) return;
    placed.set(slide.id, idx);
    covered.add(idx);
  };

  // 2 — SyncTeX line.
  //
  // A line is not a unique key: a Beamer frame with `\pause`/overlays emits
  // SEVERAL pages from the same source lines, so a line names a *frame*, not a
  // page. Matching therefore happens **within the group** — the k-th slide
  // anchored to line L claims the k-th page L produced. That is exactly the
  // author's own mental model, and it survives inserting a frame above (every
  // other frame keeps its own lines) in a way no content heuristic can.
  const pagesOfLine = new Map<number, number[]>();
  pages.forEach((p, i) => {
    const l = firstLine(p);
    if (l == null) return;
    const list = pagesOfLine.get(l);
    if (list) list.push(i);
    else pagesOfLine.set(l, [i]);
  });
  const takenOfLine = new Map<number, number>();
  for (const s of deck.slides) {
    if (s.anchor.line == null) continue;
    const list = pagesOfLine.get(s.anchor.line);
    if (!list) continue;
    const k = takenOfLine.get(s.anchor.line) ?? 0;
    if (k >= list.length) continue;
    takenOfLine.set(s.anchor.line, k + 1);
    place(s, list[k]);
  }

  // 3 — fingerprint. Only unique fingerprints are trusted: two identical pages
  // (a repeated section divider, say) carry no information about which slide is
  // which, and guessing there would shuffle layers between them.
  const printIdx = new Map<string, number[]>();
  prints.forEach((p, i) => {
    const list = printIdx.get(p);
    if (list) list.push(i);
    else printIdx.set(p, [i]);
  });
  for (const s of deck.slides) {
    if (placed.has(s.id) || s.anchor.print == null) continue;
    const hits = printIdx.get(s.anchor.print);
    if (hits?.length === 1) place(s, hits[0]);
  }

  // 4 — order. Remaining slides take remaining UNCOVERED pages, front to back,
  // preserving their relative order so a deck that merely gained a page at the end
  // does the obvious thing.
  //
  // This step has NO evidence behind it — it hands out pages in deck order, which
  // on a manually reordered deck can re-anchor layers onto the wrong pages. One
  // slide arriving here is the ordinary "you edited this slide" case; several
  // content-bearing ones at once means the base changed in a way nothing above
  // could match, and that is reported as `ambiguous` so the caller can hold the
  // autosave instead of persisting a guess.
  let cursor = 0;
  const orphans: Slide[] = [];
  let guessed = 0;
  for (const s of deck.slides) {
    if (placed.has(s.id)) continue;
    while (cursor < pages.length && covered.has(cursor)) cursor += 1;
    if (cursor < pages.length) {
      if (hasContent(s)) guessed += 1;
      place(s, cursor);
    } else orphans.push(s);
  }

  // Assemble preserving the deck's OWN slide order. The presentation sequence is
  // the author's, not the base PDF's page order — a manual reorder must survive a
  // reload, and a recompile only re-anchors each slide to the page it now backs.
  // (A slide keeps the page it claimed above, so a pure reorder re-claims every
  // page by fingerprint/line and `moved` stays 0.)
  let moved = 0;
  let added = 0;
  const slides: Slide[] = [];
  for (const s of deck.slides) {
    const idx = placed.get(s.id);
    if (idx == null) continue; // an orphan — collected into `newlyDetached` below
    if (idx + 1 !== s.anchor.page) moved += 1;
    slides.push({
      ...s,
      ...boxOf(pages[idx]),
      anchor: { ...s.anchor, page: idx + 1, print: prints[idx], ...lineOf(pages[idx]) },
    });
  }

  // Cover every base page: a page no slide claimed is a frame the source just
  // grew, so it gets a blank slide, spliced in before the first slide backing a
  // later page (i.e. in page order relative to the placed slides) rather than
  // dumped at the end. Blank slides carry nothing, so placement is cosmetic, never
  // lossy.
  //
  // Except a page the author DELETED a slide for. Without that exception this
  // loop resurrects it on the very next load, which is what made deleting a title
  // page or a backup frame impossible short of hand-editing the JSON (#106). The
  // record is by fingerprint, not page number, because a page number stops meaning
  // anything the moment the source is recompiled.
  const skipped = new Set(deck.skippedPrints ?? []);
  for (let i = 0; i < pages.length; i += 1) {
    if (covered.has(i)) continue;
    if (skipped.has(prints[i])) continue;
    added += 1;
    let at = slides.length;
    for (let j = 0; j < slides.length; j += 1) {
      if (slides[j].anchor.page > i + 1) {
        at = j;
        break;
      }
    }
    slides.splice(at, 0, {
      ...blankSlide(i + 1),
      ...boxOf(pages[i]),
      anchor: { page: i + 1, print: prints[i], ...lineOf(pages[i]) },
    });
  }

  const newlyDetached: DetachedLayer[] = orphans
    .filter(hasContent)
    .map((s) => ({ from: s.anchor, objects: s.objects, notes: s.notes }));

  return {
    deck: {
      ...deck,
      pageWidth: pages[0].width,
      pageHeight: pages[0].height,
      slides,
      detached: [...deck.detached, ...newlyDetached],
    },
    moved,
    added,
    detached: newlyDetached.length,
    unchanged: false,
    ambiguous: guessed > 1,
  };
}

/**
 * The source line a page's slide is anchored to: the **lowest** line SyncTeX
 * attributed to it.
 *
 * The lowest rather than any other because a frame's opening `\begin{frame}` is
 * the line that does not move when its body is edited — the whole point of
 * preferring a source anchor to a content one.
 */
function firstLine(p: BasePage): number | null {
  const lines = p.lines;
  if (!lines || lines.length === 0) return null;
  let min = Infinity;
  for (const l of lines) if (l > 0 && l < min) min = l;
  return Number.isFinite(min) ? min : null;
}

/** `{ line }` for a page SyncTeX could place, `{}` otherwise — spreadable into
 *  an anchor so a plate with no source simply records nothing. */
function lineOf(p: BasePage): { line?: number } {
  const l = firstLine(p);
  return l == null ? {} : { line: l };
}

/**
 * Move a detached layer's objects back onto a slide, appending them on top.
 *
 * Re-attaching merges rather than replaces: the slide may have gained its own
 * content since the layer came adrift, and silently overwriting it would be the
 * same loss this module exists to prevent, just in the other direction.
 */
export function reattach(deck: Deck, detachedIndex: number, slideIndex: number): Deck {
  const layer = deck.detached[detachedIndex];
  if (!layer || slideIndex < 0 || slideIndex >= deck.slides.length) return deck;
  return {
    ...deck,
    slides: deck.slides.map((s, i) =>
      i === slideIndex
        ? {
            ...s,
            objects: [...s.objects, ...layer.objects],
            notes: [s.notes, layer.notes].filter((t) => t.trim()).join("\n\n"),
          }
        : s,
    ),
    detached: deck.detached.filter((_, i) => i !== detachedIndex),
  };
}
