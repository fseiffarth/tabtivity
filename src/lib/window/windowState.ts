/**
 * Pure logic behind the main window's geometry persistence: given the window's
 * live outer rect and what we last saved, decide what (if anything) to write.
 *
 * Kept out of `AppShell` so the one genuinely subtle rule below — what to store
 * while the window is MAXIMIZED — is unit-tested rather than reasoned about.
 *
 * All rects are PHYSICAL desktop px (`src/lib/window/coords.ts`): `outerPosition()` and
 * `outerSize()` already report physical, and the backend's `set_position` /
 * `set_size` consume physical, so nothing is ever converted.
 *
 * The consumer is `services::window_state::resolve_startup_geometry` on the Rust
 * side, which decides at startup whether a saved rect is still placeable.
 */
import type { WindowState } from "../../types";

/** A window's outer rect, physical desktop px. */
export interface OuterRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const sameWindowState = (a: WindowState, b: WindowState): boolean =>
  a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && a.maximized === b.maximized;

/**
 * The `WindowState` to persist, or `null` to write nothing (either the rect is
 * degenerate, or it is identical to what we already saved — a window drag fires a
 * lot of events and most of them settle back on the same place).
 *
 * The maximized rule: while the window is maximized its outer rect IS the monitor,
 * so it is not a *restore* geometry. Storing it would leave the window with no
 * known "normal" size, which is precisely the state `WindowControls.tsx` has to
 * work around — un-maximizing then appears to do nothing. So while maximized we
 * keep the last floating rect and only flip the flag.
 *
 * The exception is the very first run, when there is no floating rect at all
 * (Tabtivity opens maximized, and the user may never un-maximize it). Storing nothing
 * would mean never learning WHICH MONITOR the window is on — the whole point of
 * the feature. So we record the maximized rect: it is a correct monitor hint, and
 * it self-corrects into a true restore rect the first time the user un-maximizes.
 */
export function nextWindowState(
  prev: WindowState | undefined,
  outer: OuterRect,
  maximized: boolean,
): WindowState | null {
  const keepPrevRect = maximized && prev !== undefined;
  const rect: OuterRect = keepPrevRect
    ? { x: prev.x, y: prev.y, w: prev.w, h: prev.h }
    : outer;

  // A 0-sized rect means the window was queried mid-map (or is minimized on some
  // WMs). Persisting it would produce a window the user cannot see next launch.
  if (rect.w <= 0 || rect.h <= 0) return null;

  const next: WindowState = { ...rect, maximized };
  if (prev && sameWindowState(prev, next)) return null;
  return next;
}
