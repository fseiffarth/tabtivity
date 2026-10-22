/**
 * Suppresses WebKit's own right-click menu (Back / Forward / Stop / Reload).
 *
 * The app is not a web page: those entries navigate the webview away from the
 * UI, and the app draws its own context menus (`ContextMenuPortal`) where a
 * right-click means something. A `contextmenu` event that reaches the window
 * uncancelled was handled by nothing, so WebKit would show its default menu;
 * the guard cancels it. It listens in the bubble phase, so a component that
 * already cancelled the event (and opened its own menu) is untouched, and it
 * leaves editable targets (an input, a textarea, CodeMirror) alone — their
 * native Cut/Copy/Paste menu is the one useful default.
 *
 * Installed once per window from `bootstrap.tsx`: every window has its own
 * document and its own default menu.
 */

const EDITABLE = "input, textarea, [contenteditable]:not([contenteditable='false'])";

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(EDITABLE) !== null;
}

function cancelNativeMenu(e: Event): void {
  if (e.defaultPrevented || isEditableTarget(e.target)) return;
  e.preventDefault();
}

let installed = false;

export function installNativeContextMenuGuard(win: Window = window): () => void {
  if (installed) return () => undefined;
  installed = true;
  win.addEventListener("contextmenu", cancelNativeMenu);
  return () => {
    win.removeEventListener("contextmenu", cancelNativeMenu);
    installed = false;
  };
}
