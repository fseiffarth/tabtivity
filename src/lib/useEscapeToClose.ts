import { useEffect, useRef } from "react";

/**
 * Escape closes a floating surface wherever focus is: a hover-opened menu never
 * took focus, so a key handler on the surface would not hear it. A press some
 * other handler already claimed is left alone, and the one taken here is marked
 * handled so it does not also back out of what is behind it. The dialog families
 * have this already, through `useModalFocus`.
 */
export function useEscapeToClose(open: boolean, onClose: () => void): void {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      close.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
}
