import { createContext } from "react";

/**
 * What closing a tab would throw away, and the question asked before it does.
 *
 * A file viewer holds its unsaved buffer in the pane's own state: closing the
 * tab unmounts the pane, and with autosave off nothing writes the buffer on the
 * way out (`DraftSaver.dispose`). So the user-close seam
 * (`lib/remote/closeRemoteTab`'s `closeTabInScope`) asks first, through the
 * guard the tab's pane registered here (`components/tabs/TabCloseGuard`, which
 * owns the Save / Discard / Cancel dialog), and a pane part registers its
 * unsaved work with that guard through {@link PaneUnsavedContext}.
 *
 * Per heap, like `window/unsavedWork`: a popout's guards are the popout's own
 * panes, and a close made in the window that renders the tab is the one that
 * asks.
 */

/** One pane part's unsaved work, as the close question sees it. */
export interface PaneUnsavedWork {
  /** Closing now would lose it: unsaved, and nothing saves it on unmount. */
  lostOnClose(): boolean;
  /** Save it now, as the user's own Save does. */
  save(): Promise<void>;
  /** What to call it in the question (the file's name). */
  label(): string;
}

/** A tab's guard: whether a close would lose work, and the question. */
export interface TabCloseGuard {
  wouldLose(): boolean;
  /** Ask; true when the tab may close (saved, or the user discarded). */
  confirm(): Promise<boolean>;
}

const guards = new Map<string, TabCloseGuard>();
const guardKey = (scope: string, key: string) => `${scope}\u0000${key}`;

export function registerTabCloseGuard(scope: string, key: string, guard: TabCloseGuard): () => void {
  const id = guardKey(scope, key);
  guards.set(id, guard);
  return () => {
    if (guards.get(id) === guard) guards.delete(id);
  };
}

/** The guard of `scope`'s tab `key`, when its pane is mounted in this heap. */
export function tabCloseGuard(scope: string, key: string): TabCloseGuard | undefined {
  return guards.get(guardKey(scope, key));
}

/** Register a pane part's unsaved work with its tab's guard; `null` outside a
 *  tab (a viewer in a side panel or a dialog closes with its host). */
export const PaneUnsavedContext = createContext<((work: PaneUnsavedWork) => () => void) | null>(null);
