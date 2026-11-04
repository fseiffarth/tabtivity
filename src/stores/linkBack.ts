import { create } from "zustand";

/**
 * Where a file tab opened from an agent's file link goes back to: the agent
 * tab whose text held the link (`lib/terminal/pathLinks`' `openPathLink`).
 * `LinkBackButton` draws "← Back" on the file tab while that agent tab is
 * still open; pressing it shows the agent again and, when `close` is set,
 * closes the file tab.
 *
 * `close` is true for a tab the link opened itself; a file tab that was
 * already open before the click is only left, never closed by Back.
 *
 * Window-local and session-only: keyed by scope + tab key, which a restart
 * re-mints anyway, and dropped when Back is used or either tab is gone.
 */
export interface LinkBack {
  /** The agent tab's key, in the same scope as the file tab. */
  from: string;
  /** Back closes the file tab (it was opened by the link). */
  close: boolean;
}

interface LinkBackState {
  byTab: Record<string, LinkBack>;
  set: (scope: string, tabKey: string, back: LinkBack) => void;
  clear: (scope: string, tabKey: string) => void;
}

export const linkBackKey = (scope: string, tabKey: string) => `${scope}\u0000${tabKey}`;

export const useLinkBackStore = create<LinkBackState>((set) => ({
  byTab: {},
  set: (scope, tabKey, back) =>
    set((s) => ({ byTab: { ...s.byTab, [linkBackKey(scope, tabKey)]: back } })),
  clear: (scope, tabKey) =>
    set((s) => {
      const key = linkBackKey(scope, tabKey);
      if (!(key in s.byTab)) return {};
      const byTab = { ...s.byTab };
      delete byTab[key];
      return { byTab };
    }),
}));
