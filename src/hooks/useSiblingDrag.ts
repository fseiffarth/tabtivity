import { useMemo, useRef, useState } from "react";

/** The in-flight gesture: the index picked up and the index it would land on. */
export interface SiblingDrag {
  from: number;
  to: number;
}

/** The grip's pointer handlers. Stable for the component's lifetime, so a
 *  memoized row that is handed them does not re-render for it. */
export interface SiblingGrip {
  down: (index: number, e: React.PointerEvent<HTMLElement>) => void;
  move: (e: React.PointerEvent<HTMLElement>) => void;
  up: (e: React.PointerEvent<HTMLElement>) => void;
  cancel: () => void;
}

/**
 * Reordering one entry among its siblings by dragging its grip, where the list
 * does NOT part around the dragged row — the YAML tree (a row heads a whole block,
 * so the landing spot is a drop line) and the YAML cards (a 2-D grid, so it is a
 * ring on the target). A flat list whose rows slide apart uses `useListReorder`.
 *
 * The caller owns what differs between such surfaces: `indexAt` hit-tests the
 * pointer against its own elements, `commit` decides whether the move is allowed
 * and writes it. `commit` is only called for a real move (`to !== from`).
 *
 * - **Pointer events, not HTML5 DnD**, which does not work under WebKitGTK; and
 *   every handler is bound to the grip up front rather than added to the window
 *   mid-gesture, because listeners registered once a gesture is already under way
 *   are the ones WebKitGTK drops.
 * - **The grip takes the pointer capture**, so the gesture survives the pointer
 *   leaving the row. Optional calls, because jsdom has no pointer capture and the
 *   drag is still the drag without it.
 * - **A cancelled gesture writes NOTHING** (`useListReorder` states the same
 *   rule): a hit-test's fallback for a pointer outside the list is an ordinary
 *   index, so committing on `pointercancel` would let a press-and-twitch move an
 *   entry and splice the file — a silent edit nobody asked for.
 */
export function useSiblingDrag(
  indexAt: (x: number, y: number, from: number) => number,
  commit: (from: number, to: number) => void,
): { drag: SiblingDrag | null; grip: SiblingGrip } {
  // The live gesture is a ref (the handlers read it without re-binding) and state
  // (the drop mark has to render).
  const live = useRef<SiblingDrag | null>(null);
  const [drag, setDrag] = useState<SiblingDrag | null>(null);
  const latest = useRef({ indexAt, commit });
  latest.current = { indexAt, commit };

  const grip = useMemo<SiblingGrip>(() => {
    const set = (next: SiblingDrag | null) => {
      live.current = next;
      setDrag(next);
    };
    return {
      down(index, e) {
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        set({ from: index, to: index });
      },
      move(e) {
        const d = live.current;
        if (!d) return;
        const to = latest.current.indexAt(e.clientX, e.clientY, d.from);
        if (to !== d.to) set({ from: d.from, to });
      },
      up(e) {
        e.currentTarget.releasePointerCapture?.(e.pointerId);
        const d = live.current;
        set(null);
        if (d && d.to !== d.from) latest.current.commit(d.from, d.to);
      },
      cancel() {
        set(null);
      },
    };
  }, []);

  return { drag, grip };
}
