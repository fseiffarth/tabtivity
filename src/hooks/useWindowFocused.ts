import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { subscribeTauri } from "./useTauriListener";

/**
 * Whether THIS OS window currently holds focus. Backs the "exactly one active
 * subwindow across all windows" rule (#42 ergonomics): each window keeps its own
 * focused-subwindow value, but only *paints* it as active while it owns OS focus,
 * so a blurred main window and a focused popout never both show a highlight.
 *
 * Defaults to `true` and only updates on a real boolean: the main window then
 * paints its active subwindow immediately on load (before the first event), and
 * in a non-Tauri context (unit tests, where `getCurrentWindow` is inert) the
 * value simply stays `true` — preserving the pre-gate behavior.
 */
export function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(true);
  useEffect(() => {
    let cancelled = false;
    let unlisten = () => {};
    try {
      const win = getCurrentWindow();
      win
        .isFocused()
        .then((f) => {
          if (!cancelled && typeof f === "boolean") setFocused(f);
        })
        .catch(() => {});
      unlisten = subscribeTauri(() =>
        win.onFocusChanged(({ payload }) => {
          if (typeof payload === "boolean") setFocused(payload);
        }),
      );
    } catch {
      // No Tauri window (tests): keep the single-window default.
    }
    return () => {
      cancelled = true;
      unlisten();
    };
  }, []);
  return focused;
}
