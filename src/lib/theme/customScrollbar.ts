/**
 * Square, themed scrollbars drawn by the app instead of by the engine.
 *
 * WHY THIS EXISTS. On WebKitGTK — the engine every Linux build runs on — a
 * scrollbar's shape is not reachable from CSS. Setting `scrollbar-width` and
 * `scrollbar-color` gets a native GTK bar: `thin` is parsed but ignored (auto
 * and thin both measure 21px), and the thumb is whatever GTK draws, a rounded
 * capsule. The `::-webkit-scrollbar` pseudo-elements can square it, but the
 * engine only consults them when `scrollbar-width` is `auto` — and with it auto
 * the bar falls back to the native light GTK look (white trough, grey slider)
 * on any surface the pseudo-rules do not fully restyle. Neither path yields a
 * square themed thumb, so the only way to get one is to hide the engine's bar
 * and paint our own. That is what this module does, on every platform, so one
 * look ships everywhere rather than Linux drifting.
 *
 * WHO HIDES THE NATIVE BAR: the stylesheet, not this module. WebKitGTK 2.52
 * builds a scrollable area's bar once and never rebuilds it when
 * `scrollbar-width` changes later — set statically the property works, set from
 * JS on a live element it does nothing while `getComputedStyle` still reports
 * `none`. A takeover that hid the bar as it adopted a container therefore left
 * a native bar standing beside every thumb it painted. `themes.css` hides them
 * all up front instead, so containers are born bar-less; `evictNativeBar` below
 * is only the fallback for one that slipped past that.
 *
 * SHAPE OF THE SOLUTION. One fixed-position layer per window holds every thumb;
 * the app's own DOM is never wrapped or restructured (a wrapper element around
 * arbitrary scroll containers is what breaks React reconciliation, and Tabtivity
 * has scroll containers in dozens of components). A container opts IN simply by
 * being scrollable — discovery is automatic — and opts OUT by already setting
 * `scrollbar-width: none`, which is how the app already says "this strip
 * scrolls but shows no bar" (the tab strip, the pill row, the mobile key row).
 * Those keep no bar, exactly as before.
 *
 * COST. Nothing polls. Two kinds of update exist and they are deliberately
 * asymmetric:
 *   - a SCROLL update reads three numbers off the element being scrolled and
 *     writes one transform. No `getBoundingClientRect`, because the container
 *     cannot move while it is merely scrolling — the cached rect stays valid.
 *     This is the path a terminal takes on every line of output, so it must not
 *     force a layout read of anything but the element itself.
 *   - a GEOMETRY update re-measures rects, re-tests visibility and prunes dead
 *     entries. It runs on resize, on DOM mutation and on an ancestor scrolling,
 *     never per frame of scrolling.
 * Both coalesce into a single rAF, and neither runs while the document is
 * hidden (a background window paints nothing worth measuring).
 */

/** Gutter width/height in px. Matches the `*::-webkit-scrollbar` size it replaces. */
const SIZE = 8;
/** A thumb never shrinks below this, however long the content is. */
const MIN_THUMB = 24;
/** Marks a container whose bar we have taken over; the CSS hides the native one. */
const TAKEOVER_ATTR = "data-app-scrollbar";
/**
 * Where a window parks its uninstall, so a dev hot-reload of this module tears
 * the previous layer down instead of stacking a second one on top of it. A
 * string key rather than a module-level flag on purpose: replacing the module
 * replaces the flag, which is exactly the case that would double up.
 */
const INSTALL_KEY = "__appCustomScrollbars";
/**
 * How long a container is followed frame by frame after a motion starts on an
 * ancestor, if no end event ever retires it. Well past the app's longest
 * transition (--transition-slow, 240ms); an element removed mid-motion fires
 * no end event at all, and this is what stops following it.
 */
const MOTION_FOLLOW_CAP_MS = 2000;

/**
 * Does a transition on this property move or resize the element's box (and so
 * every container inside it)? Colour, opacity and the like do not, and the app
 * runs those on hover all day long — following them would be per-frame work for
 * nothing. `all` may be anything, so it counts.
 */
export function movesBox(propertyName: string): boolean {
  return /^(all|transform|translate|scale|rotate|width|height|top|left|right|bottom|inset(-.*)?|margin(-.*)?|padding(-.*)?|flex(-.*)?|gap|grid-.*|font-size|line-height)$/.test(
    propertyName,
  );
}

export interface TrackMetrics {
  /** Full scrollable extent (`scrollHeight` / `scrollWidth`). */
  scrollSize: number;
  /** Visible extent (`clientHeight` / `clientWidth`). */
  clientSize: number;
  /** Current scroll offset (`scrollTop` / `scrollLeft`). */
  scrollPos: number;
  /** Length of the track the thumb slides along, in px. */
  trackLength: number;
}

export interface ThumbGeometry {
  /** Thumb length along the track, in px. */
  size: number;
  /** Thumb offset from the start of the track, in px. */
  offset: number;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * Thumb length and position for one axis, or null when the axis cannot scroll.
 *
 * The 1px slack on the overflow test is not superstition: a container whose
 * content is exactly its own height reports a `scrollHeight` one larger than
 * `clientHeight` on fractional device-pixel-ratio displays, and without the
 * slack every such element would sprout a full-length thumb that cannot move.
 */
export function thumbGeometry(m: TrackMetrics): ThumbGeometry | null {
  const overflow = m.scrollSize - m.clientSize;
  if (overflow <= 1 || m.trackLength <= 0) return null;
  const ratio = m.clientSize / m.scrollSize;
  const size = clamp(Math.round(m.trackLength * ratio), Math.min(MIN_THUMB, m.trackLength), m.trackLength);
  const maxOffset = m.trackLength - size;
  if (maxOffset <= 0) return { size, offset: 0 };
  const offset = Math.round((clamp(m.scrollPos, 0, overflow) / overflow) * maxOffset);
  return { size, offset: clamp(offset, 0, maxOffset) };
}

/**
 * Where a drag of `deltaPx` along the track should leave the scroll offset.
 *
 * The thumb moves across `trackLength - thumbSize` px while the content moves
 * across `scrollSize - clientSize` px, so the pointer delta scales by the ratio
 * between them — dragging a short thumb through a long document must cover more
 * content per pixel, which is exactly what makes a scrollbar feel right.
 */
export function scrollFromDrag(startScroll: number, deltaPx: number, m: TrackMetrics): number {
  const overflow = m.scrollSize - m.clientSize;
  const geom = thumbGeometry({ ...m, scrollPos: startScroll });
  if (!geom || overflow <= 0) return startScroll;
  const maxOffset = m.trackLength - geom.size;
  if (maxOffset <= 0) return startScroll;
  return clamp(startScroll + deltaPx * (overflow / maxOffset), 0, overflow);
}

/** A viewport-space rectangle: the shape both a container and a thumb have. */
export interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * The part of `box` that survives `clip`, or null when nothing does.
 *
 * The thumbs live in one fixed layer, so nothing in the DOM clips them: a
 * scroll container that is itself only half on screen — a bounded list inside
 * the Settings dialog's own scroll, say — would otherwise have its thumb
 * painted along its *whole* box, running out of the dialog and over the app
 * behind it. Every thumb is therefore intersected with what its ancestors
 * actually leave visible before it is painted.
 */
export function clipBox(box: Box, clip: Box): Box | null {
  const top = Math.max(box.top, clip.top);
  const left = Math.max(box.left, clip.left);
  const bottom = Math.min(box.top + box.height, clip.top + clip.height);
  const right = Math.min(box.left + box.width, clip.left + clip.width);
  if (bottom <= top || right <= left) return null;
  return { top, left, width: right - left, height: bottom - top };
}

/** A run along one axis, `[start, end)` in viewport px. */
export type Span = [number, number];

/** Spacing of the coarse probes along a gutter; each state change is then bisected to 1px. */
const PROBE_STEP = 16;

/**
 * The runs of `[start, end)` where `isOpen` holds, found by probing every
 * `step` px and bisecting each flip down to a pixel.
 *
 * This is what lets a thumb stop at the edge of a menu instead of painting over
 * it. The thumbs sit in one layer above every menu (a menu's own list needs its
 * thumb on top), so a container half-covered by an overlay — the main area
 * under a header dropdown — has to be told WHERE along its gutter it is still
 * the topmost thing. A single probe answered only yes or no for the whole
 * gutter, and a dropdown hanging over its top third read as "not covered".
 * An overlay thinner than `step` can slip between probes; nothing the app
 * layers over a gutter is.
 */
export function openSpans(
  start: number,
  end: number,
  isOpen: (pos: number) => boolean,
  step = PROBE_STEP,
): Span[] {
  if (end - start < 1) return [];
  const spans: Span[] = [];
  const last = end - 0.5;
  let pos = start + 0.5;
  let open = isOpen(pos);
  let runStart = open ? start : 0;
  while (pos < last) {
    const next = Math.min(pos + step, last);
    const nextOpen = isOpen(next);
    if (nextOpen !== open) {
      // Bisect (pos, next] for the first probe that reads like `next`.
      let lo = pos;
      let hi = next;
      while (hi - lo > 1) {
        const mid = (lo + hi) / 2;
        if (isOpen(mid) === nextOpen) hi = mid;
        else lo = mid;
      }
      const edge = Math.round(hi - 0.5);
      if (open) spans.push([runStart, edge]);
      else runStart = edge;
      open = nextOpen;
    }
    pos = next;
  }
  if (open) spans.push([runStart, end]);
  return spans;
}

/**
 * The piece of `[start, end)` that the longest overlap with `spans` leaves, or
 * null when it overlaps none. A thumb crossing a covered band in the middle
 * keeps its larger side rather than being split in two.
 */
export function largestOverlap(spans: Span[], start: number, end: number): Span | null {
  let best: Span | null = null;
  for (const [a, b] of spans) {
    const lo = Math.max(a, start);
    const hi = Math.min(b, end);
    if (hi > lo && (!best || hi - lo > best[1] - best[0])) best = [lo, hi];
  }
  return best;
}

/**
 * True when this element's own CSS asks for no scrollbar at all — no native bar
 * and no thumb of ours either. The tab strip, the project pill row and the
 * address display are the surfaces that mean it.
 *
 * The signal is `--tabtivity-scrollbar: none`, a property registered in themes.css
 * so it does not inherit. It used to be `scrollbar-width: none`, which read the
 * decision straight off the stylesheet where it was made — but that stopped
 * distinguishing anything once every element had to be born with the native bar
 * already hidden, which is to say once `* { scrollbar-width: none }` became the
 * baseline. A dedicated property keeps the decision in the stylesheet without
 * overloading a value the engine now needs for something else.
 */
function optedOut(style: CSSStyleDeclaration): boolean {
  return style.getPropertyValue("--app-scrollbar").trim() === "none";
}

/**
 * Evict a native scrollbar that reached first layout before the stylesheet's
 * hide could apply — a third-party sheet (xterm, pdf.js) or an inline style
 * naming its own `scrollbar-width` is how one gets through.
 *
 * WebKitGTK will not restyle a scrollbar that already exists, so the bar has to
 * be destroyed along with the scrollable area that owns it: toggling `overflow`
 * away and back does exactly that. Measured on 2.52.3 — the gutter drops from
 * 21px to 0, and `scrollTop` survives the round trip, so a terminal parked in
 * its scrollback does not jump to the top. It costs two forced layouts, hence
 * the early return: in the normal case, where the baseline did its job, this
 * only reads two numbers.
 */
function evictNativeBar(el: HTMLElement, style: CSSStyleDeclaration): void {
  // `offsetWidth - clientWidth` is the borders PLUS the scrollbar gutter, so the
  // borders have to come off before what is left can be called a bar.
  const border = (a: string, b: string) =>
    (parseFloat(style.getPropertyValue(a)) || 0) + (parseFloat(style.getPropertyValue(b)) || 0);
  const gutterX = el.offsetWidth - el.clientWidth - border("border-left-width", "border-right-width");
  const gutterY = el.offsetHeight - el.clientHeight - border("border-top-width", "border-bottom-width");
  if (gutterX < 1 && gutterY < 1) return;
  const inline = el.style.overflow;
  el.style.overflow = "hidden";
  void el.offsetHeight;
  // Back to whatever it was — an empty string hands control to the stylesheet.
  el.style.overflow = inline;
  void el.offsetHeight;
}

function scrollableAxis(overflow: string): boolean {
  return overflow === "auto" || overflow === "scroll" || overflow === "overlay";
}

interface Entry {
  el: HTMLElement;
  vertical: HTMLElement | null;
  horizontal: HTMLElement | null;
  /**
   * Which axes the container's overflow style lets scroll at all. A thumb is
   * made only once that axis actually overflows (see `applyScroll`), so a
   * container whose content grows after it registered still gets one.
   */
  axisV: boolean;
  axisH: boolean;
  /** Viewport rect of the container, refreshed only by a geometry pass. */
  top: number;
  left: number;
  width: number;
  height: number;
  /**
   * What the container's clipping ancestors (and the viewport) leave visible of
   * it, in viewport space. The thumb is painted inside this, never outside.
   */
  clip: Box;
  /** False while the container is off-screen or covered by something else. */
  visible: boolean;
  /**
   * Where along each gutter the container is still the topmost thing (see
   * `openSpans`). A thumb is painted only inside these, so an overlay covering
   * part of the gutter — a header dropdown over the main area — stays on top.
   */
  openV: Span[];
  openH: Span[];
  /**
   * True when another registered container lives inside this one, i.e. when
   * scrolling THIS element moves someone else's cached rect. Scrolling an
   * element never moves its own box, so without this flag every scroll would
   * have to re-measure the whole window — which is the one thing a terminal
   * printing a build log must not cost.
   */
  nested: boolean;
}

type InstallHost = Window & { [INSTALL_KEY]?: () => void };

export function installCustomScrollbars(): () => void {
  if (typeof document === "undefined") return () => {};
  const host = window as InstallHost;
  // Tear down whatever a previous evaluation of this module left running.
  host[INSTALL_KEY]?.();

  const layer = document.createElement("div");
  layer.className = "app-scrollbar-layer";
  layer.setAttribute("aria-hidden", "true");
  document.body.appendChild(layer);

  const entries = new Map<HTMLElement, Entry>();
  let geometryQueued = false;
  let scrollQueued = false;
  const dirtyScroll = new Set<HTMLElement>();
  /**
   * Parents whose children changed since the last geometry pass. Their
   * ancestors are checked there for a container that has only now started to
   * overflow (see `scanAncestors`).
   */
  const grownParents = new Set<Node>();
  let rafHandle = 0;
  /**
   * Elements whose box is in motion right now — a `transform`/inset/size
   * transition or an animation is running on them — each with the time after
   * which it is dropped whether or not its end event ever arrives (an element
   * unmounted mid-slide fires none). While the set is non-empty, every frame
   * re-measures the containers inside those elements so their thumbs ride the
   * motion instead of standing where one mid-flight measurement left them.
   */
  const movers = new Map<Element, { until: number; running: Set<string> }>();
  let followHandle = 0;

  // ── Registration ──────────────────────────────────────────────────────────

  /**
   * Observed per container as it registers, not re-attached in a sweep after
   * every mutation batch: a menu opening should cost one `observe` call, not a
   * disconnect-and-reobserve of every scroll container in the window.
   */
  const resizeObserver = new ResizeObserver(() => queueGeometry());

  function makeThumb(axis: "vertical" | "horizontal", el: HTMLElement): HTMLElement {
    const thumb = document.createElement("div");
    thumb.className = `app-scrollbar-thumb app-scrollbar-${axis}`;
    thumb.setAttribute("role", "presentation");
    bindDrag(thumb, el, axis);
    layer.appendChild(thumb);
    return thumb;
  }

  function register(el: HTMLElement): void {
    if (entries.has(el)) return;
    const style = getComputedStyle(el);
    if (optedOut(style)) return;
    const axisV = scrollableAxis(style.overflowY);
    const axisH = scrollableAxis(style.overflowX);
    const canV = axisV && el.scrollHeight - el.clientHeight > 1;
    const canH = axisH && el.scrollWidth - el.clientWidth > 1;
    if (!canV && !canH) return;
    el.setAttribute(TAKEOVER_ATTR, "");
    // The attribute's own rule carries `!important`, which is what keeps a
    // per-surface rule further down the stylesheet from resurrecting a bar under
    // the thumb. It cannot help an element that already HAS one, though — for
    // that, and only when there is one, the bar gets evicted the hard way.
    evictNativeBar(el, style);
    entries.set(el, {
      el,
      vertical: canV ? makeThumb("vertical", el) : null,
      horizontal: canH ? makeThumb("horizontal", el) : null,
      axisV,
      axisH,
      top: 0,
      left: 0,
      width: 0,
      height: 0,
      clip: { top: 0, left: 0, width: 0, height: 0 },
      visible: false,
      openV: [],
      openH: [],
      nested: false,
    });
    resizeObserver.observe(el);
  }

  function unregister(el: HTMLElement): void {
    const entry = entries.get(el);
    if (!entry) return;
    entry.vertical?.remove();
    entry.horizontal?.remove();
    resizeObserver.unobserve(el);
    el.removeAttribute(TAKEOVER_ATTR);
    entries.delete(el);
  }

  /**
   * Find scroll containers ABOVE the nodes whose children changed.
   *
   * `scan` looks only at what was added and below it, which misses the commonest
   * way a container starts to overflow: it mounts short — the Git view's
   * history still loading — and the rows then arrive inside it. Nothing new is
   * the container, nothing new contains it, and it is never scrolled until the
   * user does so, so the side panel's Git view showed no bar at all until the
   * wheel touched it. Run once per geometry pass, not per mutation record, and
   * a shared ancestor chain is walked once however many rows landed under it.
   */
  function scanAncestors(): void {
    const seen = new Set<Element>();
    for (const node of grownParents) {
      let el: Element | null = node instanceof Element ? node : node.parentElement;
      while (el && el !== document.documentElement && !seen.has(el)) {
        seen.add(el);
        if (el instanceof HTMLElement && el.isConnected && !entries.has(el)) {
          if (el.scrollHeight - el.clientHeight > 1 || el.scrollWidth - el.clientWidth > 1) {
            register(el);
          }
        }
        el = el.parentElement;
      }
    }
    grownParents.clear();
  }

  /**
   * Find scroll containers inside `root`.
   *
   * The cheap test comes first on purpose: `scrollHeight`/`clientHeight` are
   * plain property reads, while `getComputedStyle` allocates, so filtering on
   * the overflow numbers before asking for a style object keeps a full-document
   * scan proportional to the handful of elements that actually scroll rather
   * than to the whole tree.
   */
  function scan(root: ParentNode): void {
    const candidates = root.querySelectorAll<HTMLElement>("*");
    for (const el of candidates) {
      if (entries.has(el)) continue;
      if (el.scrollHeight - el.clientHeight > 1 || el.scrollWidth - el.clientWidth > 1) {
        register(el);
      }
    }
    if (root instanceof HTMLElement && !entries.has(root)) {
      if (root.scrollHeight - root.clientHeight > 1 || root.scrollWidth - root.clientWidth > 1) {
        register(root);
      }
    }
  }

  // ── Update passes ─────────────────────────────────────────────────────────

  function applyScroll(entry: Entry): void {
    const { el } = entry;
    // A container registers with a thumb per axis that overflowed AT THAT
    // MOMENT. The file tree's list is the case that broke: first painted with
    // a few top-level rows and long names, it overflowed sideways only, so it
    // got a horizontal thumb and no vertical one — and every later scan
    // skipped it as already registered, so expanding folders never earned it
    // a vertical bar. Which axis was over at registration is a matter of
    // timing, so the bar showed on some opens and stayed missing on others.
    if (!entry.vertical && entry.axisV && el.scrollHeight - el.clientHeight > 1) {
      entry.vertical = makeThumb("vertical", el);
    }
    if (!entry.horizontal && entry.axisH && el.scrollWidth - el.clientWidth > 1) {
      entry.horizontal = makeThumb("horizontal", el);
    }
    if (entry.vertical) {
      const geom = thumbGeometry({
        scrollSize: el.scrollHeight,
        clientSize: el.clientHeight,
        scrollPos: el.scrollTop,
        trackLength: entry.height,
      });
      paint(entry.vertical, geom, entry, "vertical");
    }
    if (entry.horizontal) {
      const geom = thumbGeometry({
        scrollSize: el.scrollWidth,
        clientSize: el.clientWidth,
        scrollPos: el.scrollLeft,
        trackLength: entry.width,
      });
      paint(entry.horizontal, geom, entry, "horizontal");
    }
  }

  function paint(
    thumb: HTMLElement,
    geom: ThumbGeometry | null,
    entry: Entry,
    axis: "vertical" | "horizontal",
  ): void {
    if (!geom || !entry.visible) {
      thumb.style.opacity = "0";
      thumb.style.pointerEvents = "none";
      return;
    }
    // Where the thumb would sit if nothing clipped it, then the part of that
    // its container is actually showing: a list bounded inside a taller scroll
    // (Settings' archived-projects and mobile-access lists are the ones the app
    // has) scrolls half out of the dialog, and only the half still inside the
    // frame may be painted. Both axes are sized explicitly because either can
    // be the clipped one.
    const full: Box =
      axis === "vertical"
        ? {
            top: entry.top + geom.offset,
            left: entry.left + entry.width - SIZE,
            width: SIZE,
            height: geom.size,
          }
        : {
            top: entry.top + entry.height - SIZE,
            left: entry.left + geom.offset,
            width: geom.size,
            height: SIZE,
          };
    const clipped = clipBox(full, entry.clip);
    const vertical = axis === "vertical";
    const run =
      clipped &&
      (vertical
        ? largestOverlap(entry.openV, clipped.top, clipped.top + clipped.height)
        : largestOverlap(entry.openH, clipped.left, clipped.left + clipped.width));
    const shown: Box | null =
      clipped && run
        ? vertical
          ? { ...clipped, top: run[0], height: run[1] - run[0] }
          : { ...clipped, left: run[0], width: run[1] - run[0] }
        : null;
    if (!shown) {
      thumb.style.opacity = "0";
      thumb.style.pointerEvents = "none";
      return;
    }
    thumb.style.opacity = "1";
    thumb.style.pointerEvents = "auto";
    thumb.style.width = `${shown.width}px`;
    thumb.style.height = `${shown.height}px`;
    thumb.style.transform = `translate(${shown.left}px, ${shown.top}px)`;
  }

  /**
   * The clip every descendant of `el` inherits from it: its ancestors' clip,
   * narrowed by its own box when its overflow is anything but `visible`.
   *
   * Memoized across one geometry pass because containers share ancestors — the
   * chain above a dialog is walked once, not once per scrolling list inside it.
   * A `position: fixed` element starts over from the viewport: scrolling
   * ancestors do not clip it, so a portaled menu must not inherit the clip of
   * whatever happens to be its DOM parent.
   */
  function clipOf(el: HTMLElement | null, cache: Map<Element, Box>): Box {
    const viewport: Box = { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight };
    if (!el || el === document.documentElement || el === document.body) return viewport;
    const cached = cache.get(el);
    if (cached) return cached;
    const style = getComputedStyle(el);
    let box = style.position === "fixed" ? viewport : clipOf(el.parentElement, cache);
    if (style.overflowX !== "visible" || style.overflowY !== "visible") {
      const rect = el.getBoundingClientRect();
      box =
        clipBox({ top: rect.top, left: rect.left, width: rect.width, height: rect.height }, box) ??
        { top: 0, left: 0, width: 0, height: 0 };
    }
    cache.set(el, box);
    return box;
  }

  /** The clip that applies to `el` itself — its ancestors', unless it is fixed. */
  function ancestorClip(el: HTMLElement, cache: Map<Element, Box>): Box {
    if (getComputedStyle(el).position === "fixed") {
      return { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight };
    }
    return clipOf(el.parentElement, cache);
  }

  /** Is `entry`'s container the topmost thing at (x, y)? */
  function ownsPoint(entry: Entry, x: number, y: number): boolean {
    const hit = document.elementFromPoint(x, y);
    return !!hit && (hit === entry.el || entry.el.contains(hit));
  }

  /**
   * Where along each gutter this container is the thing you would actually
   * touch — fills `openV`/`openH` and sets `visible`.
   *
   * A hit test rather than a list of "which selectors count as a modal": the
   * layer is one fixed element for the whole window, so without this the right
   * panel's thumb would paint straight over an open dialog that covers it, and
   * the main area's over a header dropdown that covers only the top of its
   * gutter. Asking the document what is topmost handles every overlay the app
   * has now and every one it grows later, with no list to keep in step. The
   * probe lines run just inside the gutter, so a thumb can never be the answer
   * to its own question.
   */
  function measureReach(entry: Entry): void {
    // Probed inside the CLIPPED box, not the container's own: a list scrolled
    // so that only its top strip is still inside the dialog would otherwise be
    // probed outside it, answer "covered" for a container the user can plainly
    // see, and hide a thumb that belongs on screen.
    const visible = clipBox(entry, entry.clip);
    entry.openV = [];
    entry.openH = [];
    if (!visible) {
      entry.visible = false;
      return;
    }
    const maxX = window.innerWidth - 1;
    const maxY = window.innerHeight - 1;
    if (entry.axisV) {
      const x = clamp(visible.left + visible.width - SIZE - 2, 0, maxX);
      entry.openV = openSpans(visible.top, visible.top + visible.height, (y) =>
        ownsPoint(entry, x, clamp(y, 0, maxY)),
      );
    }
    if (entry.axisH) {
      const y = clamp(visible.top + visible.height - SIZE - 2, 0, maxY);
      entry.openH = openSpans(visible.left, visible.left + visible.width, (x) =>
        ownsPoint(entry, clamp(x, 0, maxX), y),
      );
    }
    entry.visible = entry.openV.length > 0 || entry.openH.length > 0;
  }

  function runGeometry(): void {
    for (const [el] of entries) {
      if (!el.isConnected) unregister(el);
    }
    const live = [...entries.values()];
    // One cache for the whole pass: the ancestor chains overlap heavily, and a
    // clip is only as fresh as the layout this pass already forced anyway.
    const clipCache = new Map<Element, Box>();
    for (const entry of live) {
      const rect = entry.el.getBoundingClientRect();
      entry.top = rect.top;
      entry.left = rect.left;
      entry.width = rect.width;
      entry.height = rect.height;
      entry.clip = ancestorClip(entry.el, clipCache);
      measureReach(entry);
      applyScroll(entry);
    }
    // Recomputed here rather than on every scroll: containment only changes
    // when the tree does, and the tree changing is what got us here.
    for (const entry of live) {
      entry.nested = live.some((other) => other !== entry && entry.el.contains(other.el));
    }
  }

  /**
   * Re-measure only the containers inside `roots` — the per-frame pass while
   * something is in motion. The full pass's clip cache is per call, so the
   * chains above these containers are walked once per frame, not once per thumb.
   */
  function measureWithin(roots: Iterable<Element>): void {
    const clipCache = new Map<Element, Box>();
    for (const entry of entries.values()) {
      let inside = false;
      for (const root of roots) {
        if (root === entry.el || root.contains(entry.el)) {
          inside = true;
          break;
        }
      }
      if (!inside) continue;
      const rect = entry.el.getBoundingClientRect();
      entry.top = rect.top;
      entry.left = rect.left;
      entry.width = rect.width;
      entry.height = rect.height;
      entry.clip = ancestorClip(entry.el, clipCache);
      measureReach(entry);
      applyScroll(entry);
    }
  }

  /** One frame of following whatever is in motion; re-arms itself while anything is. */
  function followMotion(): void {
    followHandle = 0;
    const now = performance.now();
    for (const [el, mover] of movers) {
      if (!el.isConnected || now > mover.until) movers.delete(el);
    }
    if (movers.size === 0 || document.hidden) {
      movers.clear();
      return;
    }
    // A queued full pass this frame measures everything anyway.
    if (!geometryQueued) measureWithin(movers.keys());
    followHandle = requestAnimationFrame(followMotion);
  }

  function flush(): void {
    rafHandle = 0;
    if (document.hidden) {
      geometryQueued = false;
      scrollQueued = false;
      dirtyScroll.clear();
      // `visibilitychange` rescans the whole document on the way back.
      grownParents.clear();
      return;
    }
    if (geometryQueued) {
      geometryQueued = false;
      scrollQueued = false;
      dirtyScroll.clear();
      scanAncestors();
      runGeometry();
      return;
    }
    if (scrollQueued) {
      scrollQueued = false;
      for (const el of dirtyScroll) {
        const entry = entries.get(el);
        if (entry) applyScroll(entry);
      }
      dirtyScroll.clear();
    }
  }

  function schedule(): void {
    if (rafHandle) return;
    rafHandle = requestAnimationFrame(flush);
  }

  function queueGeometry(): void {
    geometryQueued = true;
    schedule();
  }

  function queueScroll(el: HTMLElement): void {
    scrollQueued = true;
    dirtyScroll.add(el);
    schedule();
  }

  // ── Dragging ──────────────────────────────────────────────────────────────

  function bindDrag(thumb: HTMLElement, el: HTMLElement, axis: "vertical" | "horizontal"): void {
    thumb.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const entry = entries.get(el);
      if (!entry) return;
      const vertical = axis === "vertical";
      const startPointer = vertical ? e.clientY : e.clientX;
      const startScroll = vertical ? el.scrollTop : el.scrollLeft;
      const metrics: TrackMetrics = {
        scrollSize: vertical ? el.scrollHeight : el.scrollWidth,
        clientSize: vertical ? el.clientHeight : el.clientWidth,
        scrollPos: startScroll,
        trackLength: vertical ? entry.height : entry.width,
      };
      thumb.setPointerCapture(e.pointerId);
      thumb.classList.add("dragging");
      document.body.classList.add("app-scrollbar-dragging");

      const onMove = (move: PointerEvent) => {
        const delta = (vertical ? move.clientY : move.clientX) - startPointer;
        const next = scrollFromDrag(startScroll, delta, metrics);
        if (vertical) el.scrollTop = next;
        else el.scrollLeft = next;
      };
      const onUp = () => {
        thumb.classList.remove("dragging");
        document.body.classList.remove("app-scrollbar-dragging");
        thumb.removeEventListener("pointermove", onMove);
        thumb.removeEventListener("pointerup", onUp);
        thumb.removeEventListener("pointercancel", onUp);
      };
      thumb.addEventListener("pointermove", onMove);
      thumb.addEventListener("pointerup", onUp);
      thumb.addEventListener("pointercancel", onUp);
    });

    // A wheel over the thumb should scroll what it belongs to, not fall through
    // to whatever sits under the fixed layer.
    thumb.addEventListener(
      "wheel",
      (e: WheelEvent) => {
        e.preventDefault();
        if (axis === "vertical") el.scrollTop += e.deltaY;
        else el.scrollLeft += e.deltaX || e.deltaY;
      },
      { passive: false },
    );
  }

  // ── Wiring ────────────────────────────────────────────────────────────────

  /**
   * Capture phase, because `scroll` does not bubble: this is the one listener
   * that sees every scroll in the window. It doubles as the safety net for
   * discovery — anything the mutation scan missed registers the instant it is
   * first scrolled, so a container can be wrong for one frame but never longer.
   */
  const onScroll = (e: Event) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) {
      queueGeometry();
      return;
    }
    if (!entries.has(target)) {
      register(target);
      queueGeometry();
      return;
    }
    queueScroll(target);
    // An ancestor scrolling moves its descendants' containers without any of
    // them firing a scroll of their own, so their cached rects are now stale.
    // Only an ancestor: an element's own scroll never moves its own box, which
    // is what keeps the common case one transform write.
    if (entries.get(target)?.nested) queueGeometry();
  };

  const mutationObserver = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof HTMLElement) scan(node);
      }
      if (record.addedNodes.length > 0) grownParents.add(record.target);
    }
    queueGeometry();
  });

  // A container can move without the tree changing: the side panel slides in
  // on a `transform` transition, and a view mounted while it is still on its
  // way (the settings write that picks the view resolves mid-slide) got its
  // thumb measured at wherever the panel was that frame — a bar standing in
  // the middle of the panel. Transitions and animations are the one geometry
  // change no observer above reports. Their end is a full geometry pass, and
  // that alone still showed as a two-step open: the thumb painted wherever the
  // slide had reached when the tree mounted, hung there for the rest of the
  // slide, then snapped into place. So for as long as a box-moving transition
  // or an animation runs, the containers inside it are re-measured every frame
  // and the thumb rides the panel in. Per frame, but only for those containers
  // and only for the slide's 240ms — a terminal scrolling is not in here.
  // Capture: the events do not bubble past a shadow root, and a thumb's own
  // transitions (none today) would only cost one coalesced rAF.
  // What one motion event is about: which element, and which of its
  // transitions/animations. Duck-typed — jsdom has no `TransitionEvent` — and
  // an animation is named rather than asked what it animates, so it is followed
  // whatever it moves. A pseudo-element's motion (the panel's drop glow, a
  // banner) has no container inside it to follow; a non-box property (colour,
  // opacity — the hover transitions the app runs all day) moves none either.
  const motionOf = (e: Event): { target: Element; key: string } | null => {
    const target = e.target;
    if (!(target instanceof Element) || target === document.documentElement) return null;
    const { propertyName, animationName, pseudoElement } = e as Partial<
      TransitionEvent & AnimationEvent
    >;
    if (pseudoElement) return null;
    if (typeof propertyName === "string") {
      return movesBox(propertyName) ? { target, key: propertyName } : null;
    }
    return { target, key: `animation:${animationName ?? ""}` };
  };
  const onMotionEnd = (e: Event) => {
    const motion = motionOf(e);
    if (motion) {
      const mover = movers.get(motion.target);
      // Retired only once the last of its box-moving motions has ended: a
      // colour transition finishing early must not drop the slide it rides with.
      if (mover && (mover.running.delete(motion.key), mover.running.size === 0)) {
        movers.delete(motion.target);
      }
      // Discovery, not only measurement. A container is found when nodes are
      // ADDED under it or when it is first scrolled; a box that grew scrollable
      // through a class flip, a width change or a resize added no node and
      // fired no scroll, so it went unnoticed — the side panel opened with a
      // list that plainly overflowed and no bar on it until the wheel touched
      // it. The element that just moved is the natural place to look, and once
      // per slide is cheap.
      if (motion.target instanceof HTMLElement && motion.target.isConnected) {
        scan(motion.target);
      }
    }
    queueGeometry();
  };
  // The same gap on the two whole-window geometry changes that add no nodes.
  const rescanAll = () => {
    if (!document.hidden) scan(document.body);
    queueGeometry();
  };
  const onMotionStart = (e: Event) => {
    const motion = motionOf(e);
    if (!motion) return;
    const mover = movers.get(motion.target);
    // The cap outlasts any motion the app runs; the end event retires it far
    // sooner. It is what stops following an element unmounted mid-motion, which
    // fires no end event at all.
    const until = performance.now() + MOTION_FOLLOW_CAP_MS;
    if (mover) {
      mover.running.add(motion.key);
      mover.until = until;
    } else {
      movers.set(motion.target, { until, running: new Set([motion.key]) });
    }
    if (!followHandle) followHandle = requestAnimationFrame(followMotion);
  };
  document.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", rescanAll);
  document.addEventListener("visibilitychange", rescanAll);
  document.addEventListener("transitionrun", onMotionStart, true);
  document.addEventListener("animationstart", onMotionStart, true);
  document.addEventListener("transitionend", onMotionEnd, true);
  document.addEventListener("transitioncancel", onMotionEnd, true);
  document.addEventListener("animationend", onMotionEnd, true);
  document.addEventListener("animationcancel", onMotionEnd, true);
  mutationObserver.observe(document.body, { childList: true, subtree: true });

  scan(document.body);
  queueGeometry();

  const uninstall = () => {
    document.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", rescanAll);
    document.removeEventListener("visibilitychange", rescanAll);
    document.removeEventListener("transitionrun", onMotionStart, true);
    document.removeEventListener("animationstart", onMotionStart, true);
    document.removeEventListener("transitionend", onMotionEnd, true);
    document.removeEventListener("transitioncancel", onMotionEnd, true);
    document.removeEventListener("animationend", onMotionEnd, true);
    document.removeEventListener("animationcancel", onMotionEnd, true);
    mutationObserver.disconnect();
    resizeObserver.disconnect();
    if (rafHandle) cancelAnimationFrame(rafHandle);
    if (followHandle) cancelAnimationFrame(followHandle);
    movers.clear();
    for (const el of [...entries.keys()]) unregister(el);
    layer.remove();
    if (host[INSTALL_KEY] === uninstall) delete host[INSTALL_KEY];
  };
  host[INSTALL_KEY] = uninstall;
  return uninstall;
}
