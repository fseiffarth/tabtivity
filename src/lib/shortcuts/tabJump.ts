import { useBoxesStore, BOX_SCOPE_PREFIX } from "../../stores/boxes";
import { useProjectsStore } from "../../stores/projects";
import { translateNow } from "../i18n";
import { PROMPTCHART_TAB_CMD, ROOT_SCOPE, useTabsStore } from "../../stores/tabs";
import { resolveProjectDirectory } from "../../types";
import { ASSISTANT_SCOPE } from "../assistant";
import { showAssistant } from "../../stores/assistantView";
import { isDetachedWindow } from "../../stores/detachedContext";
import { useRootOverlayStore } from "../../stores/rootOverlay";

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
 *  - A tab in a hidden subwindow or a detached window isn't in the scope's
 *    visible tree; the switch still happens, since landing in the right scope is
 *    the half of the request that can be honoured.
 */
export function jumpToTab(scope: string, key: string) {
  if (scope === ROOT_SCOPE && !isDetachedWindow()) {
    useRootOverlayStore.getState().show(key);
    return;
  }
  const tabs = useTabsStore.getState();
  // A Tabby chat is shown by the side panel's Tabby view, which a jump opens on
  // that chat.
  if (scope === ASSISTANT_SCOPE) showAssistant(key);
  if (!tabs.revealTabInScope(scope, key) && tabs.scope === scope) tabs.setActive(key);
  void bringUpScope(scope);
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
 */
export async function openPromptChartTab(scope: string): Promise<void> {
  // Root's own Prompt chart tab still goes through `bringUpScope`, which
  // switches the workspace to the root scope: a separate, pre-existing case
  // that `jumpToTab`'s root rule does not cover.
  await bringUpScope(scope);
  const tabs = useTabsStore.getState();
  if (tabs.scope !== scope) return;
  const project = useProjectsStore.getState().projects.find((p) => p.id === scope);
  tabs.ensureTab(
    {
      label: translateNow("promptChart.heading"),
      cmd: PROMPTCHART_TAB_CMD,
      // Empty resolves to ~/tabtivity/root on the backend, as the root shell's does.
      cwd: project ? resolveProjectDirectory(project) : "",
      kind: "promptchart",
    },
    (tab) => tab.kind === "promptchart",
  );
}
