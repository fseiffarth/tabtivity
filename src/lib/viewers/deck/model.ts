/**
 * The presentation-deck model — the `pageModel` of the native presenter
 * (`docs/deck_presenter_plan.md`), and like it: **pure**. Every operation takes a
 * list and returns a new one, so a history stack is an array of snapshots and
 * rendering is a straight `map`.
 *
 * Three ideas are worth internalising before reading the types.
 *
 * **The PDF is a background plate, not the document.** A deck lives in its own
 * `*.eldeck.json` sidecar beside the base PDF. TeX regenerates that PDF on every
 * compile, so anything stored *inside* it dies the next time the author fixes a
 * typo. The sidecar survives arbitrarily many recompiles — and, being tracked
 * text, it diffs, merges, and rides git lockstep to a remote host like any source
 * file.
 *
 * **Geometry is normalized, type size is not.** Every object's `x/y/w/h` is a
 * fraction (0..1) of the page box — the same choice `PresentationOverlay` makes
 * for marker strokes — so zoom, a pane resize, a projector and an export at any
 * DPI need no conversion table. Font size is in **PDF points**, because that is
 * absolute: changing the base plate's size should move a caption, not reflow it
 * to 19pt.
 *
 * **A GIF is a sequence entry, not an effect.** A PDF cannot carry animation at
 * all, so `Slide.after` holds an {@link Interstitial}: a clip that plays *between*
 * this slide and the next, occupying its own step in the presentation. That is
 * what lets a pure TeX-generated deck show a training curve moving without
 * leaving the deck. It is deliberately not a transition (`Transition` is the
 * separate, purely cosmetic axis) and not an object (it never composites onto a
 * page).
 */

/** Bumped only for a change old readers cannot survive. `sidecar.ts` migrates. */
export const DECK_VERSION = 1;

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/**
 * Ids must be unique across *sessions and branches*, not just within one list —
 * a deck is a persisted, git-merged file, so the plain counter `pageModel` uses
 * would hand the same `o7` to two branches that both added an object and let the
 * merge silently fuse them. Hence counter + random suffix.
 */
let idCounter = 0;
let randomSuffix: () => string = () =>
  Math.random().toString(36).slice(2, 6);

/** Install a deterministic suffix source. Tests only. */
export function setIdSuffixSource(fn: () => string): void {
  randomSuffix = fn;
}

/** Reset the id counter. Tests only. */
export function resetIdCounter(): void {
  idCounter = 0;
}

function mintId(prefix: string): string {
  idCounter += 1;
  return `${prefix}${idCounter.toString(36)}${randomSuffix()}`;
}

export const newObjectId = (): string => mintId("o");
export const newSlideId = (): string => mintId("s");
export const newInterstitialId = (): string => mintId("g");

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * A deck's type: one of the three standard-14 families, or an **embedded** face
 * named by the path of the font file it comes from.
 *
 * The load-bearing constraint is not "standard-14 only" — it is that *one*
 * module measures and embeds (`deck/fonts.ts`), so the stage and the exporter
 * break lines identically **by construction** rather than by luck. The standard
 * families keep that for free (pdf-lib carries their metrics). A custom face
 * keeps it by the same rule stated explicitly: the bytes registered for
 * measurement must be the bytes embedded on export, so both sides take the file
 * path as the key and the same `fonts` map as the source.
 *
 * A Beamer plate is typeset in Computer Modern / Latin Modern, so with
 * standard-14 alone *every* layer caption sat in Helvetica on top of it — and a
 * non-Latin talk was out of reach entirely, since the standard faces are WinAnsi
 * (TODO V #96/#120).
 */
export type FontFamily = "sans" | "serif" | "mono" | { custom: string };

/** The three built-in families, for a control that offers them. */
export const STANDARD_FAMILIES = ["sans", "serif", "mono"] as const;

/** The font-file path of a custom family, or null for a standard one. */
export function customFontPath(f: FontFamily): string | null {
  return typeof f === "object" && typeof f.custom === "string" ? f.custom : null;
}

/** A stable key for a family, usable as a map key and in a `<select>` value. */
export function fontKey(f: FontFamily): string {
  const custom = customFontPath(f);
  return custom ? `custom:${custom}` : (f as string);
}

/** Every custom font path a deck references, deduplicated. The viewer reads
 *  these files and hands their bytes to both the metrics and the exporter. */
export function customFontsOf(deck: Deck): string[] {
  const out = new Set<string>();
  const add = (f: FontFamily | undefined) => {
    const p = f && customFontPath(f);
    if (p) out.add(p);
  };
  add(deck.theme.text.family);
  for (const s of deck.slides) {
    for (const o of s.objects) if (o.kind === "text") add(o.style.family);
  }
  return [...out];
}

export type TextAlign = "left" | "center" | "right";

export interface TextStyle {
  family: FontFamily;
  /** PDF points — absolute, unlike the geometry around it. */
  size: number;
  bold: boolean;
  italic: boolean;
  /** `#rrggbb`. */
  color: string;
  align: TextAlign;
  /** Baseline-to-baseline distance as a multiple of `size`. */
  lineHeight: number;
}

export type ListKind = "bullet" | "number" | "alpha" | "roman";

/**
 * An "enumeration field" is a **style on a text object**, not an object kind of
 * its own. Modeling it this way is what makes renumbering automatic, nesting fall
 * out of per-line indent, and — the one that matters — stepped reveal free: list
 * item *i* becomes build step *i* in one click, which is the most-used animation
 * in any talk.
 */
export interface ListStyle {
  kind: ListKind;
  /** First ordinal (1 = "1." / "a." / "i."). Ignored for `bullet`. */
  start: number;
}

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

export type BuildEffect = "none" | "fade" | "rise" | "scale" | "wipe" | "draw";

/** When an object appears within its slide. `step: 0` = visible on entry. */
export interface BuildStep {
  step: number;
  effect: BuildEffect;
}

interface ObjectBase {
  id: string;
  /** All four are fractions of the page box, 0..1. See the module note. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Degrees clockwise. Free, unlike a PDF `/Rotate`. */
  rot: number;
  /** 0..1. */
  opacity: number;
  locked?: boolean;
  hidden?: boolean;
  build?: BuildStep;
}

export interface TextObject extends ObjectBase {
  kind: "text";
  text: string;
  style: TextStyle;
  list?: ListStyle;
  /** Box fill behind the text, `#rrggbb`. Absent = transparent. */
  fill?: string;
  stroke?: string;
  /** Points. */
  strokeWidth?: number;
  /** Inset between the box and the text, in points. */
  padding: number;
}

export type ImageFit = "contain" | "cover" | "stretch";

export interface ImageObject extends ObjectBase {
  kind: "image";
  /** Project-relative path. Relative so a deck survives being moved or synced. */
  src: string;
  fit: ImageFit;
  /**
   * Project-relative path to the `.tex` source that generates `src`, when this
   * image is a **TeX figure** rather than an ordinary picture — placed via the
   * deck toolbar's TeX FAB. `src` is a rasterized PNG of the compiled PDF's first
   * page; Tabtivity regenerates it whenever that PDF's mtime advances, so editing
   * and recompiling the source (in its own tab) updates the slide in place. Absent
   * for a plain image.
   */
  texSrc?: string;
}

/**
 * Shapes are parametric path generators (`deck/shapes.ts`), and icons are
 * single-path SVG data (`deck/icons.ts`), for one reason: pdf-lib emits vector
 * art through `drawSvgPath`, which accepts path data and nothing else — no
 * gradients, no groups, no SVG document. One renderer and one exporter therefore
 * cover both, and the constraint is what picks the icon set (Lucide/Feather-shaped
 * monochrome single-path icons).
 */
export type ShapeKind =
  | "rect"
  | "roundrect"
  | "ellipse"
  | "line"
  | "arrow"
  | "callout";

export type ArrowHead = "none" | "arrow" | "dot" | "bar";

export interface ShapeObject extends ObjectBase {
  kind: "shape";
  shape: ShapeKind;
  fill?: string;
  stroke: string;
  /** Points. */
  strokeWidth: number;
  /** Corner radius for `roundrect`, as a fraction of the shorter side. */
  radius?: number;
  /** Endpoint markers, for `line`/`arrow`. */
  head?: ArrowHead;
  tail?: ArrowHead;
}

export interface IconObject extends ObjectBase {
  kind: "icon";
  /** Key into `deck/icons.ts`. */
  icon: string;
  color: string;
  strokeWidth: number;
}

export type DeckObject = TextObject | ImageObject | ShapeObject | IconObject;
export type ObjectKind = DeckObject["kind"];

/** An object list, in paint order — index 0 is furthest back. */
export type ObjectList = DeckObject[];

// ---------------------------------------------------------------------------
// Interstitials
// ---------------------------------------------------------------------------

/**
 * How an interstitial ends.
 *
 * `manual` loops until the presenter advances — the right default for a clip the
 * speaker talks over. `end` plays once and advances itself, for a short sting.
 */
export type InterstitialAdvance =
  | { on: "manual" }
  | { on: "end" }
  | { on: "end-after"; loops: number };

/**
 * A GIF that plays **between** the slide carrying it and the next one, as its own
 * step in the presentation sequence.
 *
 * This exists because a TeX-generated PDF cannot carry animation at all: without
 * it the author has to alt-tab to a video player mid-talk. It hangs off a slide
 * rather than living in the slide list so that the slide↔base-page anchoring
 * (`sidecar.ts`) is completely unaffected by it.
 */
export interface Interstitial {
  id: string;
  /** Project-relative path to the `.gif`. */
  src: string;
  /** `contain` letterboxes; `cover` fills and crops. */
  fit: "contain" | "cover";
  /** What shows in the letterbox bars, `#rrggbb`. */
  background: string;
  advance: InterstitialAdvance;
  /**
   * 0-based frame used as the rail thumbnail, and written as a still page by the
   * PDF export — a handout should show a placeholder where the animation was,
   * not an unexplained jump.
   */
  poster: number;
}

// ---------------------------------------------------------------------------
// Slides
// ---------------------------------------------------------------------------

/** Purely cosmetic page-replacement effect. Distinct from an interstitial. */
export type Transition = "none" | "fade" | "push" | "wipe";

/**
 * How a slide finds its base page again after the `.tex` was recompiled.
 *
 * `page` is the answer as of the last successful resolve, and is right in the
 * overwhelmingly common case where nothing structural changed. The other two are
 * what make an *inserted* slide non-destructive:
 *
 *  - `line` — the SyncTeX source line that produced the page. `compile_tex`
 *    already passes `-synctex=1` unconditionally, so this mapping is emitted and
 *    thrown away today. It survives inserting, deleting and reordering other
 *    slides exactly as well as the author's own mental model does, which makes it
 *    strictly better than any content heuristic.
 *  - `print` — a content fingerprint, for an imported PDF that has no source.
 */
export interface SlideAnchor {
  /** 1-based page of the base PDF. */
  page: number;
  line?: number;
  print?: string;
}

export interface Slide {
  id: string;
  anchor: SlideAnchor;
  objects: ObjectList;
  /** Speaker notes, shown only in the presenter view. */
  notes: string;
  transition: Transition;
  /** Plays after this slide, before the next. See {@link Interstitial}. */
  after?: Interstitial;
  /**
   * Keep the slide in the deck but out of the *talk*: skipped by
   * {@link sequence} and by the PDF export.
   *
   * Distinct from deleting it, and the reason both exist: a backup slide for
   * the Q&A, or a section the author cut for a shorter version of the talk, is
   * content they want to keep authoring — the alternative today is deleting it
   * from the `.tex` and losing its layers.
   */
  skip?: boolean;
  /**
   * Page box in points, when this slide's base page differs from the deck's.
   *
   * Absent — the overwhelmingly common case — means "the deck's box". Present
   * for a plate that mixes sizes (a portrait appendix, an inserted landscape
   * figure page), where scaling every layer by page 1's box mis-places them.
   */
  pageWidth?: number;
  pageHeight?: number;
}

/** The page box a slide's layers are scaled against — its own, or the deck's. */
export function slidePageBox(
  deck: Pick<Deck, "pageWidth" | "pageHeight">,
  slide: Pick<Slide, "pageWidth" | "pageHeight"> | undefined,
): { width: number; height: number } {
  return {
    width: slide?.pageWidth ?? deck.pageWidth,
    height: slide?.pageHeight ?? deck.pageHeight,
  };
}

/**
 * Layers that no longer have a base page — the bin a recompile puts orphans in
 * rather than dropping them. A recompile that quietly eats an author's
 * annotations is the failure mode that makes people stop using the tool, so this
 * type exists to make the silent case impossible.
 */
export interface DetachedLayer {
  /** Where it used to live, so the re-attach UI can say something useful. */
  from: SlideAnchor;
  objects: ObjectList;
  notes: string;
}

// ---------------------------------------------------------------------------
// Deck
// ---------------------------------------------------------------------------

/**
 * A footer / slide-number line drawn on every slide.
 *
 * Rendered as a **synthetic text object** ({@link footerObject}) rather than a
 * real one on each slide: it belongs to the deck, so making it N stored objects
 * would mean N edits to change it and N objects to accidentally drag. The
 * renderer and the exporter both draw the synthetic object through their
 * ordinary text path, so it cannot look different in the two places.
 */
export interface DeckFooter {
  /**
   * The line itself. `{n}` expands to the slide's 1-based position in the talk
   * and `{N}` to the number of slides in it — so "{n} / {N}" is a page counter
   * and a bare "{n}" is a slide number.
   */
  text: string;
  align: TextAlign;
  /** PDF points, like every other type size in the deck. */
  size: number;
  color: string;
  /** Distance from the bottom page edge, as a fraction of the page height. */
  offset: number;
  /** Leave the first slide bare — a title page rarely wants a page number. */
  skipFirst: boolean;
}

export function defaultFooter(): DeckFooter {
  return {
    text: "{n}",
    align: "right",
    size: 8,
    color: "#666666",
    offset: 0.03,
    skipFirst: true,
  };
}

/** Defaults a new object inherits, so a deck looks consistent without effort. */
export interface DeckTheme {
  text: TextStyle;
  shapeFill: string;
  shapeStroke: string;
  shapeStrokeWidth: number;
  iconColor: string;
  iconStrokeWidth: number;
  /** Safe-area inset as a fraction of the page, a snapping target. */
  margin: number;
  /** Whether the PDF export writes a poster page per interstitial. */
  exportInterstitials: boolean;
  /** Drawn on every slide (bar the first, optionally). Absent = no footer. */
  footer?: DeckFooter;
}

export interface Deck {
  version: number;
  /** Project-relative path of the base PDF. `null` = no plate yet. */
  base: string | null;
  /** Project-relative path of the `.tex` that generates `base`, when there is one. */
  source: string | null;
  /** Base page box in PDF points. Drives every normalized→absolute conversion. */
  pageWidth: number;
  pageHeight: number;
  slides: Slide[];
  detached: DetachedLayer[];
  theme: DeckTheme;
  /**
   * Fingerprints of base pages the author **deleted** a slide for.
   *
   * Without this, `reconcile`'s "cover every base page" pass resurrects the
   * slide on the very next load, and deleting a title page or a backup frame is
   * impossible short of hand-editing the JSON. Stored as fingerprints rather
   * than page numbers because a page number stops meaning anything the moment
   * the source is recompiled — which is the case the whole anchoring design
   * exists for.
   */
  skippedPrints?: string[];
}

/** 16:9 at the usual TeX beamer size, in points. */
export const DEFAULT_PAGE_WIDTH = 364.19;
export const DEFAULT_PAGE_HEIGHT = 204.85;

export function defaultTextStyle(): TextStyle {
  return {
    family: "sans",
    size: 14,
    bold: false,
    italic: false,
    color: "#111111",
    align: "left",
    lineHeight: 1.25,
  };
}

export function defaultTheme(): DeckTheme {
  return {
    text: defaultTextStyle(),
    shapeFill: "#00000000",
    shapeStroke: "#111111",
    shapeStrokeWidth: 1.5,
    iconColor: "#111111",
    iconStrokeWidth: 1.5,
    margin: 0.05,
    exportInterstitials: true,
  };
}

/**
 * The footer as a drawable text object for slide `index` of `total`, or null
 * when the deck has no footer (or this slide is exempt).
 *
 * Its id is fixed and namespaced (`__footer`) so nothing can select, drag or
 * persist it: it is regenerated from the theme on every render.
 */
export function footerObject(
  deck: Pick<Deck, "theme" | "pageHeight">,
  index: number,
  total: number,
  /** The slide's own page height, when it differs from the deck's (#112). */
  pageHeight: number = deck.pageHeight,
): TextObject | null {
  const f = deck.theme.footer;
  if (!f || !f.text.trim()) return null;
  if (f.skipFirst && index === 0) return null;
  const text = f.text.replace(/\{n\}/g, String(index + 1)).replace(/\{N\}/g, String(total));
  const margin = deck.theme.margin;
  // The box is exactly one line tall, sized from the type rather than from the
  // offset — an offset small enough to sit close to the edge would otherwise be
  // a box too short for its own text, which the renderer flags as an overflow.
  const lineH = Math.max(0.001, (f.size * 1.15) / Math.max(1, pageHeight));
  return {
    id: "__footer",
    kind: "text",
    text,
    style: {
      family: deck.theme.text.family,
      size: f.size,
      bold: false,
      italic: false,
      color: f.color,
      align: f.align,
      lineHeight: 1.15,
    },
    padding: 0,
    x: margin,
    y: 1 - f.offset - lineH,
    w: Math.max(0.05, 1 - margin * 2),
    h: lineH,
    rot: 0,
    opacity: 1,
  };
}

/** An empty deck over `base`. `slides` is filled by `sidecar.ts` once the base
 *  PDF's page count is known — the model never reads a PDF itself. */
export function emptyDeck(base: string | null, source: string | null = null): Deck {
  return {
    version: DECK_VERSION,
    base,
    source,
    pageWidth: DEFAULT_PAGE_WIDTH,
    pageHeight: DEFAULT_PAGE_HEIGHT,
    slides: [],
    detached: [],
    theme: defaultTheme(),
  };
}

/** A slide showing 1-based `page` of the base plate, with nothing on it. */
export function blankSlide(page: number): Slide {
  return {
    id: newSlideId(),
    anchor: { page },
    objects: [],
    notes: "",
    transition: "none",
  };
}

// ---------------------------------------------------------------------------
// Object operations — all pure, all returning a new list
// ---------------------------------------------------------------------------

/** Append `obj` on top of the stack. */
export function addObject(list: ObjectList, obj: DeckObject): ObjectList {
  return [...list, obj];
}

/**
 * Replace every object in `ids` with `patch(object)`.
 *
 * A function rather than a partial so a caller can compute per-object — nudging a
 * multi-selection needs each object's own `x`, not one shared value.
 * Locked objects are skipped: that is what "locked" means, and enforcing it in
 * one place beats every call site remembering to filter.
 */
export function updateObjects(
  list: ObjectList,
  ids: readonly string[],
  patch: (obj: DeckObject) => DeckObject,
): ObjectList {
  const touching = new Set(ids);
  return list.map((o) => (touching.has(o.id) && !o.locked ? patch(o) : o));
}

/** Drop every object in `ids`. Unknown ids are ignored; locked ones survive. */
export function removeObjects(list: ObjectList, ids: readonly string[]): ObjectList {
  const dropping = new Set(ids);
  return list.filter((o) => !dropping.has(o.id) || o.locked === true);
}

/** Translate `ids` by a normalized delta. */
export function moveObjects(
  list: ObjectList,
  ids: readonly string[],
  dx: number,
  dy: number,
): ObjectList {
  return updateObjects(list, ids, (o) => ({ ...o, x: o.x + dx, y: o.y + dy }));
}

/**
 * Copy every object in `ids`, offset slightly so the copy is visibly on top of
 * its original rather than exactly hiding it. Copies get fresh ids, so they
 * select and move independently.
 */
export const DUPLICATE_OFFSET = 0.02;

export function duplicateObjects(
  list: ObjectList,
  ids: readonly string[],
): { list: ObjectList; ids: string[] } {
  const copying = new Set(ids);
  const fresh: string[] = [];
  const out = list.flatMap((o) => {
    if (!copying.has(o.id)) return [o];
    const id = newObjectId();
    fresh.push(id);
    return [
      o,
      { ...o, id, x: o.x + DUPLICATE_OFFSET, y: o.y + DUPLICATE_OFFSET },
    ];
  });
  return { list: out, ids: fresh };
}

/**
 * Z-order. `toFront`/`toBack` move the selection as a block, preserving its
 * internal order — the same bargain `pageModel.movePages` strikes, and for the
 * same reason: a multi-selection that collapsed into a different order on every
 * raise would be unusable.
 */
export function toFront(list: ObjectList, ids: readonly string[]): ObjectList {
  const moving = new Set(ids);
  return [...list.filter((o) => !moving.has(o.id)), ...list.filter((o) => moving.has(o.id))];
}

export function toBack(list: ObjectList, ids: readonly string[]): ObjectList {
  const moving = new Set(ids);
  return [...list.filter((o) => moving.has(o.id)), ...list.filter((o) => !moving.has(o.id))];
}

/**
 * Raise each selected object one position, walking from the top so a block of
 * adjacent selected objects slides up together instead of the topmost one
 * repeatedly swapping with its selected neighbour and going nowhere.
 */
export function raiseObjects(list: ObjectList, ids: readonly string[]): ObjectList {
  const moving = new Set(ids);
  const out = [...list];
  for (let i = out.length - 2; i >= 0; i -= 1) {
    if (moving.has(out[i].id) && !moving.has(out[i + 1].id)) {
      [out[i], out[i + 1]] = [out[i + 1], out[i]];
    }
  }
  return out;
}

/** Lower each selected object one position. Mirror of {@link raiseObjects}. */
export function lowerObjects(list: ObjectList, ids: readonly string[]): ObjectList {
  const moving = new Set(ids);
  const out = [...list];
  for (let i = 1; i < out.length; i += 1) {
    if (moving.has(out[i].id) && !moving.has(out[i - 1].id)) {
      [out[i], out[i - 1]] = [out[i - 1], out[i]];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Align & distribute
// ---------------------------------------------------------------------------

export type AlignEdge = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";

/**
 * Align the selection to the **bounding box of the selection itself** when two or
 * more objects are selected, and to the *page* when only one is.
 *
 * The single-object case is the one that would otherwise be a no-op, and "align
 * this to the page" is precisely what someone means when they align one thing.
 */
export function alignObjects(
  list: ObjectList,
  ids: readonly string[],
  edge: AlignEdge,
): ObjectList {
  const sel = list.filter((o) => ids.includes(o.id) && !o.locked);
  if (sel.length === 0) return list;
  const box =
    sel.length === 1
      ? { x: 0, y: 0, w: 1, h: 1 }
      : boundingBox(sel);
  return updateObjects(list, ids, (o) => {
    switch (edge) {
      case "left":
        return { ...o, x: box.x };
      case "hcenter":
        return { ...o, x: box.x + (box.w - o.w) / 2 };
      case "right":
        return { ...o, x: box.x + box.w - o.w };
      case "top":
        return { ...o, y: box.y };
      case "vcenter":
        return { ...o, y: box.y + (box.h - o.h) / 2 };
      case "bottom":
        return { ...o, y: box.y + box.h - o.h };
    }
  });
}

/**
 * Space the selection evenly between the two outermost objects, which stay put.
 *
 * Needs three objects to mean anything — with two there is no gap to equalise,
 * and moving either would just be an align in disguise.
 */
export function distributeObjects(
  list: ObjectList,
  ids: readonly string[],
  axis: "h" | "v",
): ObjectList {
  const sel = list.filter((o) => ids.includes(o.id) && !o.locked);
  if (sel.length < 3) return list;
  const pos = (o: DeckObject) => (axis === "h" ? o.x : o.y);
  const len = (o: DeckObject) => (axis === "h" ? o.w : o.h);
  const sorted = [...sel].sort((a, b) => pos(a) - pos(b));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  // Distribute by the GAP between boxes, not by their origins: with mixed widths,
  // equal origin spacing leaves visibly unequal gaps, which is the thing the user
  // is actually trying to fix.
  const span = pos(last) + len(last) - pos(first);
  const total = sorted.reduce((s, o) => s + len(o), 0);
  const gap = (span - total) / (sorted.length - 1);
  const placed = new Map<string, number>();
  let cursor = pos(first);
  for (const o of sorted) {
    placed.set(o.id, cursor);
    cursor += len(o) + gap;
  }
  return updateObjects(list, ids, (o) => {
    const p = placed.get(o.id);
    if (p === undefined) return o;
    return axis === "h" ? { ...o, x: p } : { ...o, y: p };
  });
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The four corners of an object **after** its rotation, in normalized page
 * coordinates.
 *
 * Rotation is about the box's centre (what a rotation handle implies) and the
 * page is not square, so the turn has to happen in an aspect-corrected frame or
 * a 45°-rotated square comes back as a lozenge. `aspect` is `pageWidth /
 * pageHeight`; passing 1 gives the un-corrected turn, which is right when the
 * caller is already working in a square space.
 */
export function rotatedCorners(
  o: Pick<DeckObject, "x" | "y" | "w" | "h" | "rot">,
  aspect = 1,
): Array<[number, number]> {
  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  const corners: Array<[number, number]> = [
    [o.x, o.y],
    [o.x + o.w, o.y],
    [o.x + o.w, o.y + o.h],
    [o.x, o.y + o.h],
  ];
  if (!o.rot) return corners;
  const rad = (o.rot * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return corners.map(([px, py]) => {
    // Into an isotropic frame, turn, and back — otherwise the ellipse-shaped
    // distortion of the page aspect is baked into the result.
    const dx = (px - cx) * aspect;
    const dy = py - cy;
    return [cx + (dx * cos - dy * sin) / aspect, cy + (dx * sin + dy * cos)] as [number, number];
  });
}

/**
 * The tight box around `objects`, honouring each one's rotation. Empty input
 * gives a zero box at the origin.
 *
 * Rotation matters here because this box is what the selection rectangle, the
 * marquee hit test and every align/distribute are computed from — an
 * axis-aligned box over the *unrotated* geometry puts all three in the wrong
 * place for turned content.
 */
export function boundingBox(objects: readonly DeckObject[], aspect = 1): Box {
  if (objects.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const o of objects) {
    for (const [px, py] of rotatedCorners(o, aspect)) {
      x0 = Math.min(x0, px);
      y0 = Math.min(y0, py);
      x1 = Math.max(x1, px);
      y1 = Math.max(y1, py);
    }
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// ---------------------------------------------------------------------------
// Slide operations
// ---------------------------------------------------------------------------

/** Replace the slide at `index` with `patch(slide)`. Out-of-range is a no-op. */
export function updateSlide(
  slides: readonly Slide[],
  index: number,
  patch: (s: Slide) => Slide,
): Slide[] {
  if (index < 0 || index >= slides.length) return [...slides];
  return slides.map((s, i) => (i === index ? patch(s) : s));
}

/** Splice `slide` in before `index` (`>= length` appends). */
export function insertSlide(
  slides: readonly Slide[],
  slide: Slide,
  index: number,
): Slide[] {
  const at = Math.min(Math.max(index, 0), slides.length);
  return [...slides.slice(0, at), slide, ...slides.slice(at)];
}

export function removeSlides(slides: readonly Slide[], ids: readonly string[]): Slide[] {
  const dropping = new Set(ids);
  return slides.filter((s) => !dropping.has(s.id));
}

/**
 * Move the slides in `ids` so the block lands at `toIndex`.
 *
 * `toIndex` counts the slides that are NOT moving — "insert before the
 * `toIndex`-th survivor" — which is the index a drag naturally produces, because
 * the dragged cards are exactly the ones the pointer is not hit-testing against.
 * Same convention as `pageModel.movePages`, deliberately, so the two rails behave
 * identically.
 */
export function moveSlides(
  slides: readonly Slide[],
  ids: readonly string[],
  toIndex: number,
): Slide[] {
  const moving = new Set(ids);
  const selected = slides.filter((s) => moving.has(s.id));
  if (selected.length === 0) return [...slides];
  const rest = slides.filter((s) => !moving.has(s.id));
  const at = Math.min(Math.max(toIndex, 0), rest.length);
  return [...rest.slice(0, at), ...selected, ...rest.slice(at)];
}

// ---------------------------------------------------------------------------
// Presentation sequence
// ---------------------------------------------------------------------------

/**
 * One stop in the presenter: a slide at a given build step, or an interstitial.
 *
 * Flattening the deck into this list up front is what makes the presenter's
 * navigation trivially correct — `←` is `index - 1`, and the awkward cases
 * (a slide with three builds followed by a GIF) are already expanded. In
 * particular it is why `←` steps a build backwards instead of jumping a slide,
 * which is the difference between surviving an audience question and losing the
 * slide.
 */
export type Stop =
  | { kind: "slide"; slide: number; step: number }
  | { kind: "interstitial"; slide: number };

/** The highest build step on a slide; 0 when nothing is animated. */
export function maxBuildStep(slide: Slide): number {
  return slide.objects.reduce((m, o) => Math.max(m, o.build?.step ?? 0), 0);
}

/**
 * Expand the deck into the ordered list of presenter stops.
 *
 * A slide marked `skip` contributes none: it stays in the deck (and in the
 * editor's rail) but is not part of the talk. `Stop.slide` remains an index into
 * `deck.slides`, so the rest of the presenter needs no translation.
 */
export function sequence(deck: Deck): Stop[] {
  const out: Stop[] = [];
  deck.slides.forEach((s, i) => {
    if (s.skip) return;
    const steps = maxBuildStep(s);
    for (let step = 0; step <= steps; step += 1) {
      out.push({ kind: "slide", slide: i, step });
    }
    if (s.after) out.push({ kind: "interstitial", slide: i });
  });
  return out;
}

/** Whether `obj` is visible at build `step`. */
export function visibleAt(obj: DeckObject, step: number): boolean {
  if (obj.hidden) return false;
  return (obj.build?.step ?? 0) <= step;
}

/**
 * Assign consecutive build steps to `ids`, in their current paint order — the
 * one-click "reveal these one at a time" that the list-style model exists to make
 * cheap. `from` is the step the first object gets.
 */
export function stagger(
  list: ObjectList,
  ids: readonly string[],
  from: number,
  effect: BuildEffect = "fade",
): ObjectList {
  const order = list.filter((o) => ids.includes(o.id)).map((o) => o.id);
  const stepOf = new Map(order.map((id, i) => [id, from + i]));
  return updateObjects(list, ids, (o) => ({
    ...o,
    build: { step: stepOf.get(o.id) ?? from, effect },
  }));
}
