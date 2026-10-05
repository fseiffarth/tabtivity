/**
 * The finger half of a hand-arranged list: the gesture the project screen's tab
 * cards and the home screen's project cards both wear.
 *
 * Where a drop lands and what the list then looks like is arithmetic, and lives
 * in `tabReorder.ts`. This is everything around it that needs a browser — a
 * pointer captured to the grip so the page's own scrolling cannot steal the
 * drag, the edge scrolling a list taller than the phone needs, and the arrow
 * keys, which are the only way to ask for the same move without a finger.
 *
 * What a move *means* stays with the caller: a tab order is the desktop's and a
 * drop there is a bridge write, while the project order is this phone's own.
 */
import { useRef, useState } from "react";
import type { TabPlace } from "./api";
import { dropSlot, type RowBox } from "./tabReorder";

/** How close to the top or bottom edge a dragged row must come before the
 * screen starts scrolling under it, and how far it scrolls per frame. Without
 * this a list longer than the screen could only be rearranged within the part
 * of it the finger could reach. */
const EDGE_MARGIN = 84;
const EDGE_STEP = 12;

/** The row under the finger and the slot it would land in. */
export interface DragState {
  key: string;
  slot: { anchor: string; place: TabPlace } | null;
}

export interface RowDrag {
  drag: DragState | null;
  /** The classes one row wears while a drag is running: the moved row is faded
   * and the row it would land beside carries the line. Appended to the row's
   * own class list, so it starts with a space and is empty the rest of the
   * time. */
  rowClass: (key: string) => string;
  /** `ref` for the row element a drop position is read off. */
  rowRef: (key: string) => (node: HTMLElement | null) => void;
  /** Everything the grip button needs: the drag, and the arrow keys. */
  gripProps: (key: string) => {
    onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
    onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
  };
}

/**
 * `keys` is the list as it is drawn, in that order — the rectangles a drop is
 * read off are taken from it, and the arrow keys step through it. `move` is
 * handed the two rows and the side; it is called once, when the finger lifts
 * over a row that is not the dragged one.
 *
 * `enabled: false` makes every grip inert rather than removing the hook, so a
 * screen can offer the grips under one sort order and not another without
 * changing which hooks it runs.
 */
export function useRowDrag(
  keys: readonly string[],
  move: (key: string, anchor: string, place: TabPlace) => void,
  enabled = true,
): RowDrag {
  /** The rows' rectangles, read at the moment they are needed rather than kept:
   * the page scrolls under the finger while the drag is running. */
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const rowBoxes = (): RowBox[] => keys.flatMap((key) => {
    const rect = rowRefs.current.get(key)?.getBoundingClientRect();
    return rect ? [{ id: key, top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }] : [];
  });
  const [drag, setDrag] = useState<DragState | null>(null);

  /** Drag one row by its grip. Pointer-driven and captured to the grip, so the
   *  gesture cannot be stolen by the page's own scrolling (the grip also sets
   *  `touch-action:none`), and the page scrolls itself when the finger reaches
   *  either edge — a list of ten rows is taller than the phone. */
  const startDrag = (event: React.PointerEvent<HTMLButtonElement>, key: string) => {
    if (!enabled || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    let pointerY = event.clientY;
    let pointerX = event.clientX;
    let slot = dropSlot(rowBoxes(), key, pointerY, pointerX);
    let frame = 0;
    const track = () => { slot = dropSlot(rowBoxes(), key, pointerY, pointerX); setDrag({ key, slot }); };
    const edgeScroll = () => {
      frame = 0;
      const dy = pointerY < EDGE_MARGIN ? -EDGE_STEP : pointerY > window.innerHeight - EDGE_MARGIN ? EDGE_STEP : 0;
      if (!dy) return;
      window.scrollBy(0, dy);
      track();
      frame = requestAnimationFrame(edgeScroll);
    };
    const onMove = (pointer: PointerEvent) => {
      pointerY = pointer.clientY;
      pointerX = pointer.clientX;
      track();
      if (!frame) edgeScroll();
    };
    const finish = (commit: boolean) => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onCancel);
      if (frame) cancelAnimationFrame(frame);
      setDrag(null);
      if (commit && slot) move(key, slot.anchor, slot.place);
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onCancel);
    setDrag({ key, slot });
  };

  /** The same move, one step at a time — a drag is not reachable by a keyboard
   *  or a screen reader, and these lists are also read on a tablet with one
   *  attached. */
  const nudge = (key: string, delta: -1 | 1) => {
    const index = keys.indexOf(key);
    const target = keys[index + delta];
    if (index < 0 || target === undefined) return;
    move(key, target, delta < 0 ? "before" : "after");
  };

  return {
    drag,
    rowClass: (key) => `${drag?.key === key ? " dragging" : ""}${drag?.slot?.anchor === key ? ` drop-${drag.slot.place}` : ""}`,
    rowRef: (key) => (node) => { if (node) rowRefs.current.set(key, node); else rowRefs.current.delete(key); },
    gripProps: (key) => ({
      onPointerDown: (event) => startDrag(event, key),
      onKeyDown: (event) => {
        // Left and right too: on a wide screen the cards stand two to a line.
        const step = event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : 0;
        if (!step) return;
        event.preventDefault();
        if (enabled) nudge(key, step);
      },
    }),
  };
}
