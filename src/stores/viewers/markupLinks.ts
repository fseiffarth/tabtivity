/**
 * Which PDF an agent tab is working on marks from: the desktop markup's way
 * back from the agent tab to the viewer that sent the round.
 *
 * A `PdfViewer` in Mark up registers its tab while a round it sent to the
 * target agent tab is on (`usePdfMarkupLink`); the agent pane's prompt strip
 * reads it by PTY id and offers a jump back (`TerminalPromptStrip`). The way
 * there is the markup strip's own target (`usePdfMarkup` `showTarget`). Memory
 * only: a link ends with the round, the markup mode or the viewer.
 */

import { useEffect } from "react";
import { create } from "zustand";

export type MarkupLink = {
  /** The viewer's tab, for `setActive` (which finds its scope). */
  tabKey: string;
  /** The PDF's file name, for the button. */
  name: string;
  /** Which viewer registered it: only that one may take it back. */
  owner: string;
};

interface MarkupLinksState {
  byPty: Record<string, MarkupLink>;
  set: (ptyId: string, link: MarkupLink) => void;
  clear: (ptyId: string, owner: string) => void;
}

export const useMarkupLinksStore = create<MarkupLinksState>((set) => ({
  byPty: {},
  set: (ptyId, link) => set((s) => ({ byPty: { ...s.byPty, [ptyId]: link } })),
  clear: (ptyId, owner) =>
    set((s) => {
      if (s.byPty[ptyId]?.owner !== owner) return {};
      const byPty = { ...s.byPty };
      delete byPty[ptyId];
      return { byPty };
    }),
}));

/** Holds `link` for `ptyId` while both are given; the newest viewer to send
 *  a round to a tab wins it. */
export function usePdfMarkupLink(ptyId: string | null, link: MarkupLink | null): void {
  const tabKey = link?.tabKey;
  const name = link?.name;
  const owner = link?.owner;
  useEffect(() => {
    if (!ptyId || tabKey === undefined || name === undefined || owner === undefined) return;
    useMarkupLinksStore.getState().set(ptyId, { tabKey, name, owner });
    return () => useMarkupLinksStore.getState().clear(ptyId, owner);
  }, [ptyId, tabKey, name, owner]);
}
