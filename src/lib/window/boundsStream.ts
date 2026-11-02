/**
 * #42: a popout's OS geometry, streamed back to the main window (the single
 * persistence owner) so it reopens at the same place/size after a restart. The
 * position and size come straight from the move/resize event payloads (no extra
 * window-getter permissions); a drag is debounced so it doesn't flood the
 * channel.
 */

import type { Window } from "@tauri-apps/api/window";
import { subscribeTauri } from "../../hooks/useTauriListener";
import { desktopCoordinatesSupported } from "./coords";
import { detachedWindowVisible } from "./detachedVisibility";
import { useFullscreenMode } from "./fullscreenMode";
import { sizeFillsScreen } from "./strayFullscreen";

export type StreamedBounds = { x: number; y: number; w: number; h: number };

export function startBoundsStream(
  win: Pick<Window, "innerSize" | "onMoved" | "onResized" | "isVisible" | "isMinimized">,
  emitBounds: (bounds: StreamedBounds) => void,
  debounceMs = 300,
): () => void {
  let pos: { x: number; y: number } | null = null;
  // Group B #236: seeded from the window's ACTUAL physical size, not from the
  // builder's LOGICAL default. `onMoved`/`onResized` payloads are physical, so
  // a popout that was moved but never resized used to flush the literal
  // 900×640 as a physical rect — and respawned at half size on a 2× display.
  // Until the read lands, a flush is refused rather than guessed at.
  let size: { w: number; h: number } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  win
    .innerSize()
    .then((s) => {
      if (!cancelled && !size) size = { w: s.width, h: s.height };
    })
    .catch(() => {});
  const flush = () => {
    if (!pos || !size) return;
    // A fullscreen popout's rect is its monitor, not a place to reopen at.
    if (useFullscreenMode.getState().on) return;
    // #238: a park (`hide()`) / unpark (`show()`) can fire Moved/Resized with
    // whatever geometry the WM used while the window was off screen. Persisting
    // that would move the popout on the next launch, so a flush is only taken
    // while the window is actually visible.
    void Promise.all([detachedWindowVisible(win), desktopCoordinatesSupported()])
      .then(([visible, coordinates]) => {
        if (!visible || cancelled || !pos || !size) return;
        // Native Wayland: the backend holds a popout fullscreen on its target
        // screen while it places it, and the resize events of that hold carry
        // the monitor's rect. Saving that would make the next respawn build
        // the popout monitor-sized. The restore resize that ends the hold
        // refreshes `size` and flushes again.
        if (
          !coordinates &&
          sizeFillsScreen(size, window.devicePixelRatio, {
            w: window.screen?.width ?? 0,
            h: window.screen?.height ?? 0,
          })
        ) {
          return;
        }
        emitBounds({ x: pos.x, y: pos.y, w: size.w, h: size.h });
      })
      .catch(() => {});
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  };
  const unMoved = subscribeTauri(() =>
    win.onMoved(({ payload }) => {
      pos = { x: payload.x, y: payload.y };
      schedule();
    }),
  );
  const unResized = subscribeTauri(() =>
    win.onResized(({ payload }) => {
      size = { w: payload.width, h: payload.height };
      schedule();
    }),
  );
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
    unMoved();
    unResized();
  };
}
