/**
 * The page-arrangement strip: a row (or column) of page thumbnails you can
 * shift-select, drag to reorder, turn and delete.
 *
 * ONE widget, two homes — the print preview's horizontal strip and the PDF viewer's
 * vertical page rail — so reordering behaves identically in both. It edits the
 * shared `lib/viewers/pageModel` arrangement and reports each edit through
 * `onChange`; it owns no arrangement state of its own, only the transient selection
 * and drag.
 *
 * The drag is pointer-based, not HTML5 DnD, which is broken under WebKitGTK (the
 * same reason the tab strip is pointer-driven). Terminal events go through
 * `bindDragRelease` so the per-engine pointercancel/capture/blur divergence comes
 * from the one vetted policy rather than being re-derived here.
 *
 * Reordering is applied LIVE as the pointer crosses a neighbour, so the print
 * preview reflows under the cursor exactly as it did before. Escape puts the
 * arrangement back the way it was when the drag began.
 */
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  movePages,
  deletePages,
  rotatePages,
  duplicatePages,
  type PageList,
  type PageRef,
} from "../../lib/viewers/pageModel";
import { nextSelection } from "../../lib/viewers/fileUtils";
import { bindDragRelease, dragPlatform } from "../../lib/window/dragPlatform";
import { useClampToViewport } from "../../hooks/useClampToViewport";
import {
  registerPageStrip,
  resolveDropTarget,
  paintCaret,
  importInto,
  emitPdfDragStart,
  emitPdfDragMove,
  emitPdfDragEnd,
  awaitDropAck,
  currentWindowLabel,
  listenForeignPageDrags,
  setPageDragActive,
  type PageTransfer,
  type DropTarget,
} from "../../stores/drag/pdfDrag";
import {
  snapshotFrame,
  startCursorPoll,
  pointInOuter,
  physToClient,
  type PhysPoint,
  type WindowFrame,
} from "../../lib/window/coords";
import { useT } from "../../lib/i18n";

/** Below this many px of pointer travel a press is a click, not a drag. */
const DRAG_THRESHOLD_PX = 5;

/** A card's box, paired with the arrangement index it sits at. */
export interface CardBox {
  index: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Where a drag would insert, given the boxes of the cards NOT being dragged (in
 * arrangement order) and the pointer. The result counts only those cards — which is
 * exactly `movePages`' index convention — so it can be handed straight to it.
 *
 * The pointer lands *before* the first card whose midpoint it has not yet passed,
 * along the strip's own axis; past them all, it appends.
 */
export function insertionIndexAt(
  others: readonly CardBox[],
  x: number,
  y: number,
  orientation: "row" | "column",
): number {
  for (let i = 0; i < others.length; i++) {
    const b = others[i];
    const mid =
      orientation === "row" ? (b.left + b.right) / 2 : (b.top + b.bottom) / 2;
    const along = orientation === "row" ? x : y;
    if (along < mid) return i;
  }
  return others.length;
}

interface ContextMenuState {
  x: number;
  y: number;
  /** The sheets the menu acts on (the selection, or the right-clicked sheet). */
  ids: string[];
}

export interface PageStripProps {
  /** The arrangement to show. */
  pages: PageList;
  /** Apply an edit (reorder / delete / rotate / duplicate). */
  onChange: (next: PageList) => void;
  /** Lay the cards out along the x axis (print strip) or the y axis (PDF rail). */
  orientation?: "row" | "column";
  /** The thumbnail for one sheet. The strip supplies the card, box and rotation. */
  renderThumb: (ref: PageRef, index: number) => ReactNode;
  /** The card's corner badge — the print position, or the page number in the rail. */
  badgeFor?: (ref: PageRef, index: number) => string;
  /** Dim a sheet (the print preview dims pages its selection excludes). */
  isExcluded?: (ref: PageRef, index: number) => boolean;
  /** The card's tooltip. */
  titleFor?: (ref: PageRef, index: number) => string;
  /** Told the selection whenever it changes, so the host can act on it (copy/cut). */
  onSelectionChange?: (ids: Set<string>) => void;
  className?: string;

  // ── Cross-viewer / cross-window page transfer (optional) ───────────────────
  // Supplying these three turns the strip into a drag SOURCE and a drop TARGET for
  // other strips — in this window and in other Tabtivity windows. The print preview
  // omits them, so its strip only ever reorders within itself.

  /** Stable id identifying this strip among all mounted ones. Required for transfer. */
  stripId?: string;
  /** Extract `ids` into a transferable PDF parked in the backend page clipboard. */
  onExport?: (ids: string[]) => Promise<PageTransfer | null>;
  /** Splice pages transferred from another strip in at `index`. */
  onImport?: (transfer: PageTransfer, index: number) => void;
  /** The pages were MOVED out (Shift), and the drop was acknowledged: drop them. */
  onMovedOut?: (ids: string[]) => void;
}

/** Reference-counted, so the foreign-drag listener exists exactly while at least one
 *  droppable strip is mounted in this window. */
let foreignListeners = 0;
let stopForeign: Promise<() => void> | null = null;

export function PageStrip({
  pages,
  onChange,
  orientation = "row",
  renderThumb,
  badgeFor,
  isExcluded,
  titleFor,
  onSelectionChange,
  className,
  stripId,
  onExport,
  onImport,
  onMovedOut,
}: PageStripProps) {
  const t = useT();
  const stripRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchorRef = useRef<string | null>(null);
  const [draggingIds, setDraggingIds] = useState<Set<string> | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useClampToViewport(menuRef, menu, setMenu);
  /** Where a foreign drag would land (an insertion caret), or null. */
  const [caret, setCaret] = useState<number | null>(null);

  /** True when this strip can send pages to, and receive them from, other strips. */
  const transferable = Boolean(stripId && onExport && onImport);

  /** Insertion index for a point in this window's client px — the geometry a foreign
   *  drag needs from us, computed against our own live card rects. */
  const indexAt = useCallback(
    (p: { x: number; y: number }) => {
      const strip = stripRef.current;
      if (!strip) return 0;
      const boxes: CardBox[] = [];
      strip.querySelectorAll<HTMLElement>("[data-page-id]").forEach((el, i) => {
        const b = el.getBoundingClientRect();
        boxes.push({ index: i, left: b.left, top: b.top, right: b.right, bottom: b.bottom });
      });
      return insertionIndexAt(boxes, p.x, p.y, orientation);
    },
    [orientation],
  );

  // Publish this strip so a drag from another strip — or another window — can find it,
  // and keep the window's foreign-drag listener alive while any such strip exists.
  const importRef = useRef(onImport);
  importRef.current = onImport;
  useEffect(() => {
    const el = stripRef.current;
    if (!transferable || !stripId || !el) return;
    const unregister = registerPageStrip(stripId, {
      el,
      indexAt,
      onImport: (t, index) => importRef.current?.(t, index),
      setCaret,
    });
    foreignListeners += 1;
    if (foreignListeners === 1) stopForeign = listenForeignPageDrags();
    return () => {
      unregister();
      foreignListeners -= 1;
      if (foreignListeners === 0 && stopForeign) {
        const pending = stopForeign;
        stopForeign = null;
        void pending.then((f) => f());
      }
    };
  }, [transferable, stripId, indexAt]);

  // `pages` changes under the drag's feet (it reorders live), so the handlers read
  // it from a ref rather than closing over the render's snapshot.
  const pagesRef = useRef(pages);
  pagesRef.current = pages;

  const select = useCallback(
    (ids: Set<string>) => {
      setSelected(ids);
      onSelectionChange?.(ids);
    },
    [onSelectionChange],
  );

  // Drop ids that no longer exist (a delete, or a fresh document).
  useEffect(() => {
    const live = new Set(pages.map((r) => r.id));
    setSelected((cur) => {
      if ([...cur].every((id) => live.has(id))) return cur;
      const pruned = new Set([...cur].filter((id) => live.has(id)));
      onSelectionChange?.(pruned);
      return pruned;
    });
  }, [pages, onSelectionChange]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);

  /** The sheets an action applies to: the selection when the sheet is in it, else
   *  just that sheet (right-clicking outside a selection acts on what you clicked). */
  const targetIds = useCallback(
    (id: string): string[] => (selected.has(id) ? [...selected] : [id]),
    [selected],
  );

  const onCardPointerDown = useCallback(
    (e: React.PointerEvent, id: string) => {
      if (e.button !== 0) return;
      // WebKitGTK's native selection gesture would otherwise claim the pointer
      // stream and end it in `pointercancel`.
      e.preventDefault();
      setMenu(null);

      const startX = e.clientX;
      const startY = e.clientY;
      const mods = { shift: e.shiftKey, toggle: e.ctrlKey || e.metaKey };
      // Pressing an unselected card selects it right away, so a drag that starts
      // immediately drags what's under the cursor. Pressing one that is ALREADY
      // selected defers to the release, so dragging a multi-selection keeps it.
      if (!selected.has(id) && !mods.shift && !mods.toggle) {
        select(new Set([id]));
        anchorRef.current = id;
      }

      // The arrangement as it stood before the drag, so Escape — or the pages leaving
      // the strip entirely — can put it back.
      const listAtStart = pagesRef.current;
      let dragging = false;
      let lastTarget = -1;

      // Which sheets travel: the whole selection if the pressed card is part of it,
      // else just the pressed one.
      const moving =
        selected.has(id) && !mods.toggle ? new Set(selected) : new Set([id]);
      const movingIds = [...moving];

      // ── Cross-strip / cross-window state ────────────────────────────────────
      // `leaving` flips once the pointer exits this strip: the pages are no longer
      // being *reordered* here, they are being taken somewhere else.
      let leaving = false;
      let transfer: PageTransfer | null = null;
      let exporting: Promise<PageTransfer | null> | null = null;
      let stopPoll: (() => void) | null = null;
      let frame: WindowFrame | null = null;
      let lastPhys: PhysPoint | null = null;
      const label = currentWindowLabel();

      /** The pages are leaving: undo the live reorder, park them, and start streaming
       *  the OS cursor so other windows can see the drag. */
      const beginLeaving = () => {
        leaving = true;
        lastTarget = -1;
        onChange(listAtStart); // they are not staying here — put the strip back
        // Every other PDF viewer springs its rail open, so a document that was merely
        // *open* becomes a place these pages can be dropped. Reported directly rather
        // than read back off the event, so a drop in this same window is covered too.
        setPageDragActive(true);
        emitPdfDragStart(label, movingIds.length);
        exporting = onExport!(movingIds).then((t) => {
          transfer = t;
          return t;
        });
        void snapshotFrame()
          .then((f) => {
            frame = f;
          })
          .catch(() => {});
        // DOM pointer events stop at the window edge on WebKitGTK, so from here the
        // position comes from the OS cursor — the only source that crosses windows.
        stopPoll = startCursorPoll((p) => {
          lastPhys = p;
          emitPdfDragMove(label, p);
        });
      };

      /** Back inside the strip: the pages are staying, so resume a plain reorder. */
      const cancelLeaving = () => {
        leaving = false;
        lastTarget = -1;
        stopPoll?.();
        stopPoll = null;
        paintCaret(null);
      };

      const onMove = (ev: PointerEvent) => {
        if (!dragging) {
          if (
            Math.abs(ev.clientX - startX) < DRAG_THRESHOLD_PX &&
            Math.abs(ev.clientY - startY) < DRAG_THRESHOLD_PX
          ) {
            return;
          }
          dragging = true;
          setDraggingIds(moving);
        }

        const strip = stripRef.current;
        if (!strip) return;
        const r = strip.getBoundingClientRect();
        const inside =
          ev.clientX >= r.left &&
          ev.clientX <= r.right &&
          ev.clientY >= r.top &&
          ev.clientY <= r.bottom;

        if (transferable && !inside) {
          if (!leaving) beginLeaving();
          // Another strip in THIS window is resolved straight from the DOM; a strip in
          // another window is driven by the streamed cursor (see `listenForeignPageDrags`).
          paintCaret(resolveDropTarget({ x: ev.clientX, y: ev.clientY }, stripId));
          return;
        }
        if (leaving) cancelLeaving();

        const others: CardBox[] = [];
        pagesRef.current.forEach((ref, index) => {
          if (moving.has(ref.id)) return;
          const el = strip.querySelector<HTMLElement>(`[data-page-id="${ref.id}"]`);
          if (!el) return;
          const b = el.getBoundingClientRect();
          others.push({
            index,
            left: b.left,
            top: b.top,
            right: b.right,
            bottom: b.bottom,
          });
        });

        const target = insertionIndexAt(others, ev.clientX, ev.clientY, orientation);
        if (target === lastTarget) return;
        lastTarget = target;
        onChange(movePages(pagesRef.current, movingIds, target));
      };

      window.addEventListener("pointermove", onMove);
      if (dragPlatform.needsPointerCapture) {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }

      /** Hand the pages to a strip elsewhere. Returns once the fate of a Shift-move
       *  (delete from here, or not) is known. */
      const dropElsewhere = async (shift: boolean) => {
        const t = (await exporting) ?? transfer;
        if (!t) return; // the export failed — nothing was parked, so nothing moves

        // Where is the cursor REALLY? On WebKitGTK the DOM release fires in this
        // window even when the cursor is over another one, so the polled desktop
        // position decides — never the event's coordinates.
        const overMe = frame && lastPhys ? pointInOuter(frame, lastPhys) : true;
        if (overMe) {
          const c =
            frame && lastPhys ? physToClient(frame, lastPhys) : { x: startX, y: startY };
          const target: DropTarget | null = resolveDropTarget(c, stripId);
          if (target && importInto(target, t) && shift) onMovedOut?.(movingIds);
          return;
        }

        // The drop is in some other window. Broadcast it, and only remove the pages
        // from here once a window actually acknowledges taking them — a Shift-drag
        // released over empty desktop must not destroy them.
        emitPdfDragEnd({
          originLabel: label,
          token: t.token,
          count: t.count,
          physX: lastPhys?.x ?? 0,
          physY: lastPhys?.y ?? 0,
          shift,
          cancelled: false,
        });
        if (!shift) return;
        if (await awaitDropAck(t.token)) onMovedOut?.(movingIds);
      };

      const finish = (restore: boolean, shift = false) => {
        window.removeEventListener("pointermove", onMove);
        setDraggingIds(null);
        stopPoll?.();
        stopPoll = null;
        paintCaret(null);

        if (restore) {
          if (leaving) {
            setPageDragActive(false);
            // Tell the other windows to drop their carets; nothing is being handed over.
            emitPdfDragEnd({
              originLabel: label,
              token: transfer?.token ?? "",
              count: movingIds.length,
              physX: lastPhys?.x ?? 0,
              physY: lastPhys?.y ?? 0,
              shift: false,
              cancelled: true,
            });
          }
          onChange(listAtStart);
          return;
        }
        if (leaving) {
          // The end is announced only once the drop has been RESOLVED. Announcing it
          // here would close every rail this drag sprang open — including the one the
          // pointer is over — and `dropElsewhere` would then find no strip registered
          // at the target and quietly drop the pages on the floor.
          void dropElsewhere(shift).finally(() => setPageDragActive(false));
          return;
        }
        // A press that never became a drag is a click: apply the modifiers.
        if (!dragging) {
          const ordered = pagesRef.current.map((r) => r.id);
          const next = nextSelection(selected, ordered, anchorRef.current, id, mods);
          anchorRef.current = next.anchor;
          select(next.selected);
        }
      };

      bindDragRelease({
        onCommit: (shift) => finish(false, shift),
        onAbort: () => finish(true),
      });
    },
    [onChange, orientation, select, selected, transferable, stripId, onExport, onMovedOut],
  );

  const act = useCallback(
    (next: PageList) => {
      setMenu(null);
      onChange(next);
    },
    [onChange],
  );

  if (pages.length === 0) return null;

  return (
    <>
      <div
        ref={stripRef}
        className={`page-strip page-strip-${orientation}${className ? ` ${className}` : ""}`}
        role="list"
        aria-label={t("pageStrip.ariaLabel")}
      >
        {pages.map((ref, index) => {
          const excluded = isExcluded?.(ref, index) ?? false;
          const badge = badgeFor?.(ref, index);
          const quarter = ref.rot === 90 || ref.rot === 270;
          return (
            <Fragment key={ref.id}>
              {caret === index && <div className="page-strip-caret" aria-hidden="true" />}
            <div
              data-page-id={ref.id}
              role="listitem"
              className={
                "page-strip-card" +
                (excluded ? " is-excluded" : "") +
                (quarter ? " is-quarter-turned" : "") +
                (selected.has(ref.id) ? " is-selected" : "") +
                (draggingIds?.has(ref.id) ? " is-dragging" : "")
              }
              style={{ ["--page-thumb-rot" as string]: `${ref.rot}deg` }}
              title={titleFor?.(ref, index)}
              onPointerDown={(e) => onCardPointerDown(e, ref.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!selected.has(ref.id)) {
                  select(new Set([ref.id]));
                  anchorRef.current = ref.id;
                }
                setMenu({ x: e.clientX, y: e.clientY, ids: targetIds(ref.id) });
              }}
            >
              {renderThumb(ref, index)}
              {badge !== undefined && <span className="page-strip-num">{badge}</span>}
              <button
                className="page-strip-rotate"
                type="button"
                title={t("pageStrip.turnClockwiseTitle")}
                aria-label={t("pageStrip.turnClockwiseAria")}
                onPointerDown={(e) => e.stopPropagation()} // not a drag
                onClick={() => act(rotatePages(pages, targetIds(ref.id)))}
              >
                ⟳
              </button>
              <button
                className="page-strip-del"
                type="button"
                title={t("pageStrip.removePageTitle")}
                aria-label={t("pageStrip.removePageAria")}
                onPointerDown={(e) => e.stopPropagation()} // not a drag
                onClick={() => act(deletePages(pages, targetIds(ref.id)))}
              >
                ✕
              </button>
            </div>
            </Fragment>
          );
        })}
        {caret === pages.length && <div className="page-strip-caret" aria-hidden="true" />}
      </div>

      {menu &&
        createPortal(
          <div
            ref={menuRef}
            className="context-menu page-strip-context-menu"
            style={{ left: menu.x, top: menu.y }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button onClick={() => act(rotatePages(pages, menu.ids, 90))}>
              {t("pageStrip.turnRight")}
            </button>
            <button onClick={() => act(rotatePages(pages, menu.ids, -90))}>
              {t("pageStrip.turnLeft")}
            </button>
            <button onClick={() => act(duplicatePages(pages, menu.ids))}>
              {t("pageStrip.duplicate")}
            </button>
            <hr />
            <button onClick={() => act(deletePages(pages, menu.ids))}>
              {menu.ids.length > 1 ? t("pageStrip.deleteMany", { count: menu.ids.length }) : t("pageStrip.deleteOne")}
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
