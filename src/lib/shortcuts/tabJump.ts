import { useBoxesStore, BOX_SCOPE_PREFIX } from "../../stores/boxes";
import { useProjectsStore } from "../../stores/projects";
import { translate, useI18nStore } from "../i18n";
import { PROMPTCHART_TAB_CMD, ROOT_SCOPE, useTabsStore } from "../../stores/tabs";
import { resolveProjectDirectory } from "../../types";

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
 * Two fallbacks, both for a jump the reveal alone cannot make:
 *  - In a popout this store owns no layout, so the scope-addressed reveal finds
 *    nothing; `setActive` is forwarded to the main window and does the same job
 *    for the scope the popout is showing.
 *  - A tab in a hidden subwindow or a detached window isn't in the scope's
 *    visible tree; the switch still happens, since landing in the right scope is
 *    the half of the request that can be honoured.
 */
export function jumpToTab(scope: string, key: string) {
  const tabs = useTabsStore.getState();
  if (!tabs.revealTabInScope(scope, key) && tabs.scope === scope) tabs.setActive(key);
  void bringUpScope(scope);
}

/** Bring `scope` up as the one the tab bar shows: a box through the boxes
 *  store, a project (or the root) through the projects store. Resolves once the
 *  switch has been asked for; a scope already up costs nothing. */
function bringUpScope(scope: string): Promise<void> {
  const tabs = useTabsStore.getState();
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
  await bringUpScope(scope);
  const tabs = useTabsStore.getState();
  if (tabs.scope !== scope) return;
  const project = useProjectsStore.getState().projects.find((p) => p.id === scope);
  tabs.ensureTab(
    {
      label: translate(useI18nStore.getState().lang, "promptChart.heading"),
      cmd: PROMPTCHART_TAB_CMD,
      // Empty resolves to ~/tabtivity/root on the backend, as the root shell's does.
      cwd: project ? resolveProjectDirectory(project) : "",
      kind: "promptchart",
    },
    (tab) => tab.kind === "promptchart",
  );
}
