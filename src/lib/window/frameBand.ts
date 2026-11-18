import { createContext, useContext, useLayoutEffect, useState, type RefObject } from "react";

/**
 * The root window's width bands (`docs/cockpit_root_merge_plan.md`, decision 8).
 * The breakpoints are on the **frame's** width (the window is movable, resizable
 * and remembered, so the viewport says nothing about it):
 *
 *  - `wide`   1180 px and up: every control, Now's three columns;
 *  - `mid`    820 to 1179 px: Needs-you becomes an icon rail (a popover opens
 *             the full one), roster and detail side by side;
 *  - `narrow` under 820 px: master and detail, a "Needs you N" chip, Tonight and
 *             Usage stacked, the title bar folded.
 *
 * One measure, two readers: the shell writes the band on the frame
 * (`data-band`, for the CSS) and provides it through `FrameBandContext` (for the
 * views that swap what they mount, so a hidden column mounts nothing).
 */
export type FrameBand = "wide" | "mid" | "narrow";

/** A frame narrower than this is `narrow`. */
export const NARROW_BELOW_PX = 820;
/** A frame at least this wide is `wide`. */
export const WIDE_FROM_PX = 1180;

/** The band of a frame `width` px wide. An unmeasured frame (0, as in a test
 *  without layout) reads as `wide`: the full layout is the safe default. */
export function frameBand(width: number): FrameBand {
  if (!(width > 0)) return "wide";
  if (width < NARROW_BELOW_PX) return "narrow";
  return width < WIDE_FROM_PX ? "mid" : "wide";
}

/** The band of the frame behind `ref`, kept current while it is resized. */
export function useFrameBand(ref: RefObject<HTMLElement | null>): FrameBand {
  const [band, setBand] = useState<FrameBand>("wide");
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setBand(frameBand(el.clientWidth));
    read();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return band;
}

/** What the shell measured, for the views inside it (`wide` outside a frame). */
export const FrameBandContext = createContext<FrameBand>("wide");

export function useFrameBandValue(): FrameBand {
  return useContext(FrameBandContext);
}
