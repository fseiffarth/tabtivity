import { useEffect } from "react";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { subscribeTauri } from "../hooks/useTauriListener";
import { usePaneVisible } from "../lib/files/fileAccess";
import { ASSISTANT_SCOPE } from "../lib/assistant";
import { isDetachedWindow } from "./detachedContext";
import { popoutTab } from "./popoutView";
import { tabCloseGuard } from "../lib/tabs/tabCloseGuard";
import { mintedLocalSessionOf, persistentSessionOf } from "../lib/remote/closeRemoteTab";
import { restoreSavedTab } from "./tabs/tabEntries";
import {
  isRestorableTab,
  toSavedTabEntry,
  useTabsStore,
  type SavedTabEntry,
  type TabEntry,
} from "./tabs";

/**
 * The per-scope tab archive: tabs the user put away on purpose — an agent
 * conversation, a shell, a viewer — kept beside the saved layout
 * (`services::tab_archive`, `<state_dir>/sessions/<id>/archived_tabs.json`)
 * and listed only where asked for: the + menu's Archived tabs, the side
 * panel's Archive section, the phone's project view.
 *
 * Archiving ends the tab: its pane unmounts, and the tmux session it minted
 * (local or on a host) is ended with it — nothing runs while it is archived.
 * A restore builds it the way a restart does (`restoreSavedTab`): a resumable
 * agent on its resume args, a shell fresh in its folder, a viewer on its file.
 * Only tabs a restart would bring back can be archived (`canArchiveTab`).
 *
 * Unlike "Recently closed" (`stores/agents/closedAgentTabs`, memory-only, ten
 * per scope, fed by every close), the archive is explicit, persisted, and
 * holds up to 500 per scope. A list is fetched only while a visible surface
 * watches its scope; every `tab-archive:changed` refetches the watched ones.
 */
export interface ArchivedTab {
  /** Opaque, minted by the backend. Never the tab's session id. */
  id: string;
  archivedAt: number;
  tab: SavedTabEntry;
}

export const TAB_ARCHIVE_CHANGED = "tab-archive:changed";

interface TabArchiveState {
  byScope: Record<string, ArchivedTab[]>;
  refresh: (scope: string) => Promise<void>;
  /** Keep `scope` current until the returned release. */
  watch: (scope: string) => () => void;
}

const watchers = new Map<string, number>();
let stop: (() => void) | null = null;
/** Bumped per refresh of a scope, so a slow answer never overwrites a newer one. */
const generation = new Map<string, number>();

export const useTabArchiveStore = create<TabArchiveState>((set, get) => ({
  byScope: {},
  refresh: async (scope) => {
    const run = (generation.get(scope) ?? 0) + 1;
    generation.set(scope, run);
    let entries: ArchivedTab[];
    try {
      entries = await invoke<ArchivedTab[]>("tab_archive_list", { projectId: scope });
    } catch (e) {
      console.warn("tab archive: list failed", e);
      return;
    }
    if (generation.get(scope) !== run) return;
    set((s) => ({ byScope: { ...s.byScope, [scope]: Array.isArray(entries) ? entries : [] } }));
  },
  watch: (scope) => {
    watchers.set(scope, (watchers.get(scope) ?? 0) + 1);
    if (!stop) {
      stop = subscribeTauri(() =>
        listen<{ scope?: string }>(TAB_ARCHIVE_CHANGED, (event) => {
          const changed = event.payload?.scope;
          for (const watched of watchers.keys()) {
            if (!changed || changed === watched) void get().refresh(watched);
          }
        }),
      );
    }
    void get().refresh(scope);
    return () => {
      const left = (watchers.get(scope) ?? 1) - 1;
      if (left > 0) watchers.set(scope, left);
      else watchers.delete(scope);
      if (watchers.size === 0) {
        stop?.();
        stop = null;
      }
    };
  },
}));

const NONE: readonly ArchivedTab[] = [];

/** `scope`'s archived tabs, newest first, kept current while the surrounding
 *  pane is visible and `enabled` holds; `[]` until the first answer. */
export function useTabArchive(scope: string | undefined, enabled = true): readonly ArchivedTab[] {
  const visible = usePaneVisible();
  const active = !!scope && enabled && visible && scope !== ASSISTANT_SCOPE;
  useEffect(() => {
    if (!active || !scope) return;
    return useTabArchiveStore.getState().watch(scope);
  }, [active, scope]);
  return useTabArchiveStore((s) => (scope ? s.byScope[scope] : undefined)) ?? NONE;
}

/** Whether `tab` of `scope` can be archived: one a restart would bring back,
 *  never the root console's unfenced Host session, a sign-in or cloud tab, or
 *  a chat of the assistant's scope. */
export function canArchiveTab(scope: string, tab: TabEntry): boolean {
  if (scope === ASSISTANT_SCOPE || tab.hostSession || tab.signIn || tab.cloud || tab.login) return false;
  return isRestorableTab(tab);
}

/** The persisted shape an archived tab is kept as: the layout's
 *  (`toSavedTabEntry`), minus what names this run only. The tmux name goes
 *  because archiving ends that session (the kill is asynchronous, and a
 *  restore must not attach to a dying one); the shared-set id goes because
 *  the workspace remembers it as closed. An attach tab keeps the session it
 *  looks at — that one is not the tab's to end. */
export function archiveSnapshot(tab: TabEntry): SavedTabEntry {
  const {
    id: _id,
    mobileRequestHash: _hash,
    tmuxSession: _tmux,
    ...saved
  } = toSavedTabEntry(tab);
  return saved as SavedTabEntry;
}

function tabOf(scope: string, key: string): TabEntry | null {
  if (isDetachedWindow()) return popoutTab(scope, key);
  return (useTabsStore.getState().tabsByScope[scope] ?? []).find((t) => t.key === key) ?? null;
}

/** End what the tab ran: the pane goes with the layout, the tmux session it
 *  minted (local or on its host) is killed. An attach tab's session is left
 *  alone — it was there before the tab. */
function endTab(scope: string, tab: TabEntry): void {
  const local = mintedLocalSessionOf(scope, tab);
  const remote = tab.tmuxAttach ? null : persistentSessionOf(scope, tab);
  useTabsStore.getState().removeTabInScope(scope, tab.key);
  if (local) void invoke<void>("local_tmux_kill", { session: local }).catch(() => {});
  if (remote) {
    void invoke<void>("remote_tmux_kill", { projectId: scope, hostId: remote.hostId, session: remote.session }).catch(() => {});
  }
}

/**
 * Archive `keys` of `scope`, one at a time: a tab with unsaved work asks
 * first (Save / Discard / Cancel, as a close does) and a Cancel stops the
 * rest. Each tab is written to the archive before it ends, so a failed write
 * leaves it open. Tabs that cannot be archived are skipped. Resolves how many
 * were archived.
 */
export async function archiveTabs(scope: string, keys: readonly string[]): Promise<number> {
  let archived = 0;
  for (const key of keys) {
    const tab = tabOf(scope, key);
    if (!tab || !canArchiveTab(scope, tab)) continue;
    const guard = tabCloseGuard(scope, key);
    if (guard?.wouldLose() && !(await guard.confirm())) return archived;
    try {
      await invoke("tab_archive_add", { projectId: scope, tabs: [archiveSnapshot(tab)] });
    } catch (e) {
      console.warn("tab archive: add failed", e);
      return archived;
    }
    // Asked again: a dialog may have taken a while, and the tab may be gone.
    const still = tabOf(scope, key);
    if (still) endTab(scope, still);
    archived += 1;
  }
  return archived;
}

/** The tab of `scope` that already runs the conversation `saved` names, if any:
 *  two tabs resuming one session fight over it. */
function openTwin(scope: string, saved: SavedTabEntry): TabEntry | null {
  if (!saved.sessionId) return null;
  const open = useTabsStore.getState().tabsByScope[scope] ?? [];
  return open.find((t) => t.sessionId === saved.sessionId && t.cmd === saved.cmd) ?? null;
}

/**
 * Bring archived tab `id` of `scope` back as a new tab in the scope's focused
 * subwindow, made active. `null` when the entry is gone (restored or deleted
 * elsewhere). A conversation already open again in another tab is not opened
 * twice: that tab is activated and the entry is dropped.
 */
export async function restoreArchivedTab(scope: string, id: string): Promise<TabEntry | null> {
  const taken = await invoke<ArchivedTab | null>("tab_archive_take", { projectId: scope, id });
  if (!taken) return null;
  const twin = openTwin(scope, taken.tab);
  const tabs = useTabsStore.getState();
  if (twin) {
    if (tabs.scope === scope) tabs.setActive(twin.key);
    return twin;
  }
  const restored = restoreSavedTab(taken.tab, { defaultCwd: taken.tab.cwd, scope, agentRoots: [] });
  const { key: _key, id: _sharedId, ...spec } = restored;
  return tabs.addTabToScope(scope, spec);
}

/** Drop archived tabs of `scope` for good. */
export async function deleteArchivedTabs(scope: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await invoke("tab_archive_delete", { projectId: scope, ids });
}
