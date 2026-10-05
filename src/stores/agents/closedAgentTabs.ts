import { create } from "zustand";
import { reseedDetached } from "../detached";
import {
  RESUMABLE_AGENTS,
  allGroups,
  findGroup,
  findGroupOfTab,
  isRelaunchableLocalTab,
  isResumableAgentTab,
  useTabsStore,
  type TabEntry,
} from "../tabs";

/**
 * "Reopen closed tab" for agent tabs, on the desktop and — through the mobile
 * bridge — on the phone.
 *
 * Closing an agent tab ends its process, but the conversation stays on disk,
 * and bringing it back is what a restart of Tabtivity already does for a tab:
 * respawn it on its resume args (`RESUMABLE_AGENTS`, a custom agent's
 * `resumeArgs`, a local-model tab's launch line). So a close through the one
 * user-close seam (`lib/remote/closeRemoteTab`'s `closeTabInScope`, which the
 * desktop's × and the phone's ✕ both go through) keeps a snapshot of the tab
 * here, and a reopen adds a tab built from it the way `loadFromLayout` builds a
 * restored one. A popout's closes reach this window as a `close` edit or a
 * whole-window close marked `user` (`stores/detached`), and land here through
 * `noteClosedPopoutTabs`; such a tab reopens in its popout while that is open.
 *
 * Only tabs a restart would bring back are kept: an agent without a resume
 * path would come back as a fresh conversation in a tab that looks restored.
 * The root console's Host session is never kept — it runs unfenced, and is
 * only ever started from its own menu entry, never from the phone.
 *
 * Memory only, per scope, newest first: a restart has already dropped every
 * closed tab's pane, and the closed list is not state worth persisting.
 */
export interface ClosedAgentTab {
  /** Opaque, minted at close. What the phone names an entry by — never the
   *  session id, which stays on this desktop. */
  id: string;
  tab: TabEntry;
  closedAt: number;
  /** The close ended the local tmux session the tab minted, so a reopen must
   *  not reuse that name (the kill is asynchronous). A session left running —
   *  one on a remote host — keeps its name and is reattached instead. */
  sessionEnded: boolean;
  /** Where the tab sat, so a reopen puts it back there while that subwindow
   *  still exists: `groupId` is its pane, inside the popout `detachedGroupId`
   *  when it was closed in one. */
  groupId?: string;
  index?: number;
  detachedGroupId?: string;
}

/** How many closed tabs a scope remembers. */
export const MAX_CLOSED_AGENT_TABS = 10;

interface ClosedAgentTabsStore {
  byScope: Record<string, ClosedAgentTab[]>;
  note: (scope: string, entry: ClosedAgentTab) => void;
  /** Remove and return one entry — the newest when `id` is omitted. */
  take: (scope: string, id?: string) => ClosedAgentTab | null;
}

export const useClosedAgentTabsStore = create<ClosedAgentTabsStore>((set, get) => ({
  byScope: {},
  note: (scope, entry) =>
    set((state) => ({
      byScope: {
        ...state.byScope,
        [scope]: [entry, ...(state.byScope[scope] ?? [])].slice(0, MAX_CLOSED_AGENT_TABS),
      },
    })),
  take: (scope, id) => {
    const list = get().byScope[scope] ?? [];
    const at = id === undefined ? (list.length ? 0 : -1) : list.findIndex((entry) => entry.id === id);
    if (at < 0) return null;
    const entry = list[at];
    set((state) => ({
      byScope: { ...state.byScope, [scope]: list.filter((_, i) => i !== at) },
    }));
    return entry;
  },
}));

const EMPTY: ClosedAgentTab[] = [];

/** The scope's closed agent tabs, newest first (a stable empty list when none). */
export function useClosedAgentTabs(scope: string): ClosedAgentTab[] {
  return useClosedAgentTabsStore((state) => state.byScope[scope] ?? EMPTY);
}

/** Whether closing this tab should keep it for a reopen. */
export function canReopenAfterClose(tab: TabEntry): boolean {
  if (tab.hostSession) return false;
  return isResumableAgentTab(tab) || isRelaunchableLocalTab(tab);
}

/** Where a tab sits: its pane and place in the scope's layout, or in one of
 *  the scope's popouts. */
function placeOf(scope: string, key: string): Pick<ClosedAgentTab, "groupId" | "index" | "detachedGroupId"> {
  const state = useTabsStore.getState();
  const layout = state.layoutByScope[scope] ?? null;
  const at = layout ? findGroupOfTab(layout, key) : null;
  if (at) return { groupId: at.group.id, index: at.index };
  for (const popout of state.detachedGroupsByScope[scope] ?? []) {
    const inPopout = findGroupOfTab(popout.subtree, key);
    if (inPopout) return { groupId: inPopout.group.id, index: inPopout.index, detachedGroupId: popout.id };
  }
  return {};
}

/** Remember a tab the user is closing (called before it leaves the layout). */
export function noteClosedAgentTab(scope: string, tab: TabEntry, sessionEnded: boolean): void {
  if (!canReopenAfterClose(tab)) return;
  useClosedAgentTabsStore.getState().note(scope, {
    id: crypto.randomUUID(),
    tab,
    closedAt: Date.now(),
    sessionEnded,
    ...placeOf(scope, tab.key),
  });
}

/**
 * Remember tabs the user closed in popout `detachedGroupId` — one tab's ×, or
 * the whole window's (called before the main window drops them). A popout's
 * close ends no tmux session (`closeDetachedGroup` kills only the PTY client),
 * so a reopen keeps the tab's session name: a session still running is
 * reattached, a gone one respawns on the resume args.
 */
export function noteClosedPopoutTabs(scope: string, detachedGroupId: string, keys: string[]): void {
  const state = useTabsStore.getState();
  const popout = state.detachedGroupsByScope[scope]?.find((d) => d.id === detachedGroupId);
  if (!popout) return;
  const tabs = state.tabsByScope[scope] ?? [];
  for (const key of keys) {
    if (!findGroupOfTab(popout.subtree, key)) continue;
    const tab = tabs.find((t) => t.key === key);
    if (tab) noteClosedAgentTab(scope, tab, false);
  }
}

/** The args a restore would respawn this tab with (see `loadFromLayout`). */
function resumeArgsOf(tab: TabEntry): string[] {
  if (isResumableAgentTab(tab) && tab.sessionId) {
    return tab.cmd in RESUMABLE_AGENTS ? RESUMABLE_AGENTS[tab.cmd](tab.sessionId) : [...(tab.resumeArgs ?? [])];
  }
  return tab.localLaunch ? [...tab.localLaunch.args] : [];
}

/** The new tab a closed one comes back as: the same conversation binding
 *  (session id, schedule target, env, locality, colour), with its own key and
 *  none of what only described the closed tab's run — its first prompt above
 *  all, which a reopen must not type again. */
export function reopenSpec(closed: ClosedAgentTab): Omit<TabEntry, "key"> {
  const {
    key: _key,
    scope: _scope,
    launchedAt: _launchedAt,
    relaunchSeq: _relaunchSeq,
    hostSessionPaused: _paused,
    initialInput: _initialInput,
    mobileRequestHash: _requestHash,
    runFile: _runFile,
    mdGraphOriginKey: _origin,
    tmuxSession,
    ...rest
  } = closed.tab;
  return {
    ...rest,
    args: resumeArgsOf(closed.tab),
    ...(closed.sessionEnded || !tmuxSession ? {} : { tmuxSession }),
  };
}

/**
 * Reopen a closed agent tab of `scope` — the newest, or the one `id` names —
 * back where it sat (or into popout `into`, when a popout asked), and make it the active tab of its subwindow. `null` when
 * there is nothing to reopen. An entry whose conversation is already open again
 * in another tab is skipped: two tabs resuming one session fight over it.
 */
export function reopenClosedAgentTab(scope: string, id?: string, into?: string): TabEntry | null {
  const store = useClosedAgentTabsStore.getState();
  for (;;) {
    // Asked from popout `into` (its own Ctrl+Shift+T): the newest tab closed
    // there first, and whichever tab it is lands in that window.
    const pick = id ?? (into
      ? useClosedAgentTabsStore.getState().byScope[scope]?.find((entry) => entry.detachedGroupId === into)?.id
      : undefined);
    const taken = store.take(scope, pick);
    if (!taken) return null;
    const closed = into && taken.detachedGroupId !== into
      ? { ...taken, detachedGroupId: into, groupId: undefined, index: undefined }
      : taken;
    const open = useTabsStore.getState().tabsByScope[scope] ?? [];
    if (
      closed.tab.sessionId &&
      open.some((tab) => tab.sessionId === closed.tab.sessionId && tab.cmd === closed.tab.cmd)
    ) {
      if (id !== undefined) return null;
      continue;
    }
    const inPopout = reopenInPopout(scope, closed);
    if (inPopout) return inPopout;
    const tabs = useTabsStore.getState();
    const entry = tabs.addTabToScope(scope, reopenSpec(closed));
    const layout = useTabsStore.getState().layoutByScope[scope] ?? null;
    if (!closed.detachedGroupId && closed.groupId && layout && findGroup(layout, closed.groupId)) {
      tabs.moveTabInScope(scope, entry.key, closed.groupId, closed.index);
    }
    return entry;
  }
}

/** Put a tab closed in a popout back into that popout — its pane and place
 *  there, when the pane is still there — and re-seed the window so it renders
 *  it. `null` when the popout has since closed (the caller then reopens it in
 *  the main layout). */
function reopenInPopout(scope: string, closed: ClosedAgentTab): TabEntry | null {
  const popoutId = closed.detachedGroupId;
  if (!popoutId) return null;
  const tabs = useTabsStore.getState();
  const popout = tabs.detachedGroupsByScope[scope]?.find((d) => d.id === popoutId);
  if (!popout) return null;
  const pane = closed.groupId && findGroup(popout.subtree, closed.groupId) ? closed.groupId : allGroups(popout.subtree)[0]?.id;
  if (!pane) return null;
  const key = tabs.addDetachedTab(scope, popoutId, reopenSpec(closed), pane);
  if (!key) return null;
  const subtree = useTabsStore.getState().detachedGroupsByScope[scope]?.find((d) => d.id === popoutId)?.subtree;
  const at = subtree ? findGroupOfTab(subtree, key) : null;
  if (at && closed.index !== undefined && closed.index < at.index) {
    const tabKeys = at.group.tabKeys.filter((k) => k !== key);
    tabKeys.splice(closed.index, 0, key);
    tabs.applyDetachedEdit(scope, popoutId, { kind: "reorder", tabKeys });
  }
  reseedDetached(scope, popoutId, key);
  return useTabsStore.getState().tabsByScope[scope]?.find((t) => t.key === key) ?? null;
}
