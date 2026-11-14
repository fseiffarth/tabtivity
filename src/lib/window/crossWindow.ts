import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Window-to-window broadcasts. Every window (the main shell and each detached
 * popout) is a separate webview with its own heap, so a store write in one never
 * reaches another: a channel that must cross applies its change locally, then
 * {@link broadcast}s it, and every window registers {@link listenOtherWindows}
 * to apply what the others sent. The sender's label rides along as `from`, so a
 * window skips the echo of its own broadcast.
 */

/** This window's Tauri label, or `""` outside a Tauri context (tests). */
export function currentWindowLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return "";
  }
}

/** Send `payload` to every window, stamped with this one's label. Best effort:
 *  with no Tauri event bus (tests) nothing is sent. */
export function broadcast(event: string, payload: object): void {
  try {
    emit(event, { ...payload, from: currentWindowLabel() }).catch(() => {});
  } catch {
    /* no Tauri event bus available (synchronous failure) */
  }
}

/** Run `apply` for every `event` another window broadcast. Registered once per
 *  window at startup; resolves to an unlisten, a no-op outside Tauri. */
export async function listenOtherWindows<T>(
  event: string,
  apply: (payload: T) => void,
): Promise<() => void> {
  const self = currentWindowLabel();
  try {
    return await listen<T & { from: string }>(event, (ev) => {
      if (ev.payload.from !== self) apply(ev.payload);
    });
  } catch {
    return () => {};
  }
}
