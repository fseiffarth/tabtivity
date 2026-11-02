import { useEffect, useRef, type RefObject } from "react";

/** How far a press may travel and still be a tap, in CSS pixels. */
const SLOP = 10;
/** What stands over the screen: a tap there is about that, not the screen. */
const OVERLAY = '[role="dialog"], .markup-host';

/**
 * Runs `onTap` when, while `open`, a tap lands outside `area` — the way a
 * dropped-down list shuts on a tap anywhere else. Read from pointer events on
 * the window, since iOS sends no `click` for a tap on plain text. A drag is not
 * a tap: scrolling the screen leaves the list open (a touch scroll ends in
 * `pointercancel`, a mouse drag travels past `SLOP`). A tap on a sheet or
 * viewer opened from the list leaves it open too, for when that closes.
 */
export function useTapOutside(area: RefObject<HTMLElement>, open: boolean, onTap: () => void): void {
  const run = useRef(onTap);
  run.current = onTap;
  useEffect(() => {
    if (!open) return;
    let press: { x: number; y: number } | null = null;
    const down = (event: PointerEvent) => { press = { x: event.clientX, y: event.clientY }; };
    const up = (event: PointerEvent) => {
      const from = press;
      press = null;
      if (!from || Math.abs(event.clientX - from.x) > SLOP || Math.abs(event.clientY - from.y) > SLOP) return;
      const target = event.target;
      if (!(target instanceof Element) || area.current?.contains(target) || target.closest(OVERLAY)) return;
      run.current();
    };
    const cancel = () => { press = null; };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", cancel, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", cancel, true);
    };
  }, [area, open]);
}
