/**
 * Clearing a **stray OS fullscreen** off a Tabtivity window — the state that makes
 * a popout silently stop moving.
 *
 * A window the WM has put into `_NET_WM_STATE_FULLSCREEN` loses
 * `_NET_WM_ACTION_MOVE` (observed live under Muffin; KWin does the same, and
 * Windows strips the styles native dragging relies on), so it refuses the
 * `_NET_WM_MOVERESIZE` that `startDragging` sends and every title-bar / grip drag
 * no-ops with nothing on screen to say why. A popout has no OS title bar, so a
 * fullscreen one is indistinguishable from a merely large one: it has simply
 * stopped being movable. That is why `restore_main_window` clears it for the main
 * window, why F11 in a popout MAXIMIZES instead, and why `DetachedApp` runs a
 * continuous guard.
 *
 * **Why this module exists — the guard could not see the state it guards against.**
 * `Window.isFullscreen()` does not ask the window manager. tao stores the value
 * its own `set_fullscreen` last wrote (`fullscreen: RefCell<Option<Fullscreen>>`
 * in `platform_impl/linux/window.rs`) and `fullscreen()` returns that cache. So a
 * fullscreen that came from ANYWHERE else — the WM's own shortcut, a page calling
 * `requestFullscreen()` (WebKitGTK fullscreens the toplevel for it) whose element
 * was then destroyed, a presenter torn down without its cleanup — reads back as
 * `false` for ever, and a guard gated on that read never fires. Live proof: a
 * popout carrying `_NET_WM_STATE_FULLSCREEN`, sized to exactly its monitor, with
 * `_NET_WM_ALLOWED_ACTIONS` holding neither MOVE nor RESIZE, while the guard that
 * exists to clear it sat there doing nothing.
 *
 * The fix is to stop reading and just clear: `set_fullscreen(None)` maps
 * unconditionally onto `gtk_window_unfullscreen()`, which is a no-op on a window
 * that isn't fullscreen. That is already how the backend does it for the main
 * window (`let _ = win.set_fullscreen(false)` — no read, no branch).
 *
 * What must NOT be cleared is the fullscreen someone asked for, so the decision
 * is the pure [`mayClearStrayFullscreen`]: the user's own fullscreen mode (F11 /
 * the window-controls button, `lib/window/fullscreenMode`), the page's own DOM
 * fullscreen (a video, the in-app browser) and a running talk all hold it, and
 * macOS is excluded for
 * the reason it always is — its own Space is the platform-expected behaviour there.
 * A DOM fullscreen whose element is gone leaves `document.fullscreenElement` null,
 * which is exactly the leak this then rescues.
 */

import { getCurrentWindow } from "@tauri-apps/api/window";
import { PLATFORM } from "../platform";
import { usePresentationStore } from "../../stores/viewers/presentation";
import { useFullscreenMode } from "./fullscreenMode";

/**
 * Is a fullscreen on this window "stray" — nobody's on purpose — and therefore
 * ours to clear? Pure, so the three holds are unit-testable without a WM.
 */
export function mayClearStrayFullscreen(input: {
  /** `PLATFORM`. macOS fullscreen is a Space the user chose; never touched. */
  platform: string;
  /** `document.fullscreenElement != null` — the PAGE is fullscreen, not the OS. */
  domFullscreen: boolean;
  /** Deck presenters on screen in this window (`usePresentationStore`). */
  presenting: number;
  /** The user put this window into fullscreen mode (`useFullscreenMode`). */
  requested: boolean;
}): boolean {
  if (input.platform === "macos") return false;
  if (input.requested) return false;
  if (input.domFullscreen) return false;
  if (input.presenting > 0) return false;
  return true;
}

/** How far the viewport may miss the screen and still count as filling it. */
const FILL_SLOP = 2;

/**
 * Does this window's viewport cover its whole screen? Pure half of
 * [`windowFillsScreen`].
 *
 * Both sides are CSS px, and `window.screen` reports the MONITOR — measured in an
 * offscreen WebKitGTK 2.x WebView on a 2048x1152 + 3840x2160 desk whose X screen
 * is 5888x2160: `{sw:3840, sh:2160, aw:3840, ah:2160, dpr:1}`, i.e. one monitor's
 * geometry, not the union, and `avail*` is not shrunk by the desktop panel. So the
 * two compare directly.
 *
 * This is the free, synchronous stand-in for the `isFullscreen()` read that lies.
 * It cannot tell a real fullscreen from a window merely sized to the monitor, and
 * does not need to: both are the shape a WM refuses to move, and clearing a
 * fullscreen that isn't there costs nothing. Its failure direction is the safe one — a window under a
 * per-window zoom, or an engine reporting the whole X screen, simply misses the
 * rescue and behaves exactly as it does today.
 */
export function fillsScreen(
  inner: { w: number; h: number },
  screen: { w: number; h: number },
): boolean {
  if (screen.w <= 0 || screen.h <= 0) return false;
  return (
    Math.abs(inner.w - screen.w) <= FILL_SLOP && Math.abs(inner.h - screen.h) <= FILL_SLOP
  );
}

/** [`fillsScreen`] against this window's live viewport. */
export function windowFillsScreen(): boolean {
  return fillsScreen(
    { w: window.innerWidth, h: window.innerHeight },
    { w: window.screen?.width ?? 0, h: window.screen?.height ?? 0 },
  );
}

/**
 * Clear a stray OS fullscreen off THIS window, unconditionally (see the module
 * note: the read is a cached lie, the write is a no-op when there is nothing to
 * clear). Resolves once the request has been handed to the window; whether the WM
 * had anything to do is not observable and not worth asking about.
 *
 * Best-effort by construction — every caller is a guard whose failure mode must
 * never be worse than the state it guards against.
 */
export async function clearStrayFullscreen(): Promise<void> {
  if (
    !mayClearStrayFullscreen({
      platform: PLATFORM,
      domFullscreen: document.fullscreenElement != null,
      presenting: usePresentationStore.getState().presenting,
      requested: useFullscreenMode.getState().on,
    })
  ) {
    return;
  }
  try {
    await getCurrentWindow().setFullscreen(false);
  } catch {
    /* a window that won't answer is not a reason to take anything down */
  }
}
