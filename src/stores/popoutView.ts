import { create } from "zustand";
import { allGroups, findGroup } from "./tabs/layoutTree";
import type { LayoutNode, TabEntry } from "./tabs/types";

/** What the main window tells a popout's steering bar (`STEERING_STATUS`). */
export interface PopoutSteeringStatus {
  decision: number;
  working: number;
  done: number;
  back: boolean;
}

export const NO_STEERING_STATUS: PopoutSteeringStatus = { decision: 0, working: 0, done: 0, back: false };

/**
 * What a popout window shows, in the popout's own heap: its scope, its record
 * id and window label, the streamed layout tree and tab payloads, and which of
 * its subwindows is focused.
 *
 * A popout's `useTabsStore` holds no tabs and no layout on purpose (the main
 * window owns both and streams them in the seed). This store is the popout's
 * read side for everything that walks "the tabs on screen" — keyboard steering
 * (`steeringScope`), the new-tab chords, the focus frame — so none of them has
 * to mirror a layout into the tabs store. Written by `DetachedApp` (seed,
 * label) and `DetachedCenterPanel` (tree, tabs, focus); in the main window it
 * stays empty.
 *
 * Deliberately free of `stores/tabs` at runtime: that store routes its popout
 * writes here (`focusGroupInScope`), so importing it back would be a cycle.
 */
interface PopoutViewState {
  scope: string | null;
  /** The popout's record id in the main store (`DetachedParam.groupId`). */
  popoutId: string | null;
  /** The popout's Tauri window label. */
  label: string | null;
  tree: LayoutNode | null;
  tabs: TabEntry[];
  focusedGroupId: string | null;
  /** The main window's status counts and whether Back has a tab to go to
   *  (`STEERING_STATUS`): a popout cannot count them from its own heap, and
   *  its steering bar shows them as the main window's does. */
  status: PopoutSteeringStatus;
  setStatus: (status: PopoutSteeringStatus) => void;
  /** Adopt a seed (or an optimistic edit): the focused subwindow is kept while
   *  it is still in the tree, else the first one. */
  setView: (view: Partial<Pick<PopoutViewState, "scope" | "popoutId" | "label" | "tree" | "tabs">>) => void;
  /** Focus one of the popout's subwindows; an id not in the tree is ignored. */
  focusGroup: (groupId: string) => void;
  reset: () => void;
}

const EMPTY = {
  scope: null,
  popoutId: null,
  label: null,
  tree: null,
  tabs: [] as TabEntry[],
  focusedGroupId: null,
  status: NO_STEERING_STATUS,
};

/** The focus a tree keeps: `current` while it is one of its groups, else the
 *  first group (null for no tree). */
function keptFocus(tree: LayoutNode | null, current: string | null): string | null {
  if (current && findGroup(tree, current)) return current;
  return allGroups(tree)[0]?.id ?? null;
}

export const usePopoutViewStore = create<PopoutViewState>((set) => ({
  ...EMPTY,
  setView: (view) =>
    set((s) => {
      const changed = (Object.keys(view) as Array<keyof typeof view>).some((k) => view[k] !== s[k]);
      if (!changed) return {};
      const tree = view.tree !== undefined ? view.tree : s.tree;
      return { ...view, focusedGroupId: keptFocus(tree, s.focusedGroupId) };
    }),
  focusGroup: (groupId) =>
    set((s) => (s.focusedGroupId === groupId || !findGroup(s.tree, groupId) ? {} : { focusedGroupId: groupId })),
  setStatus: (status) =>
    set((s) =>
      s.status.decision === status.decision &&
      s.status.working === status.working &&
      s.status.done === status.done &&
      s.status.back === status.back
        ? {}
        : { status },
    ),
  reset: () => set({ ...EMPTY }),
}));

/** The popout's focused subwindow (its first when none is focused). */
export function popoutFocusedGroup(state = usePopoutViewStore.getState()) {
  const { tree, focusedGroupId } = state;
  return (focusedGroupId ? findGroup(tree, focusedGroupId) : null) ?? allGroups(tree)[0] ?? null;
}

/** The active tab of the popout's focused subwindow. */
export function popoutActiveTab(state = usePopoutViewStore.getState()): TabEntry | null {
  const key = popoutFocusedGroup(state)?.activeKey;
  return key ? (state.tabs.find((t) => t.key === key) ?? null) : null;
}

/** The payload of one of the popout's tabs, when `scope` is the popout's. */
export function popoutTab(scope: string, key: string): TabEntry | null {
  const s = usePopoutViewStore.getState();
  if (s.scope !== scope) return null;
  return s.tabs.find((t) => t.key === key) ?? null;
}
