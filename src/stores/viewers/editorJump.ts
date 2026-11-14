import { create } from "zustand";
import { broadcast, listenOtherWindows } from "../../lib/window/crossWindow";

/**
 * Cross-tab "jump to this source line" channel for SyncTeX reverse search.
 *
 * Clicking a point in a PDF resolves (through SyncTeX) to a source file +
 * line. The source tab may already be open — `openLinkedFile` re-activates it
 * rather than mounting a fresh component — so we cannot pass the target line as
 * a prop. Instead the PDF side posts a request here keyed by the absolute source
 * path, and the editor (`TexView`/`TextView`) for that path consumes it: a
 * `nonce` makes a repeat jump to the same line still fire.
 *
 * #42 cross-window: the PDF may be popped out into a detached OS window, which is
 * a SEPARATE webview with its own Zustand heap, so a local store write would never
 * reach the editor when it lives in another window. Mirroring the forward-search
 * channel (`pdfSync`), `requestJump` also broadcasts (`lib/window/crossWindow`);
 * every window registers `listenEditorJump` and applies an incoming jump to its
 * own store, so the editor scrolls regardless of which window hosts it.
 */
export interface JumpRequest {
  line: number;
  /** 1-based source column (0: the line's start — SyncTeX records none; error
   *  rows, `\ref` jumps and code links name one). */
  column: number;
  nonce: number;
}

/** Tauri event carrying an editor jump across the main/detached window boundary. */
export const EDITOR_JUMP_EVENT = "editor-jump";

interface EditorJumpStore {
  requestsByPath: Record<string, JumpRequest>;
  /** Ask the editor showing `path` to move the caret to (1-based) `line`/
   *  `column`. `column` 0 means "line start".
   *  Applies locally AND broadcasts so an editor hosted in another (detached)
   *  window scrolls too (#42). */
  requestJump: (path: string, line: number, column?: number) => void;
  /** Record a jump in THIS window's store (the local half of requestJump, and
   *  what `listenEditorJump` calls for a jump broadcast from another window). */
  applyJump: (path: string, line: number, column?: number) => void;
  /** Clear the pending request for `path` once the editor has applied it. */
  consume: (path: string) => void;
}

export const useEditorJumpStore = create<EditorJumpStore>((set, get) => ({
  requestsByPath: {},
  applyJump: (path, line, column = 0) =>
    set((s) => {
      const prev = s.requestsByPath[path];
      return {
        requestsByPath: {
          ...s.requestsByPath,
          [path]: { line, column, nonce: (prev?.nonce ?? 0) + 1 },
        },
      };
    }),
  requestJump: (path, line, column = 0) => {
    get().applyJump(path, line, column);
    // In case the editor is popped out into another window (#42).
    broadcast(EDITOR_JUMP_EVENT, { path, line, column });
  },
  consume: (path) =>
    set((s) => {
      if (!(path in s.requestsByPath)) return {};
      const next = { ...s.requestsByPath };
      delete next[path];
      return { requestsByPath: next };
    }),
}));

/**
 * Register THIS window's listener for cross-window jump broadcasts (#42). Every
 * window (main shell + each detached popout) calls this once at startup; an
 * incoming jump that didn't originate here is applied to the local store, so the
 * editor (`TexView`/`TextView`) hosting that path scrolls regardless of which
 * window the PDF the user clicked lives in. Returns an unlisten. No-ops outside
 * a Tauri context.
 */
export function listenEditorJump(): Promise<() => void> {
  return listenOtherWindows<{ path: string; line: number; column: number }>(
    EDITOR_JUMP_EVENT,
    ({ path, line, column }) => useEditorJumpStore.getState().applyJump(path, line, column),
  );
}

/**
 * Registry of source paths that currently have a live editor (`TexView`/
 * `TextView`) mounted in THIS window. Reverse search consults it to decide
 * whether this window can scroll the source itself — crucial for a detached
 * window, whose React-rendered tabs never populate `useTabsStore`, so a
 * tab-store probe there would wrongly report "not open" and delegate the jump to
 * the main window (where the editor isn't). Ref-counted to tolerate the same
 * path being open in two panes of one window.
 */
const mountedEditors = new Map<string, number>();

/** Mark `path` as having a mounted editor in this window (call on mount). */
export function registerEditor(path: string): void {
  mountedEditors.set(path, (mountedEditors.get(path) ?? 0) + 1);
}

/** Drop a mounted-editor registration for `path` (call on unmount). */
export function unregisterEditor(path: string): void {
  const n = mountedEditors.get(path);
  if (n === undefined) return;
  if (n <= 1) mountedEditors.delete(path);
  else mountedEditors.set(path, n - 1);
}

/** True when an editor for `path` is mounted in this window. */
export function hasMountedEditor(path: string): boolean {
  return mountedEditors.has(path);
}
