import { useBoxesStore, BOX_SCOPE_PREFIX } from "../../stores/boxes";
import { useProjectsStore } from "../../stores/projects";
import { translateNow } from "../i18n";
import { invoke } from "@tauri-apps/api/core";
import { PROMPTCHART_TAB_CMD, ROOT_SCOPE, orderedTabKeys, useTabsStore } from "../../stores/tabs";
import { resolveProjectDirectory } from "../../types";
import { ASSISTANT_SCOPE } from "../assistant";
import { showAssistant } from "../../stores/assistantView";
import { isDetachedWindow } from "../../stores/detachedContext";
import { ensureRootScopeHydrated, useRootOverlayStore } from "../../stores/rootOverlay";

/**
 * Show the tab a surface is pointing at: make it the visible tab of its
 * subwindow, then bring its scope up. That order is deliberate —
 * `revealTabInScope` writes the scope's own layout, which the switch then
 * mirrors, so the tab is already showing when the scope arrives instead of
 * appearing a frame later.
 *
 * One helper rather than a copy per surface: the pill status bars and the
 * Agents view are two ways of saying "that agent over there wants something",
 * and the only useful next step is the same one in both.
 *
 * A **root tab** is the exception: root is no place to switch to (the root
 * console is a window over whatever is open), so the jump opens the window on
 * its Root view with that tab in front (`show(key)`) and leaves the active
 * scope alone, and the caller must not close what it opened. In a popout the
 * old path stays (the popout owns no console; the forwarded `setActive` is
 * what reaches the main window).
 *
 * Two fallbacks, both for a jump the reveal alone cannot make:
 *  - In a popout this store owns no layout, so the scope-addressed reveal finds
 *    nothing; `setActive` is forwarded to the main window and does the same job
 *    for the scope the popout is showing.
 *  - A tab in a hidden subwindow isn't in the scope's visible tree; the switch
 *    still happens, since landing in the right scope is the half of the
 *    request that can be honoured.
 *
 * A tab that lives in a **popout** of its scope (main window only): the scope
 * comes up (which un-parks its popouts), the tab becomes its popout group's
 * active one (an `activate` on the record, which reseeds the popout) and that
 * window is raised (`focus_detached_window`).
 *
 * Returns where the tab lives: `"main"` (`MAIN_TAB_HOME`) or the popout's
 * window label, so keyboard steering can follow it there.
 */
export const MAIN_TAB_HOME = "main";

export function jumpToTab(scope: string, key: string): string {
  const tabs = useTabsStore.getState();
  if (!isDetachedWindow()) {
    const popout = (tabs.detachedGroupsByScope[scope] ?? []).find((entry) =>
      orderedTabKeys(entry.subtree).includes(key),
    );
    if (popout) {
      void bringUpScope(scope);
      tabs.applyDetachedEdit(scope, popout.id, { kind: "activate", key });
      void invoke<boolean>("focus_detached_window", { label: popout.label }).catch(() => false);
      return popout.label;
    }
  }
  if (scope === ROOT_SCOPE && !isDetachedWindow()) {
    useRootOverlayStore.getState().show(key);
    return MAIN_TAB_HOME;
  }
  // A Tabby chat is shown by the side panel's Tabby view, which a jump opens on
  // that chat.
  if (scope === ASSISTANT_SCOPE) showAssistant(key);
  if (!tabs.revealTabInScope(scope, key) && tabs.scope === scope) tabs.setActive(key);
  void bringUpScope(scope);
  return MAIN_TAB_HOME;
}

/** Bring `scope` up as the one the tab bar shows: a box through the boxes
 *  store, a project (or the root) through the projects store. Resolves once the
 *  switch has been asked for; a scope already up costs nothing. */
function bringUpScope(scope: string): Promise<void> {
  const tabs = useTabsStore.getState();
  // The Tabby scope is no project and no box: there is nothing to bring up
  // (`setActive("assistant")` would try to activate a project by that name).
  // Its chats are shown by the side panel's Tabby view, never by the tab bar.
  if (scope === ASSISTANT_SCOPE) return Promise.resolve();
  if (scope.startsWith(BOX_SCOPE_PREFIX)) {
    return tabs.scope === scope ? Promise.resolve() : useBoxesStore.getState().openBox(scope.slice(BOX_SCOPE_PREFIX.length));
  }
  const { activeId, setActive } = useProjectsStore.getState();
  const target = scope === ROOT_SCOPE ? null : scope;
  return activeId === target ? Promise.resolve() : setActive(target);
}

/**
 * Open the scope's Prompt chart tab, or focus the one it already has. The
 * Agents view of the file viewer calls this for ITS scope, which is not
 * necessarily the one the tab bar shows (a Files (Project) tab of another
 * project, a docked sidebar) — and `ensureTab` writes to the active scope, so
 * the scope is brought up first and the tab added only once it is. In a popout
 * the store owns no layout; the switch is forwarded and the tab is not added,
 * the same half-honoured jump `jumpToTab` settles for.
 *
 * Root's chart is a root tab like any other, so it opens in the Root view of
 * the window (its tab added to root's own layout, `show(key)`) and the active
 * scope stays as it was — root is no place to switch to.
 */
export async function openPromptChartTab(scope: string): Promise<void> {
  const project = useProjectsStore.getState().projects.find((p) => p.id === scope);
  const spec = {
    label: translateNow("promptChart.heading"),
    cmd: PROMPTCHART_TAB_CMD,
    // Empty resolves to ~/tabtivity/root on the backend, as the root shell's does.
    cwd: project ? resolveProjectDirectory(project) : "",
    kind: "promptchart" as const,
  };
  if (scope === ROOT_SCOPE && !isDetachedWindow()) {
    await ensureRootScopeHydrated();
    const prior = (useTabsStore.getState().tabsByScope[ROOT_SCOPE] ?? []).find((tab) => tab.kind === "promptchart");
    const tab = prior ?? useTabsStore.getState().addTabToScope(ROOT_SCOPE, spec);
    useRootOverlayStore.getState().show(tab.key);
    return;
  }
  await bringUpScope(scope);
  const tabs = useTabsStore.getState();
  if (tabs.scope !== scope) return;
  tabs.ensureTab(spec, (tab) => tab.kind === "promptchart");
}
