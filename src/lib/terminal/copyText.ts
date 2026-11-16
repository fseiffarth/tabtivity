import { invoke } from "@tauri-apps/api/core";

/** Puts `text` on the system clipboard; resolves once a clipboard took it and
 * rejects when none did.
 *
 * Through the backend first (`copy_text_to_clipboard`): the webview's
 * `navigator.clipboard` writes only while WebKit still counts the press as a
 * user gesture, so a copy made after an `await`, or from output rather than a
 * click, is refused or dropped. The webview stays as the fallback, for a
 * backend without a display and for text past the backend's cap. */
/** The system clipboard's text, empty when it holds none.
 *
 * Through the backend first (`read_clipboard_text`): on Windows the webview's
 * `navigator.clipboard.readText()` is refused (WebView2 grants clipboard reads
 * only to a webview built with clipboard access), so a paste into a pane did
 * nothing. The webview stays as the fallback when the backend has no
 * clipboard or the text is past its cap. */
export function readClipboardText(): Promise<string> {
  return invoke<string>("read_clipboard_text").catch(() => navigator.clipboard?.readText() ?? "");
}

export function copyText(text: string): Promise<void> {
  return invoke("copy_text_to_clipboard", { text })
    .then(() => undefined)
    .catch(() => (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject(new Error("no clipboard"))));
}
