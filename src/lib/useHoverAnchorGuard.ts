import { useEffect, useRef } from "react";

/**
 * Closes a hover card whose anchor stopped being under the pointer without a
 * `mouseleave` saying so. A card portaled to `body` only hears its anchor's own
 * leave, and that never comes when the anchor goes out from under a pointer:
 * the fullscreen header sliding away (`visibility: hidden`, `pointer-events:
 * none`), steering moving off the header, the pointer leaving the window over
 * another one. The card then hung on screen until the same anchor was hovered
 * and left again.
 *
 * While `anchor` is set, the next pointer move whose target is outside it, the
 * pointer leaving the document, or the window losing focus calls `onLost`.
 * Pass `null` while no card is open; nothing is listened to then.
 */
export function useHoverAnchorGuard(anchor: HTMLElement | null, onLost: () => void): void {
  const lost = useRef(onLost);
  useEffect(() => {
    lost.current = onLost;
  });
  useEffect(() => {
    if (!anchor) return;
    const drop = () => lost.current();
    const onMove = (e: PointerEvent) => {
      const target = e.target;
      if (!anchor.isConnected || !(target instanceof Node) || !anchor.contains(target)) drop();
    };
    const root = document.documentElement;
    document.addEventListener("pointermove", onMove, { capture: true, passive: true });
    root.addEventListener("mouseleave", drop);
    window.addEventListener("blur", drop);
    return () => {
      document.removeEventListener("pointermove", onMove, { capture: true });
      root.removeEventListener("mouseleave", drop);
      window.removeEventListener("blur", drop);
    };
  }, [anchor]);
}
