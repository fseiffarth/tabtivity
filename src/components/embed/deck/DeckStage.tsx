/**
 * The deck editing surface: the base page, the object layer over it, selection
 * handles, and every pointer gesture that moves or resizes something.
 *
 * Three decisions are worth knowing before changing anything here.
 *
 * **Every gesture is pointer-based, with pointer capture, and every handler is
 * bound in the JSX.** HTML5 drag-and-drop does not work under WebKitGTK (see
 * `stores/drag/pdfDrag.ts` and `YamlTree`, which both learned this), and listeners
 * *added mid-gesture* can be skipped entirely — so the move/up handlers are on
 * the stage from the first render and `setPointerCapture` keeps them fed even
 * when the pointer leaves the element.
 *
 * **A gesture edits local state and commits once, on pointerup.** The deck
 * autosaves (there is no save button and no close prompt anywhere in Tabtivity), and
 * `useEditableFile` writes on *every* change — so committing per `pointermove`
 * would issue a disk write per frame of a drag. `pending` holds the live object
 * list; `onObjectsChange` fires exactly once when the pointer goes up.
 *
 * **Guides are painted from what the snapper returned**, never recomputed here.
 * If a snap fires for the wrong reason it is then visible immediately, which is
 * the only practical defence against a sign error in `deck/snap.ts`.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  type Box,
  type DeckObject,
  type ObjectList,
  type Slide,
  boundingBox,
  moveObjects,
  updateObjects,
  visibleAt,
} from "../../../lib/viewers/deck/model";
import {
  type Guide,
  type ResizeHandle,
  axisLock,
  snapMove,
  snapResize,
  thresholdFor,
} from "../../../lib/viewers/deck/snap";
import { type TextMetrics, cssFontFor } from "../../../lib/viewers/deck/fonts";
import { DeckObjectView, FONT_STACKS } from "./DeckObjectView";
import { renderPage } from "./deckBase";
import { EFFECT_KEYS } from "./DeckAnimate";
import { useT } from "../../../lib/i18n";

/** Snap radius in CSS pixels. Generous enough to catch, tight enough that a
 *  deliberate 3px offset is still reachable (Alt suspends it entirely). */
const SNAP_PX = 7;

/** Below this drag distance a gesture is a click, not a move — otherwise
 *  selecting an object nudges it by a pixel. */
const DRAG_SLOP_PX = 3;

const HANDLES: ResizeHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

export interface DeckStageProps {
  slide: Slide;
  /** The base document, or null when the deck has no plate yet. */
  doc: PDFDocumentProxy | null;
  /** Page box in points — sets the stage's aspect ratio. */
  pageWidth: number;
  pageHeight: number;
  /** Safe-area inset, a snapping target and a painted frame. */
  margin: number;
  selection: ReadonlySet<string>;
  onSelectionChange: (ids: Set<string>) => void;
  onObjectsChange: (objects: ObjectList) => void;
  /** Build step being previewed; objects above it are dimmed, not hidden, so
   *  they stay selectable while you are arranging them. */
  previewStep?: number;
  /** `src` → object URL for image objects. */
  assets?: ReadonlyMap<string, string>;
  /** PDF text metrics; null until loaded. See `deck/fonts.ts`. */
  metrics: TextMetrics | null;
  /** Show each object's build step as a numbered badge — animate mode only.
   *  Animation whose structure you cannot see cannot be reasoned about. */
  showBuildBadges?: boolean;
  /** Double-click on an object — the "enter/edit" gesture, distinct from the
   *  single click that selects it. Used for a TeX-figure image's source. */
  onEditObject?: (obj: DeckObject) => void;
  /**
   * A text object's text was edited **on the slide**. Absent = no in-place
   * editing (the audience/presenter renderers pass nothing).
   *
   * Fires per keystroke, so the caller is expected to coalesce it into one undo
   * entry — `DeckView` keys on the object id for exactly that.
   */
  onTextChange?: (id: string, text: string) => void;
  /** The deck-wide footer, drawn under the objects so it reads as part of the
   *  plate rather than as something on the slide. Not selectable. */
  footer?: DeckObject | null;
}

type Gesture =
  | { mode: "move"; startX: number; startY: number; base: ObjectList; moved: boolean }
  | {
      mode: "resize";
      handle: ResizeHandle;
      startX: number;
      startY: number;
      base: ObjectList;
      id: string;
      moved: boolean;
    }
  | { mode: "rotate"; cx: number; cy: number; base: ObjectList; id: string; moved: boolean }
  | { mode: "marquee"; startX: number; startY: number; additive: boolean };

export function DeckStage({
  slide,
  doc,
  pageWidth,
  pageHeight,
  margin,
  selection,
  onSelectionChange,
  onObjectsChange,
  previewStep,
  assets,
  metrics,
  showBuildBadges,
  onEditObject,
  onTextChange,
  footer = null,
}: DeckStageProps) {
  const t = useT();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  /** Rendered page size in CSS px, measured — the stage fits the pane. */
  const [size, setSize] = useState({ w: 0, h: 0 });
  /**
   * Live objects during a gesture; null when idle (the slide's own list wins).
   *
   * Mirrored into a ref because the commit happens on pointerup, and a pointerup
   * arriving in the same frame as the last pointermove would otherwise read a
   * `pending` React has not re-rendered yet — silently dropping the final frame
   * of every fast drag, which reads as "it doesn't quite go where I put it".
   */
  const [pending, setPendingState] = useState<ObjectList | null>(null);
  const pendingRef = useRef<ObjectList | null>(null);
  const setPending = useCallback((list: ObjectList | null) => {
    pendingRef.current = list;
    setPendingState(list);
  }, []);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [marquee, setMarquee] = useState<Box | null>(null);
  const gestureRef = useRef<Gesture | null>(null);

  const objects = pending ?? slide.objects;
  /** Page aspect, for rotating geometry in an isotropic frame — see
   *  `model.rotatedCorners`. */
  const aspect = pageHeight > 0 ? pageWidth / pageHeight : 1;

  // --- layout ------------------------------------------------------------
  // Fit the page into the host, preserving aspect. Re-measured on resize so the
  // normalized geometry keeps its promise of surviving a pane resize.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const fit = () => {
      const availW = host.clientWidth - 32;
      const availH = host.clientHeight - 32;
      if (availW <= 0 || availH <= 0) return;
      const aspect = pageWidth / pageHeight;
      let w = availW;
      let h = w / aspect;
      if (h > availH) {
        h = availH;
        w = h * aspect;
      }
      setSize((prev) =>
        Math.abs(prev.w - w) < 0.5 && Math.abs(prev.h - h) < 0.5 ? prev : { w, h },
      );
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(host);
    return () => ro.disconnect();
  }, [pageWidth, pageHeight]);

  // --- base page ---------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !doc || size.w <= 0) return;
    return renderPage(doc, slide.anchor.page, canvas, size.w, size.h);
  }, [doc, slide.anchor.page, size.w, size.h]);

  // --- geometry helpers --------------------------------------------------

  /** Pointer → normalized page coordinates. */
  const toPage = useCallback(
    (clientX: number, clientY: number) => {
      const rect = pageRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
      return {
        x: (clientX - rect.left) / rect.width,
        y: (clientY - rect.top) / rect.height,
      };
    },
    [],
  );

  const threshold = thresholdFor(SNAP_PX, size.w, size.h);

  /** Boxes to snap against: everything not being dragged. */
  const othersFor = useCallback(
    (list: ObjectList, moving: ReadonlySet<string>): Box[] =>
      list.filter((o) => !moving.has(o.id) && !o.hidden).map((o) => ({ x: o.x, y: o.y, w: o.w, h: o.h })),
    [],
  );

  // --- gestures ----------------------------------------------------------

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      const handleEl = target.closest<HTMLElement>("[data-handle]");
      const rotateEl = target.closest<HTMLElement>("[data-rotate]");
      const objEl = target.closest<HTMLElement>("[data-object-id]");
      const p = toPage(e.clientX, e.clientY);

      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

      if (rotateEl) {
        const sel = objects.filter((o) => selection.has(o.id));
        if (sel.length !== 1) return;
        const b = boundingBox(sel, aspect);
        gestureRef.current = {
          mode: "rotate",
          cx: b.x + b.w / 2,
          cy: b.y + b.h / 2,
          base: objects,
          id: sel[0].id,
          moved: false,
        };
        return;
      }

      if (handleEl) {
        const handle = handleEl.dataset.handle as ResizeHandle;
        const sel = objects.filter((o) => selection.has(o.id) && !o.locked);
        if (sel.length !== 1) return;
        gestureRef.current = {
          mode: "resize",
          handle,
          startX: p.x,
          startY: p.y,
          base: objects,
          id: sel[0].id,
          moved: false,
        };
        return;
      }

      if (objEl) {
        const id = objEl.dataset.objectId!;
        if (e.shiftKey) {
          const next = new Set(selection);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          onSelectionChange(next);
        } else if (!selection.has(id)) {
          onSelectionChange(new Set([id]));
        }
        gestureRef.current = {
          mode: "move",
          startX: p.x,
          startY: p.y,
          base: objects,
          moved: false,
        };
        return;
      }

      // Empty space: marquee-select. Shift adds to the existing selection.
      if (!e.shiftKey) onSelectionChange(new Set());
      gestureRef.current = {
        mode: "marquee",
        startX: p.x,
        startY: p.y,
        additive: e.shiftKey,
      };
      setMarquee({ x: p.x, y: p.y, w: 0, h: 0 });
    },
    [objects, selection, onSelectionChange, toPage],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const g = gestureRef.current;
      if (!g) return;
      const p = toPage(e.clientX, e.clientY);
      const slopX = DRAG_SLOP_PX / Math.max(size.w, 1);
      const slopY = DRAG_SLOP_PX / Math.max(size.h, 1);

      if (g.mode === "marquee") {
        const box: Box = {
          x: Math.min(g.startX, p.x),
          y: Math.min(g.startY, p.y),
          w: Math.abs(p.x - g.startX),
          h: Math.abs(p.y - g.startY),
        };
        setMarquee(box);
        // Hit-test the object's ROTATED extent, not its stored box — a turned
        // object was previously caught (or missed) by a rectangle it does not
        // occupy.
        const hits = objects
          .filter((o) => {
            const b = boundingBox([o], aspect);
            return (
              b.x < box.x + box.w && b.x + b.w > box.x && b.y < box.y + box.h && b.y + b.h > box.y
            );
          })
          .map((o) => o.id);
        onSelectionChange(new Set(g.additive ? [...selection, ...hits] : hits));
        return;
      }

      if (g.mode === "move") {
        let dx = p.x - g.startX;
        let dy = p.y - g.startY;
        if (!g.moved && Math.abs(dx) < slopX && Math.abs(dy) < slopY) return;
        g.moved = true;
        if (e.shiftKey) ({ dx, dy } = axisLock(dx, dy));

        const moved = moveObjects(g.base, [...selection], dx, dy);
        const sel = moved.filter((o) => selection.has(o.id));
        if (sel.length === 0) return;
        // Snap the selection's bounding box, then apply that one correction to
        // every member — snapping each object independently would tear a
        // multi-selection apart.
        const bb = boundingBox(sel);
        const r = snapMove(bb, {
          others: othersFor(g.base, selection),
          margin,
          threshold,
          enabled: !e.altKey,
        });
        const cx = r.x - bb.x;
        const cy = r.y - bb.y;
        setPending(cx || cy ? moveObjects(moved, [...selection], cx, cy) : moved);
        setGuides(r.guides);
        return;
      }

      if (g.mode === "resize") {
        let dx = p.x - g.startX;
        let dy = p.y - g.startY;
        if (!g.moved && Math.abs(dx) < slopX && Math.abs(dy) < slopY) return;
        g.moved = true;
        const src = g.base.find((o) => o.id === g.id);
        if (!src) return;
        // Rotate the pointer delta INTO the object's own frame before applying
        // it. `applyHandle` works on an axis-aligned box, so feeding it a delta
        // measured in page space made dragging a handle on a rotated object move
        // the wrong edges — the handle you grabbed and the edge that moved were
        // simply different things (TODO V #111). The aspect correction matches
        // `rotatedCorners`: the page is not square, so the turn has to happen in
        // an isotropic frame or a 45° object shears.
        if (src.rot) {
          const rad = (-src.rot * Math.PI) / 180;
          const cos = Math.cos(rad);
          const sin = Math.sin(rad);
          const ax = pageWidth / pageHeight;
          const px = dx * ax;
          [dx, dy] = [(px * cos - dy * sin) / ax, px * sin + dy * cos];
        }
        const raw = applyHandle({ x: src.x, y: src.y, w: src.w, h: src.h }, g.handle, dx, dy);
        // A rotated object's snap targets are meaningless: it snaps its
        // *unrotated* box to guides that describe rotated neighbours. Better to
        // resize freely than to jump to a line that is not where it looks.
        const r = src.rot
          ? { box: raw, guides: [] as Guide[] }
          : snapResize(raw, g.handle, {
              others: othersFor(g.base, new Set([g.id])),
              margin,
              threshold,
              enabled: !e.altKey,
            });
        setPending(
          updateObjects(g.base, [g.id], (o) => ({ ...o, ...r.box })),
        );
        setGuides(r.guides);
        return;
      }

      if (g.mode === "rotate") {
        const rect = pageRef.current?.getBoundingClientRect();
        if (!rect) return;
        const cx = rect.left + g.cx * rect.width;
        const cy = rect.top + g.cy * rect.height;
        let deg = (Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI + 90;
        // Shift snaps rotation to 15° steps — the equivalent of axis lock.
        if (e.shiftKey) deg = Math.round(deg / 15) * 15;
        g.moved = true;
        setPending(updateObjects(g.base, [g.id], (o) => ({ ...o, rot: Math.round(deg) })));
        return;
      }
    },
    [objects, selection, onSelectionChange, toPage, othersFor, margin, threshold, size],
  );

  const endGesture = useCallback(() => {
    const g = gestureRef.current;
    gestureRef.current = null;
    setGuides([]);
    setMarquee(null);
    // The one commit. See the module note on why it is not per-move.
    const final = pendingRef.current;
    if (g && g.mode !== "marquee" && g.moved && final) onObjectsChange(final);
    setPending(null);
  }, [onObjectsChange, setPending]);

  // A capture-losing event (another window stealing focus, a touch cancel) has
  // to end the gesture too, or `pending` outlives it and the stage freezes on a
  // half-finished drag.
  const onPointerUp = useCallback(() => endGesture(), [endGesture]);

  // --- in-place text editing ------------------------------------------------
  //
  // Until now every character of every slide was typed into a 3-row textarea in
  // the side panel while the object rendered somewhere else — for a
  // direct-manipulation design tool, the largest usability gap it had (TODO V
  // #118). Double-click mounts a real `<textarea>` on the object's own box,
  // sharing `TextBody`'s computed style, so what you type is where it lands.
  const [editingId, setEditingId] = useState<string | null>(null);
  const editRef = useRef<HTMLTextAreaElement | null>(null);
  const editing = editingId ? objects.find((o) => o.id === editingId) : undefined;

  useEffect(() => {
    if (!editingId) return;
    const el = editRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [editingId]);

  // A slide change (or the object going away) must not leave an editor floating
  // over the wrong content.
  useEffect(() => {
    setEditingId(null);
  }, [slide.id]);

  // Double-click is a separate native event from the pointer gestures above, so
  // it needs no coordination with the drag/resize/rotate state machine — a
  // double-click that lands mid-drag never happens because a drag's second
  // pointerdown is on a different frame than its first.
  const onDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const objEl = (e.target as HTMLElement).closest<HTMLElement>("[data-object-id]");
      if (!objEl) return;
      const obj = objects.find((o) => o.id === objEl.dataset.objectId);
      if (!obj) return;
      if (obj.kind === "text" && onTextChange && !obj.locked) {
        setEditingId(obj.id);
        return;
      }
      onEditObject?.(obj);
    },
    [objects, onEditObject, onTextChange],
  );

  // --- render ------------------------------------------------------------

  const pointScale = size.w > 0 && pageWidth > 0 ? size.w / pageWidth : 1;
  const selected = objects.filter((o) => selection.has(o.id));
  // The selection rectangle is drawn over the ROTATED extent, so it actually
  // encloses what is on screen (TODO V #111).
  const selBox = selected.length > 0 ? boundingBox(selected, aspect) : null;
  const singleSelection = selected.length === 1 && !selected[0].locked;

  return (
    <div className="deck-stage" ref={hostRef}>
      <div
        className="deck-stage-page"
        ref={pageRef}
        style={{ width: size.w, height: size.h }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onLostPointerCapture={onPointerUp}
        onDoubleClick={onDoubleClick}
      >
        <canvas className="deck-stage-canvas" ref={canvasRef} />

        {margin > 0 && (
          <div
            className="deck-stage-margin"
            style={{ inset: `${margin * 100}% ${margin * 100}%` }}
            aria-hidden
          />
        )}

        {footer && (
          <DeckObjectView
            obj={footer}
            pageW={size.w}
            pageH={size.h}
            pointScale={pointScale}
            metrics={metrics}
            selected={false}
          />
        )}

        {objects.map((o) => (
          <DeckObjectView
            key={o.id}
            obj={dimmed(o, previewStep)}
            pageW={size.w}
            pageH={size.h}
            pointScale={pointScale}
            assetUrl={o.kind === "image" ? assets?.get(o.src) : undefined}
            metrics={metrics}
            selected={selection.has(o.id)}
          />
        ))}

        {/* The in-place editor. Positioned and styled from the object itself, so
            the caret sits on the same glyphs the render does. `pointerDown` is
            stopped: the stage's own handler would read this as a drag on the
            object underneath and start moving it mid-sentence. */}
        {editing && editing.kind === "text" && (
          <textarea
            ref={editRef}
            className="deck-text-edit"
            value={editing.text}
            style={{
              left: editing.x * size.w,
              top: editing.y * size.h,
              width: editing.w * size.w,
              height: editing.h * size.h,
              transform: editing.rot ? `rotate(${editing.rot}deg)` : undefined,
              transformOrigin: "50% 50%",
              padding: editing.padding * pointScale,
              fontFamily: cssFontFor(editing.style.family, FONT_STACKS),
              fontSize: editing.style.size * pointScale,
              fontWeight: editing.style.bold ? 700 : 400,
              fontStyle: editing.style.italic ? "italic" : "normal",
              lineHeight: editing.style.lineHeight,
              color: editing.style.color,
              textAlign: editing.style.align,
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => onTextChange?.(editing.id, e.target.value)}
            onBlur={() => setEditingId(null)}
            onKeyDown={(e) => {
              // Escape leaves the editor without leaving the selection — the
              // stage's own Escape (clear selection) would otherwise fire too.
              if (e.key === "Escape") {
                e.stopPropagation();
                setEditingId(null);
              }
              // Every other key is the textarea's: newline, arrows, Backspace.
              // The stage's shortcuts already exempt form controls.
              e.stopPropagation();
            }}
          />
        )}

        {showBuildBadges &&
          objects
            .filter((o) => (o.build?.step ?? 0) > 0)
            .map((o) => (
              <span
                key={`b-${o.id}`}
                className="deck-build-badge"
                style={{ left: o.x * size.w, top: o.y * size.h }}
                title={t("deckStage.buildBadgeTitle", {
                  step: o.build!.step,
                  effect: t(EFFECT_KEYS.find((f) => f.id === o.build!.effect)?.key ?? "deckAnimate.effectNone"),
                })}
              >
                {o.build!.step}
              </span>
            ))}

        {selBox && (
          <div
            className="deck-selection"
            style={{
              left: selBox.x * size.w,
              top: selBox.y * size.h,
              width: selBox.w * size.w,
              height: selBox.h * size.h,
            }}
          >
            {singleSelection && (
              <>
                {HANDLES.map((h) => (
                  <span key={h} className={`deck-handle deck-handle-${h}`} data-handle={h} />
                ))}
                <span className="deck-rotate" data-rotate="1" />
              </>
            )}
          </div>
        )}

        {marquee && (
          <div
            className="deck-marquee"
            style={{
              left: marquee.x * size.w,
              top: marquee.y * size.h,
              width: marquee.w * size.w,
              height: marquee.h * size.h,
            }}
          />
        )}

        <svg className="deck-guides" width={size.w} height={size.h} aria-hidden>
          {guides.map((g, i) =>
            g.axis === "x" ? (
              <line
                key={i}
                className={`deck-guide deck-guide-${g.kind}`}
                x1={g.at * size.w}
                x2={g.at * size.w}
                y1={g.from * size.h}
                y2={g.to * size.h}
              />
            ) : (
              <line
                key={i}
                className={`deck-guide deck-guide-${g.kind}`}
                x1={g.from * size.w}
                x2={g.to * size.w}
                y1={g.at * size.h}
                y2={g.at * size.h}
              />
            ),
          )}
        </svg>
      </div>
    </div>
  );
}

/** Objects past the previewed build step are dimmed rather than hidden, so they
 *  stay selectable while their steps are being arranged. */
function dimmed(o: DeckObject, step?: number): DeckObject {
  if (step === undefined || visibleAt(o, step)) return o;
  return { ...o, opacity: o.opacity * 0.25 };
}

/** Apply a resize-handle drag to a box, before snapping. */
export function applyHandle(box: Box, handle: ResizeHandle, dx: number, dy: number): Box {
  let { x, y, w, h } = box;
  if (handle.includes("w")) {
    x += dx;
    w -= dx;
  }
  if (handle.includes("e")) w += dx;
  if (handle.includes("n")) {
    y += dy;
    h -= dy;
  }
  if (handle.includes("s")) h += dy;
  return { x, y, w, h };
}
