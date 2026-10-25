import { useCallback, useEffect, useRef } from "react";
import { bindDragRelease } from "../../lib/window/dragPlatform";

/** What a split-divider drag does; the plumbing around it is `useDividerDrag`'s. */
export interface DividerDragHandlers {
  /** Every pointer move of the gesture. */
  onMove: (ev: PointerEvent) => void;
  /** The gesture ended in a release that commits (after teardown). */
  onCommit?: () => void;
  /** The gesture was aborted (Escape, a genuine capture loss) (after teardown). */
  onAbort?: () => void;
  /** Runs inside teardown — also when the host unmounts mid-gesture. */
  onTeardown?: () => void;
}

/**
 * The shared half of a split-divider drag, used by `CenterPanel`'s `SplitView`
 * and the popout's `DetachedCenterPanel`: capture the pointer, follow it on
 * `window`, end the gesture through `bindDragRelease` (the engine-correct
 * release policy — on WebKitGTK a `pointercancel` often arrives INSTEAD of
 * `pointerup`, and a bare `pointerup` listener left the divider glued to the
 * cursor there), and unbind everything if the host unmounts mid-gesture.
 *
 * What a move does with the pointer position differs (the main window sizes the
 * DOM and commits once on release; the popout streams each move to the main
 * window), so that stays with the caller's handlers.
 */
export function useDividerDrag(): (e: React.PointerEvent, handlers: DividerDragHandlers) => void {
  // A mid-flight drag's teardown, so unmounting mid-gesture unbinds the window
  // listeners instead of leaking them.
  const activeTeardown = useRef<(() => void) | null>(null);
  useEffect(() => () => activeTeardown.current?.(), []);

  return useCallback((e, { onMove, onCommit, onAbort, onTeardown }) => {
    const captureEl = e.target as HTMLElement;
    const pointerId = e.pointerId;
    captureEl.setPointerCapture?.(pointerId);
    const teardown = () => {
      activeTeardown.current = null;
      unbindRelease();
      window.removeEventListener("pointermove", onMove);
      captureEl.releasePointerCapture?.(pointerId);
      onTeardown?.();
    };
    const unbindRelease = bindDragRelease({
      onCommit: () => {
        teardown();
        onCommit?.();
      },
      onAbort: () => {
        teardown();
        onAbort?.();
      },
    });
    window.addEventListener("pointermove", onMove);
    activeTeardown.current = teardown;
  }, []);
}
