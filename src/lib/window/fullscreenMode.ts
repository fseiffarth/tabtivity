/**
 * The window's own **fullscreen mode** — F11 or the fullscreen button in
 * `WindowControls`, in the main window and in every popout alike.
 *
 * Tabtivity otherwise treats an OS fullscreen as a fault: a window in
 * `_NET_WM_STATE_FULLSCREEN` cannot be moved, so `restore_main_window` clears it
 * at launch and a popout's guard (`lib/window/strayFullscreen`) keeps clearing it
 * for as long as the popout lives. A fullscreen the user ASKED for is the one
 * case that must survive that guard, so asking for it is recorded here and the
 * guard reads the record (`mayClearStrayFullscreen`'s `requested`). Leaving it
 * is the same one control again — nothing is stranded the way a stray one is,
 * because the button and F11 are right there and say what they do.
 *
 * The record is per window: every webview runs its own copy of this module. It
 * is deliberately not persisted — a relaunch starts windowed (the backend clears
 * the main window; a restored popout's guard clears its own).
 *
 * Known gap: a fullscreen the WM ends by itself (its own shortcut) leaves the
 * record set, so the next toggle is a no-op "leave" and the button shows the
 * pressed state until then. Neither `isFullscreen()` (tao's cache of its own
 * last write) nor the viewport size (off under a per-window zoom) can see that
 * exit reliably, and a wrong guess here would let the guard throw the user out
 * of a fullscreen they asked for, which is the worse failure.
 */

import { getCurrentWindow } from "@tauri-apps/api/window";
import { create } from "zustand";

export const useFullscreenMode = create<{ on: boolean }>(() => ({ on: false }));

/** Enter or leave this window's fullscreen mode. Best-effort: a WM that
 *  refuses leaves the record where the window actually is. */
export async function toggleWindowFullscreen(): Promise<void> {
  const win = getCurrentWindow();
  // `isFullscreen()` answers tao's cache of the last `set_fullscreen`, which is
  // this toggle's own last write — or macOS's startup fullscreen and a talk's,
  // both of which the user expects F11 to leave. Only if the read fails does
  // the record decide.
  const was = await win.isFullscreen().catch(() => useFullscreenMode.getState().on);
  const next = !was;
  // Recorded BEFORE the request, so a guard woken by the transition's own
  // resize already sees that this one was asked for.
  useFullscreenMode.setState({ on: next });
  try {
    await win.setFullscreen(next);
  } catch (err) {
    useFullscreenMode.setState({ on: was });
    console.error("window fullscreen toggle failed", err);
  }
}
