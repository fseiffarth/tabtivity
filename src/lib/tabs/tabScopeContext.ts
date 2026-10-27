import { createContext, useContext } from "react";
import { findGroupOfTab, useTabsStore, type TabEntry } from "../../stores/tabs";
import { getDetachedWindowContext } from "../../stores/detachedContext";

/**
 * The scope the tabs a view opens belong to, when that is NOT the active scope.
 *
 * The root console is the case: it floats over whatever project is on screen,
 * so its file column, Files tabs and viewers render root's tabs while the store's
 * current scope is the project's. Every "open a viewer" path defaulted to
 * `addTab` — the active scope — so a PDF double-clicked in the console landed in
 * the project underneath. `RootOverlay` provides `ROOT_SCOPE`; everywhere else
 * this is null and the old current-scope path runs unchanged.
 *
 * A detached popout does not use this: its store owns no layout, and its tabs
 * already stream through `FileDropContext` / the detached window context.
 */
export const TabScopeContext = createContext<string | null>(null);

export function useTabScope(): string | null {
  return useContext(TabScopeContext);
}

/**
 * Open `tab` in `scope` and bring it to the front of its subwindow — or, when
 * `matches` picks a tab that scope already has, focus that one instead
 * (`replace` closes it and opens the fresh copy: a diff or a compiled PDF that
 * must re-read). The scope-addressed twin of the `tabs.find` / `addTab` /
 * `setActive` sequence the open-a-file paths use.
 */
export function openTabInScope(
  scope: string,
  tab: Omit<TabEntry, "key">,
  matches?: (t: TabEntry) => boolean,
  opts?: { replace?: boolean },
): TabEntry {
  const store = useTabsStore.getState();
  const prior = matches ? (store.tabsByScope[scope] ?? []).find(matches) : undefined;
  if (prior && !opts?.replace) {
    store.setActive(prior.key);
    return prior;
  }
  if (prior) store.removeTabInScope(scope, prior.key);
  const entry = useTabsStore.getState().addTabToScope(scope, tab);
  useTabsStore.getState().setActive(entry.key);
  return entry;
}

/**
 * Open `tab` in a new subwindow split off to the right of `scope`'s focused one
 * (a Ctrl+click on a file link). A tab `matches` picks that the scope already
 * has is moved there instead of duplicated — or just focused when it already
 * fills a subwindow of its own. In a popout the split is the popout's own.
 */
export function openTabInNewSubwindow(
  scope: string,
  tab: Omit<TabEntry, "key">,
  matches?: (t: TabEntry) => boolean,
): void {
  const store = useTabsStore.getState();
  const detached = getDetachedWindowContext();
  if (detached) {
    store.splitWithNewTab(tab, detached.targetGroupId(), "right");
    return;
  }
  const layout = store.layoutByScope[scope] ?? null;
  const prior = matches ? (store.tabsByScope[scope] ?? []).find(matches) : undefined;
  const key = prior?.key ?? store.addTabToScope(scope, tab).key;
  const target = useTabsStore.getState().focusedGroupByScope[scope];
  const own = prior && layout ? findGroupOfTab(layout, prior.key) : null;
  if (target && !(own && own.group.tabKeys.length === 1)) {
    useTabsStore.getState().splitWithTabInScope(scope, key, target, "right");
  }
  useTabsStore.getState().setActive(key);
}
