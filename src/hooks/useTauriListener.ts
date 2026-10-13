import { useEffect, type DependencyList } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";

/**
 * Start a Tauri subscription — `listen(...)`, `getCurrentWindow().onResized(...)`
 * and the like, all of which hand back their unlisten function only once a
 * promise settles — and return a disposer that is safe to call at any time.
 *
 * The two mistakes this exists to stop: pushing the unlisten into an array in
 * `.then` with no disposed check (a cleanup that runs before the promise
 * settles finds the array empty, and the listener lives on for the window's
 * lifetime), and a missing `.catch` (a rejected subscription — no Tauri
 * runtime, a closed window — becomes an unhandled rejection). A failed
 * subscription is simply not there; there is nothing to undo.
 */
export function subscribeTauri(subscribe: () => Promise<UnlistenFn>): () => void {
  let disposed = false;
  let unlisten: UnlistenFn | undefined;
  let pending: Promise<UnlistenFn>;
  try {
    pending = subscribe();
  } catch {
    return () => {};
  }
  // `Promise.resolve`: a test double that returns a bare function (or nothing)
  // must not turn into a synchronous TypeError here.
  Promise.resolve(pending)
    .then((fn) => {
      if (disposed) fn?.();
      else unlisten = fn;
    })
    .catch(() => {});
  return () => {
    disposed = true;
    const fn = unlisten;
    unlisten = undefined;
    fn?.();
  };
}

/**
 * `subscribeTauri` for a component's lifetime: subscribes on mount (and again
 * whenever `deps` change), and unsubscribes on unmount — also when the unmount
 * comes before the subscription has settled.
 */
export function useTauriListener(
  subscribe: () => Promise<UnlistenFn>,
  deps: DependencyList,
): void {
  // The caller owns `deps`, exactly as with `useEffect`; `subscribe` is a fresh
  // closure each render and deliberately not one of them.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => subscribeTauri(subscribe), deps);
}
