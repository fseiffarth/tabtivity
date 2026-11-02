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

import { getCurrentWindow, type Window } from "@tauri-apps/api/window";
import { subscribeTauri } from "../../hooks/useTauriListener";
import { PLATFORM } from "../platform";
import { desktopCoordinatesSupported } from "./coords";
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

/**
 * Is the self-arming guard (mount, every settled resize, focus regain) allowed
 * to run in this session? Not on macOS, and not on native Wayland.
 *
 * On native Wayland the BACKEND puts a popout on its screen by making it
 * fullscreen on that output and leaving fullscreen once the compositor has
 * placed it (`present_on_monitor`). The guard cannot tell that deliberate
 * fullscreen from a stray one - `isFullscreen()` is a cached lie, see the module
 * note - and its resize trigger fires on the placement's own fullscreen entry,
 * so it unfullscreened the window before the compositor had placed it (GNOME
 * then puts it on the pointer's screen) and left the backend waiting for a
 * state that never came. The rescue it exists for is X11 (the window manager
 * taking MOVE off `_NET_WM_ALLOWED_ACTIONS`) and Windows; Wayland has no such
 * atom, and the rescue that remains there is the title-bar press (`DetachedCenterPanel`), which the
 * user starts and so never races a placement.
 *
 * "Native Wayland" is the capability the drag code already uses: GDK's backend
 * is not X11 (`desktop_coordinates_supported`). A backend too old to answer
 * reads as unsupported, so the guard stays off until the app is restarted into
 * the updated binary.
 */
export async function strayGuardMayAutoArm(): Promise<boolean> {
  if (PLATFORM === "macos") return false;
  return desktopCoordinatesSupported();
}

/**
 * Is a window of this PHYSICAL size filling its monitor - the shape a popout
 * has while the backend holds it fullscreen to place it? `dpr` converts to the
 * CSS px `window.screen` is measured in. Never fullscreen-sized while the
 * screen reports nothing.
 */
export function sizeFillsScreen(
  size: { w: number; h: number },
  dpr: number,
  screen: { w: number; h: number },
): boolean {
  const scale = dpr > 0 && Number.isFinite(dpr) ? dpr : 1;
  return fillsScreen({ w: size.w / scale, h: size.h / scale }, screen);
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

/**
 * The popout's continuous guard: clear a stray fullscreen at mount, 250 ms after
 * a resize settles and on focus regain (see the `DetachedApp` note this moved
 * out of). Returns the disposer. Armed only where [`strayGuardMayAutoArm`] says.
 *
 * Every path in here is wrapped, and that is not defensive habit: the effect
 * runs in a window whose ONLY content is one React root, so a throw out of it
 * unmounts the tree and leaves a grey OS window with nothing on it and no
 * message (observed, from a broken intermediate module during an HMR update). A
 * guard whose failure mode is worse than the state it guards against is not
 * worth having, so it can only ever decline to run.
 */
export function startStrayFullscreenGuard(
  win: Pick<Window, "onResized" | "onFocusChanged">,
  settleMs = 250,
): () => void {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unlisteners: Array<() => void> = [];
  const check = () => {
    try {
      if (disposed) return;
      void clearStrayFullscreen();
    } catch {
      /* never take the window down over a fullscreen check */
    }
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(check, settleMs);
  };
  void strayGuardMayAutoArm()
    .then((arm) => {
      if (!arm || disposed) return;
      check();
      unlisteners = [
        subscribeTauri(() => win.onResized(schedule)),
        subscribeTauri(() => win.onFocusChanged(({ payload }) => payload && schedule())),
      ];
    })
    .catch(() => {});
  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    for (const fn of unlisteners) fn();
  };
}
