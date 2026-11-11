/**
 * Which tabs steering's tab levels walk.
 *
 * Normally the workspace's: the active scope's layout and focused subwindow.
 * While the root window shows its Root view
 * (`rootViewShown`), the window is what the user is looking at, and the tabs
 * under it are not — a status key that jumped to a root agent, or the keys
 * after Shift+Space, walk **Root's** tabs and set Root's focused subwindow, so
 * what is typed afterwards goes to the root terminal (`RootView` focuses the
 * active tab of its focused group).
 *
 * In a popout window (`isDetachedWindow`) the tabs store is empty on purpose:
 * the tab levels walk the popout's own subwindows and tabs, from
 * `stores/popoutView`, and the store actions steering calls route their
 * writes to the main window (`stores/tabs`, popout branches).
 *
 * The keys themselves are unchanged and rebindable (`steeringBindings`): only
 * the target moves.
 */
import { rootViewShown, useRootOverlayStore } from "../../stores/rootOverlay";
import { ROOT_SCOPE, allGroups, findGroup, useTabsStore, type LayoutNode, type TabEntry } from "../../stores/tabs";
import { isDetachedWindow } from "../../stores/detachedContext";
import { popoutActiveTab, popoutFocusedGroup, usePopoutViewStore } from "../../stores/popoutView";

/** The Root view is up and steering's tab levels belong to it. Never in a
 *  popout, which has no Root view (its overlay store is idle). */
export function steeringInRoot(): boolean {
  return !isDetachedWindow() && rootViewShown(useRootOverlayStore.getState());
}

/** What the tab levels walk: the scope, its layout, and its focused subwindow
 *  (Root's and a popout's fall back to their first, as they draw it).
 *  `popout`: this heap is a popout and these are its tabs (`popoutView`). */
export interface SteeringTabs {
  scope: string;
  layout: LayoutNode | null;
  focusedGroupId: string | null;
  inRoot: boolean;
  popout: boolean;
}

export function steeringTabs(): SteeringTabs {
  if (isDetachedWindow()) {
    const view = usePopoutViewStore.getState();
    return {
      scope: view.scope ?? "",
      layout: view.tree,
      focusedGroupId: popoutFocusedGroup(view)?.id ?? null,
      inRoot: false,
      popout: true,
    };
  }
  const s = useTabsStore.getState();
  if (!steeringInRoot()) {
    return { scope: s.scope, layout: s.layout, focusedGroupId: s.focusedGroupId, inRoot: false, popout: false };
  }
  const layout = s.layoutByScope[ROOT_SCOPE] ?? null;
  const stored = s.focusedGroupByScope[ROOT_SCOPE] ?? null;
  const focusedGroupId = (stored && findGroup(layout, stored)?.id) || allGroups(layout)[0]?.id || null;
  return { scope: ROOT_SCOPE, layout, focusedGroupId, inRoot: true, popout: false };
}

/** The active tab of the walked scope's focused subwindow. */
export function steeringTabsActive(): { scope: string; tab: TabEntry } | null {
  if (isDetachedWindow()) {
    const view = usePopoutViewStore.getState();
    const tab = popoutActiveTab(view);
    return tab && view.scope ? { scope: view.scope, tab } : null;
  }
  const s = useTabsStore.getState();
  const walked = steeringTabs();
  if (!walked.inRoot) {
    const tab = s.activeKey ? s.tabs.find((t) => t.key === s.activeKey) : undefined;
    return tab ? { scope: s.scope, tab } : null;
  }
  const key = walked.focusedGroupId ? findGroup(walked.layout, walked.focusedGroupId)?.activeKey : null;
  const tab = key ? (s.tabsByScope[ROOT_SCOPE] ?? []).find((t) => t.key === key) : undefined;
  return tab ? { scope: ROOT_SCOPE, tab } : null;
}

/** {@link steeringTabs} plus the active tab, as a component sees it: re-renders
 *  when any of them changes (the tabs store, the Root view, a popout's view). */
export interface SteeringTabsView extends SteeringTabs {
  activeTab: TabEntry | null;
}

export function useSteeringTabs(): SteeringTabsView {
  // Subscriptions only: the values are read back through the getters below, so
  // the three sources can never disagree about which one is walked.
  useTabsStore((s) => s.layout);
  useTabsStore((s) => s.focusedGroupId);
  useTabsStore((s) => s.activeKey);
  useTabsStore((s) => s.tabs);
  useTabsStore((s) => s.layoutByScope[ROOT_SCOPE]);
  useTabsStore((s) => s.focusedGroupByScope[ROOT_SCOPE]);
  useTabsStore((s) => s.tabsByScope[ROOT_SCOPE]);
  useRootOverlayStore((s) => rootViewShown(s));
  usePopoutViewStore((s) => s.tree);
  usePopoutViewStore((s) => s.tabs);
  usePopoutViewStore((s) => s.focusedGroupId);
  usePopoutViewStore((s) => s.scope);
  return { ...steeringTabs(), activeTab: steeringTabsActive()?.tab ?? null };
}
