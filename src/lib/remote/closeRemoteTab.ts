/**
 * Close (detach) of a persistent tab (TODO #85), plus the helpers that classify
 * which tmux session a tab owns.
 *
 * A shell/script tab can run inside a **tmux** session — remote (on the SSH host)
 * or local (on this machine) — so the run survives an SSH drop / laptop sleep /
 * Tabtivity crash. What closing the tab does depends on where that session lives:
 * a **remote** session is only detached (the pane unmounts, killing the ssh/PTY
 * client) and stays alive under its host's tmux daemon, reattachable from the
 * Sessions view and ended only by its × there (`remote_tmux_kill`); a **local**
 * session the tab minted is ended with the tab (`local_tmux_kill`), the same as
 * closing the project or quitting Tabtivity does — local sessions exist to survive
 * a crash, not a close.
 *
 * `persistentSessionOf` / `localPersistentSessionOf` classify the tab (used by the
 * Sessions view to mark which rows an open tab owns). They live outside the stores
 * because they read BOTH the tabs and projects stores, and `stores/projects`
 * already imports `stores/tabs` — a store-level import back would be a cycle.
 */

import {
  useTabsStore,
  effectiveTabLocation,
  remoteHostIdOf,
  type TabEntry,
} from "../../stores/tabs";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { invoke } from "@tauri-apps/api/core";
import { isRelaunchableLocalTab, isResumableAgentTab, isSavedWhileLive } from "../../stores/tabs";
import { shouldPersistLocalTab, shouldPersistTab } from "../terminal/tmuxSession";
import { IS_WINDOWS } from "../platform";
import { noteClosedAgentTab } from "../../stores/agents/closedAgentTabs";
import { MOBILE_ACCESS_KEY } from "../brand";

/**
 * The persistent host tmux session a tab owns, or `null` if the tab is not a
 * persistent remote session (a local tab, a non-shell tab, a persistence-off
 * project). An **attach** tab (opened from the Sessions view) owns the named
 * session it attached to; an ordinary persistent shell tab owns its stable minted
 * `tmuxSession`. `hostId` is resolved like `CenterPanel` (a tab naming a removed
 * worker falls back to the primary).
 */
export function persistentSessionOf(
  scope: string,
  tab: TabEntry,
): { session: string; hostId: string } | null {
  if (scope === "root") return null;
  const project = useProjectsStore.getState().projects.find((p) => p.id === scope);
  if (!project?.remote) return null;
  const rawHostId = remoteHostIdOf(
    effectiveTabLocation(tab, { vmProject: !!project.vm?.enabled }),
  );
  if (rawHostId === null) return null; // a local-running tab has no host session
  const hostId =
    rawHostId !== "primary" && !project.compute_hosts?.some((h) => h.id === rawHostId)
      ? "primary"
      : rawHostId;
  // A Sessions-view attach tab owns exactly the (possibly foreign) name it attached to.
  if (tab.tmuxAttach) return { session: tab.tmuxAttach, hostId };
  if (!shouldPersistTab(tab.kind, hostId, project.remote, tab.ephemeral) || !tab.tmuxSession) return null;
  return { session: tab.tmuxSession, hostId };
}

/**
 * The persistent **local** tmux session a tab owns, or `null`. Mirrors
 * `shouldPersistLocalTab` — and must keep mirroring it, or the Sessions view
 * marks the wrong rows as owned: a shell tab running on the local machine (a
 * local project, or a remote project's local/mirror tab, **or the root
 * terminal**) with the `persist_local_sessions` setting on, and never on
 * Windows (no tmux). The root scope resolves no project here and needs none —
 * `localRunning` is what a project would have been consulted for, and a scope
 * with no project is never remote. Box scopes (`box:<id>`) qualify like root:
 * their tabs restore first-class now and run local-only in v1, so a box shell's
 * session is reattachable rather than orphaned.
 */
export function localPersistentSessionOf(scope: string, tab: TabEntry): string | null {
  if (IS_WINDOWS) return null;
  if (tab.kind !== "shell" || !tab.tmuxSession) return null;
  const project = useProjectsStore.getState().projects.find((p) => p.id === scope);
  const localRunning =
    !project?.remote ||
    effectiveTabLocation(tab, { vmProject: !!project?.vm?.enabled }) === "local";
  if (!localRunning) return null;
  if (useSettingsStore.getState().settings?.persist_local_sessions === false) return null;
  return tab.tmuxSession;
}

/**
 * The local tmux session a tab MINTED and therefore ends when it is closed, or
 * `null`. The spawn-side rule itself (`shouldPersistLocalTab`), so it covers the
 * Mobile-access agent tabs `localPersistentSessionOf` leaves out. An attach tab
 * (`tmuxAttach`, opened from the Sessions view) is never one: it looks at a
 * session it did not create — possibly one made outside Tabtivity — and closing the
 * window onto it must not take it down.
 */
export function mintedLocalSessionOf(scope: string, tab: TabEntry): string | null {
  if (IS_WINDOWS || tab.tmuxAttach || !tab.tmuxSession) return null;
  const project = useProjectsStore.getState().projects.find((p) => p.id === scope);
  const localRunning =
    !project?.remote ||
    effectiveTabLocation(tab, { vmProject: !!project?.vm?.enabled }) === "local";
  const enabled = useSettingsStore.getState().settings?.persist_local_sessions !== false;
  return shouldPersistLocalTab(
    tab.kind,
    scope,
    localRunning,
    enabled,
    !!project?.[MOBILE_ACCESS_KEY],
    isResumableAgentTab(tab) || isRelaunchableLocalTab(tab) || isSavedWhileLive(tab),
  )
    ? tab.tmuxSession
    : null;
}

/**
 * Close a tab from an explicit user action — the ×, the tab context menu, the
 * close chord, a bulk close, or the phone's ✕ (`MobileBridgeHost`), which is why
 * it takes a scope: the phone closes a tab in whichever project it is looking at.
 *
 * The tab leaves the layout (its pane unmounts, killing the PTY client) and the
 * local tmux session it minted is ended with it. A resumable agent tab is kept
 * for "Reopen closed tab" (`stores/agents/closedAgentTabs`). A remote session is left
 * running; see the file header. Programmatic removals (a re-run replacing its
 * prior tab, a file tab following its file) keep calling `removeTab` directly.
 */
export function closeTabInScope(scope: string, key: string): void {
  const store = useTabsStore.getState();
  const tab = (store.tabsByScope[scope] ?? []).find((t) => t.key === key);
  const session = tab ? mintedLocalSessionOf(scope, tab) : null;
  // An agent tab a restart would resume can be reopened the same way.
  if (tab) noteClosedAgentTab(scope, tab, !!session);
  store.removeTabInScope(scope, key);
  if (session) void invoke<void>("local_tmux_kill", { session }).catch(() => {});
}

/** `closeTabInScope` for the active scope — the desktop's own close. */
export function closeTabWithConfirm(key: string): void {
  closeTabInScope(useTabsStore.getState().scope, key);
}
