/**
 * Stops a drop that nothing in the app takes from loading into the window.
 *
 * The window keeps `dragDropEnabled: false` (HTML5 drags must reach the DOM), so
 * an OS file dragged in is WebKit's to handle. A drop zone (the file tree's
 * import) cancels `dragover`/`drop` itself; everywhere else — a terminal, an
 * agent tab, empty space — nothing did, and WebKit's default for an unhandled
 * drop of a file or link is to *navigate the webview to it*. The whole window
 * then became the dropped image, with no way back short of a restart.
 *
 * So the window cancels any drag event that reaches it uncancelled. It listens
 * in the bubble phase and leaves alone what a component already handled, and
 * what lands on an editable target (an input, a textarea, CodeMirror) — WebKit
 * edits there rather than navigating, and text drops into fields keep working.
 * `dropEffect` is deliberately not set to "none": WebKit may treat a refused
 * drag as unhandled by the page and fall back to its own load-the-URL action.
 *
 * Installed once per window from `bootstrap.tsx`: every window — main shell,
 * popout, presenter — has its own document and its own default drop action.
 */

const EDITABLE = "input, textarea, [contenteditable]:not([contenteditable='false'])";

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(EDITABLE) !== null;
}

function cancelStray(e: Event): void {
  if (e.defaultPrevented || isEditableTarget(e.target)) return;
  e.preventDefault();
}

let installed = false;

export function installStrayDropGuard(win: Window = window): () => void {
  if (installed) return () => undefined;
  installed = true;
  const events = ["dragenter", "dragover", "drop"] as const;
  for (const type of events) win.addEventListener(type, cancelStray);
  return () => {
    for (const type of events) win.removeEventListener(type, cancelStray);
    installed = false;
  };
}
