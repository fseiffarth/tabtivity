import { create } from "zustand";
import type { DiffNote } from "../../lib/agents/diffNotes";
import { splitPtyId } from "../../lib/terminal/ptyId";
import { useTabsStore } from "../tabs";

/**
 * The notes left on the Reader's Diffs tab, per agent tab (composed PTY id),
 * until they are added to the Chat draft or cleared. Memory only, like the
 * draft they end up in (`lib/agents/readerDrafts`); a tab that is closed takes
 * its notes with it. Switching subagent or chat keeps them: each note names
 * its own file.
 */
interface DiffNotesStore {
  byTab: Record<string, DiffNote[]>;
  add: (ptyId: string, note: DiffNote) => void;
  /** Replace a note's text and/or the lines it is on. */
  update: (ptyId: string, id: string, patch: Partial<Omit<DiffNote, "id">>) => void;
  remove: (ptyId: string, id: string) => void;
  /** Drop these notes (the ones added to the draft). */
  removeMany: (ptyId: string, ids: readonly string[]) => void;
  clear: (ptyId: string) => void;
}

const NONE: DiffNote[] = [];

function put(byTab: Record<string, DiffNote[]>, ptyId: string, list: DiffNote[]): Record<string, DiffNote[]> {
  const next = { ...byTab };
  if (list.length) next[ptyId] = list;
  else delete next[ptyId];
  return next;
}

let sweeping = false;
/** Once the first note exists: drop the notes of a tab that is gone. A scope
 * the window holds no tabs of (a popout's own store) is left alone. */
function sweepWithTabs(): void {
  if (sweeping) return;
  sweeping = true;
  useTabsStore.subscribe((state, prev) => {
    if (state.tabsByScope === prev.tabsByScope) return;
    const { byTab } = useDiffNotesStore.getState();
    const gone = Object.keys(byTab).filter((ptyId) => {
      const parts = splitPtyId(ptyId);
      const tabs = parts ? state.tabsByScope[parts.scope] : undefined;
      return !!parts && !!tabs && !tabs.some((tab) => tab.key === parts.key);
    });
    if (gone.length === 0) return;
    useDiffNotesStore.setState((s) => {
      const next = { ...s.byTab };
      for (const ptyId of gone) delete next[ptyId];
      return { byTab: next };
    });
  });
}

export const useDiffNotesStore = create<DiffNotesStore>((set) => ({
  byTab: {},
  add: (ptyId, note) => {
    sweepWithTabs();
    set((s) => ({ byTab: put(s.byTab, ptyId, [...(s.byTab[ptyId] ?? NONE), note]) }));
  },
  update: (ptyId, id, patch) =>
    set((s) => ({ byTab: put(s.byTab, ptyId, (s.byTab[ptyId] ?? NONE).map((n) => (n.id === id ? { ...n, ...patch } : n))) })),
  remove: (ptyId, id) =>
    set((s) => ({ byTab: put(s.byTab, ptyId, (s.byTab[ptyId] ?? NONE).filter((n) => n.id !== id)) })),
  removeMany: (ptyId, ids) =>
    set((s) => ({ byTab: put(s.byTab, ptyId, (s.byTab[ptyId] ?? NONE).filter((n) => !ids.includes(n.id))) })),
  clear: (ptyId) => set((s) => ({ byTab: put(s.byTab, ptyId, []) })),
}));

/** A tab's notes, oldest first (a stable empty list when it has none). */
export function useDiffNotes(ptyId: string | undefined): DiffNote[] {
  return useDiffNotesStore((s) => (ptyId ? s.byTab[ptyId] : undefined) ?? NONE);
}
