import { invoke } from "@tauri-apps/api/core";

/** Puts `text` on the system clipboard; resolves once a clipboard took it and
 * rejects when none did.
 *
 * Through the backend first (`copy_text_to_clipboard`): the webview's
 * `navigator.clipboard` writes only while WebKit still counts the press as a
 * user gesture, so a copy made after an `await`, or from output rather than a
 * click, is refused or dropped. The webview stays as the fallback, for a
 * backend without a display and for text past the backend's cap. */
export function copyText(text: string): Promise<void> {
  return invoke("copy_text_to_clipboard", { text })
    .then(() => undefined)
    .catch(() => (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject(new Error("no clipboard"))));
}
