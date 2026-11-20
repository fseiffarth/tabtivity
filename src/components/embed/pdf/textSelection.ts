/**
 * The selection behaviour pdf.js's own viewer puts around a text layer
 * (#pdf-textselect) — ported, because it does not live where the layer does.
 *
 * `pdfjs.TextLayer` only lays the spans out. Everything that makes a drag across them
 * feel like selecting text is in the viewer's `TextLayerBuilder`
 * (`web/pdf_viewer.mjs`), which this app does not use, and without it a drag in a PDF
 * is wretched: the spans are islands with bare layer between them, and the moment the
 * pointer crosses a gap — between two words, two lines, two columns — the engine has
 * no text under it and snaps the selection's end to wherever the DOM order says the
 * layer "is", which is usually the top or the bottom of the page. A LaTeX document is
 * the worst case, because TeX places every word (often every kerned glyph run) as its
 * own item, so there is a gap under the pointer almost everywhere.
 *
 * pdf.js's answer, reproduced here, has two parts:
 *
 * - **An `endOfContent` block after the spans**, which covers the whole layer while a
 *   selection is under way (`.selecting`, set on mousedown and while a selection
 *   intersects the layer). A drag over a gap then lands on it — after every span in
 *   DOM order — instead of on the bare layer, and on Firefox and Chromium ≥148 that
 *   alone is enough.
 * - **Everywhere else, WebKitGTK included, the block is moved** on every
 *   `selectionchange` to sit right after the span the selection's moving end is in,
 *   so a pointer over a gap extends the selection to *that* span rather than to the
 *   end of the page. This is the half that matters here: the desktop app runs on
 *   WebKit, which is exactly the engine pdf.js still needs it for.
 *
 * And Ctrl+C is given the text pdf.js's viewer would give it: null characters
 * dropped, and ligatures and compatibility forms (ﬁ, ﬀ, a no-break space) folded the
 * way pdf.js folds them (`normalizeCopiedText`).
 *
 * One registry for the whole document, not one per layer: `selectionchange` is a
 * document event and a selection can span pages, so one listener has to see every
 * layer at once. It is installed with the first layer and removed with the last.
 */

/** The block pdf.js's sheet (and `viewers.css`) styles. */
export const END_OF_CONTENT_CLASS = "endOfContent";
/** Set on a layer while a selection is being made in it. */
export const SELECTING_CLASS = "selecting";
/** The class every text layer carries — how a span finds the layer it is in. */
export const TEXT_LAYER_CLASS = "file-viewer-pdf-text-layer";

/** pdf.js's `normalizeUnicode` table, verbatim (pdf.mjs): the code points its viewer
 *  folds with NFKC on copy. Copied rather than imported so the module carries no
 *  pdf.js dependency — every viewer test mocks `pdfjs-dist` without it. */
const NORMALIZE_RE =
  /([\u00a0\u00b5\u037e\u0eb3\u2000-\u200a\u202f\u2126\ufb00-\ufb04\ufb06\ufb20-\ufb36\ufb38-\ufb3c\ufb3e\ufb40\ufb41\ufb43\ufb44\ufb46-\ufba1\ufba4-\ufba9\ufbae-\ufbb1\ufbd3-\ufbdc\ufbde-\ufbe7\ufbea-\ufbf8\ufbfc\ufbfd\ufc00-\ufc5d\ufc64-\ufcf1\ufcf5-\ufd3d\ufd88\ufdf4\ufdfa\ufdfb\ufe71\ufe77\ufe79\ufe7b\ufe7d]+)|(\ufb05+)/gu;

/** What a copy out of the page puts on the clipboard: the selected string with null
 *  characters removed and ligatures folded (`ﬁ` → `fi`, `ﬅ` → `ſt`), as pdf.js's
 *  viewer does. */
export function normalizeCopiedText(s: string): string {
  return s
    .split("\u0000")
    .join("")
    .replace(NORMALIZE_RE, (_m: string, p1: string | undefined, p2: string | undefined) =>
      p1 ? p1.normalize("NFKC") : "ſt".repeat((p2 ?? "").length),
    );
}

/** Every live layer and its `endOfContent` block. */
const layers = new Map<HTMLElement, HTMLElement>();
let listeners: AbortController | null = null;

/** Put a layer back to rest: its block home at the end, the selecting state off. */
function reset(end: HTMLElement, layer: HTMLElement) {
  layer.append(end);
  end.style.userSelect = "";
  layer.classList.remove(SELECTING_CLASS);
}

/** pdf.js's test for an engine that handles a drag over a gap by itself: Firefox, or
 *  Chromium 148 and later. Cached, as pdf.js caches it. */
let selfHandlingEngine: boolean | undefined;
function engineHandlesGaps(sample: HTMLElement): boolean {
  if (selfHandlingEngine !== undefined) return selfHandlingEngine;
  if (getComputedStyle(sample).getPropertyValue("-moz-user-select") === "none") {
    return (selfHandlingEngine = true);
  }
  const nav = navigator as Navigator & {
    userAgentData?: { brands?: { brand: string; version: string }[] };
  };
  const chromium =
    nav.userAgentData?.brands?.find((b) => b.brand === "Chromium")?.version ??
    /\bChrome\/(\d+)\b/.exec(navigator.userAgent)?.[1];
  return (selfHandlingEngine = !!chromium && parseInt(chromium, 10) >= 148);
}

/**
 * Over a gap, move the selection's moving end to the nearest span on the pointer's
 * own line — this one is ours, not pdf.js's.
 *
 * The `endOfContent` move keeps the end where it last was in a span, which stops the
 * jump but not a miss: dragging down-right into the margin past a line's end (the
 * usual way to take whole lines) reaches the margin without ever crossing that line's
 * words, so the selection stopped at the line above. Measured in an offscreen
 * WebKitGTK view over a pdflatex page: without this, a drag to 40px right of a short
 * line ended a line early; with it, it ends at that line's last word.
 *
 * Only when the pointer is over the bare layer or its block (anywhere else the engine
 * hit a span and knows better), and only to a span whose box spans the pointer's
 * height. Spans left of the pointer win, so a pointer in the gutter of a two-column
 * page ends the line it is level with rather than jumping into the next column.
 * Returns whether it moved the selection (a fresh `selectionchange` follows).
 */
function snapToPointerLine(selection: Selection, x: number, y: number): boolean {
  const hit = document.elementFromPoint?.(x, y);
  if (!(hit instanceof HTMLElement)) return false;
  const layer = hit.classList.contains(END_OF_CONTENT_CLASS)
    ? hit.closest<HTMLElement>(`.${TEXT_LAYER_CLASS}`)
    : hit;
  if (!layer || !layers.has(layer)) return false;
  // The spans level with the pointer. Their boxes are a whole ascent-plus-descent
  // tall, so two neighbouring lines overlap and both can contain `y`: the line is the
  // one whose middle is nearest, within a sliver (a line's runs differ slightly in
  // height — a bold word, a subscript).
  const level: { node: Text; r: DOMRect; dy: number }[] = [];
  for (const span of Array.from(layer.querySelectorAll("span:not(.markedContent)"))) {
    const text = span.firstChild;
    if (!(text instanceof Text) || !text.data.trim() || span.getAttribute("role") === "img") {
      continue;
    }
    const r = span.getBoundingClientRect();
    if (r.width <= 0 || y < r.top || y > r.bottom) continue;
    level.push({ node: text, r, dy: Math.abs((r.top + r.bottom) / 2 - y) });
  }
  if (level.length === 0) return false;
  const nearest = Math.min(...level.map((c) => c.dy));
  let left: { node: Text; right: number } | null = null;
  let right: { node: Text; left: number } | null = null;
  for (const { node, r, dy } of level) {
    if (dy > nearest + Math.max(1, 0.1 * r.height)) continue;
    if (x >= r.left && x <= r.right) return false;
    if (r.right < x && (!left || r.right > left.right)) left = { node, right: r.right };
    if (r.left > x && (!right || r.left < right.left)) right = { node, left: r.left };
  }
  const target = left
    ? { node: left.node, offset: left.node.length }
    : right
      ? { node: right.node, offset: 0 }
      : null;
  if (!target) return false;
  if (selection.focusNode === target.node && selection.focusOffset === target.offset) {
    return false;
  }
  selection.extend(target.node, target.offset);
  return true;
}

function installListeners() {
  if (listeners) return;
  listeners = new AbortController();
  const { signal } = listeners;
  let pointerDown = false;
  /** Where the pointer is while a button is down — for `snapToPointerLine`. */
  let pointer: { x: number; y: number } | null = null;
  const resetAll = () => layers.forEach(reset);

  /** Where the button went down, and whether the pointer has since moved far enough
   *  to be a drag — a click (or a click's jitter) in a gap must never select a line. */
  let downAt: { x: number; y: number } | null = null;
  let dragged = false;
  /** `snapToPointerLine` at the pointer, when a drag is selecting in a layer. */
  const snapAtPointer = () => {
    const selection = document.getSelection();
    const first = layers.keys().next().value;
    if (!pointer || !dragged || !selection || selection.rangeCount === 0 || !first) return;
    if (engineHandlesGaps(first)) return;
    const range = selection.getRangeAt(0);
    if (![...layers.keys()].some((l) => range.intersectsNode(l))) return;
    snapToPointerLine(selection, pointer.x, pointer.y);
  };
  // The snap also runs after every drag move, not only on `selectionchange`: once it
  // has moved the end, WebKit computes the same position over the gap move after move
  // and fires no further `selectionchange`, so the drag's last stretch was never
  // snapped (measured: a drag back up into the margin stopped three lines short). A
  // timeout, not a microtask, so it runs after the engine's own update for the move.
  let snapTimer: ReturnType<typeof setTimeout> | null = null;
  const cancelSnap = () => {
    if (snapTimer) clearTimeout(snapTimer);
    snapTimer = null;
  };
  signal.addEventListener("abort", cancelSnap);
  const endGesture = () => {
    cancelSnap();
    pointerDown = false;
    pointer = downAt = null;
    dragged = false;
    resetAll();
  };

  document.addEventListener(
    "pointerdown",
    (e: PointerEvent) => {
      pointerDown = true;
      downAt = { x: e.clientX, y: e.clientY };
      dragged = false;
    },
    { signal },
  );
  // And once more where the button comes up, before the reset: a release can beat
  // the last move's timeout, which left the snap undone on one run in two.
  document.addEventListener(
    "pointerup",
    (e: PointerEvent) => {
      if (pointerDown && dragged) {
        pointer = { x: e.clientX, y: e.clientY };
        cancelSnap();
        snapAtPointer();
      }
      endGesture();
    },
    { signal },
  );
  window.addEventListener("blur", endGesture, { signal });
  document.addEventListener(
    "pointermove",
    (e: PointerEvent) => {
      if (!pointerDown) return;
      pointer = { x: e.clientX, y: e.clientY };
      if (downAt && !dragged) {
        dragged = Math.hypot(pointer.x - downAt.x, pointer.y - downAt.y) > 4;
      }
      if (snapTimer || !dragged) return;
      snapTimer = setTimeout(() => {
        snapTimer = null;
        snapAtPointer();
      }, 0);
    },
    { signal, passive: true },
  );
  document.addEventListener("keyup", () => { if (!pointerDown) resetAll(); }, { signal });

  document.addEventListener(
    "selectionchange",
    () => {
      const selection = document.getSelection();
      if (!selection || selection.rangeCount === 0) {
        resetAll();
        return;
      }
      const active = new Set<HTMLElement>();
      for (let i = 0; i < selection.rangeCount; i++) {
        const range = selection.getRangeAt(i);
        for (const layer of layers.keys()) {
          if (!active.has(layer) && range.intersectsNode(layer)) active.add(layer);
        }
      }
      for (const [layer, end] of layers) {
        if (active.has(layer)) layer.classList.add(SELECTING_CLASS);
        else reset(end, layer);
      }
      const first = layers.keys().next().value;
      if (!first || engineHandlesGaps(first)) return;
      if (pointer && dragged && active.size > 0 && snapToPointerLine(selection, pointer.x, pointer.y)) {
        return;
      }

      // Move the block to just after the span the selection's moving end is in — or
      // just before it, when the drag runs backwards. pdf.js guesses which end moves
      // by comparing the range with the previous one; the snap above moves the end
      // between two of those comparisons, and a wrong guess put the block before the
      // selection's start, where the next hit collapsed the whole selection onto it
      // (measured: one whole-page drag in three came back empty). The selection
      // itself knows: its focus is the moving end, and it is ahead of or behind the
      // anchor.
      const focus = selection.focusNode;
      const from = selection.anchorNode;
      if (!focus || !from) return;
      const backwards =
        from === focus
          ? selection.focusOffset < selection.anchorOffset
          : !!(from.compareDocumentPosition(focus) & Node.DOCUMENT_POSITION_PRECEDING);
      let anchor: Node | null = focus.nodeType === Node.TEXT_NODE ? focus.parentNode : focus;
      if (anchor instanceof Element && anchor.classList.contains("highlight")) {
        anchor = anchor.parentNode;
      }
      if (!backwards && selection.focusOffset === 0 && anchor) {
        // The end sits at the very start of a node: the selection really ends in the
        // last node before it that has any content.
        let walk: Node | null = anchor;
        do {
          while (walk && !walk.previousSibling) walk = walk.parentNode;
          walk = walk?.previousSibling ?? null;
        } while (walk && !walk.childNodes.length);
        anchor = walk;
      }
      const parent = anchor?.parentElement ?? null;
      const layer = parent?.closest<HTMLElement>(`.${TEXT_LAYER_CLASS}`) ?? null;
      const end = layer ? layers.get(layer) : undefined;
      if (anchor && parent && end && anchor !== end && anchor !== layer) {
        end.style.userSelect = "text";
        parent.insertBefore(end, backwards ? anchor : anchor.nextSibling);
      }
    },
    { signal },
  );
}

/**
 * Give a rendered text layer pdf.js's selection behaviour. Call once the spans are in;
 * the returned function takes it all back (the block, the listeners, the registry
 * entry) and must run before the layer's children are cleared.
 */
export function attachTextSelection(layer: HTMLElement): () => void {
  const end = document.createElement("div");
  end.className = END_OF_CONTENT_CLASS;
  layer.append(end);

  const local = new AbortController();
  layer.addEventListener("mousedown", () => layer.classList.add(SELECTING_CLASS), {
    signal: local.signal,
  });
  layer.addEventListener(
    "copy",
    (e: ClipboardEvent) => {
      const text = document.getSelection()?.toString() ?? "";
      if (!e.clipboardData || !text) return;
      e.clipboardData.setData("text/plain", normalizeCopiedText(text));
      e.preventDefault();
    },
    { signal: local.signal },
  );

  layers.set(layer, end);
  installListeners();

  return () => {
    local.abort();
    layers.delete(layer);
    end.remove();
    layer.classList.remove(SELECTING_CLASS);
    if (layers.size === 0) {
      listeners?.abort();
      listeners = null;
    }
  };
}
