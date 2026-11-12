import { useCallback, useSyncExternalStore } from "react";

/** Whether `query` matches now, kept current as the screen turns or the
 * window is resized (an iPad's Split View, Stage Manager). `false` where
 * the browser has no `matchMedia` (tests, an old webview). */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((changed: () => void) => {
    const list = window.matchMedia?.(query);
    if (!list) return () => {};
    list.addEventListener?.("change", changed);
    return () => list.removeEventListener?.("change", changed);
  }, [query]);
  return useSyncExternalStore(subscribe, () => window.matchMedia?.(query).matches ?? false, () => false);
}
