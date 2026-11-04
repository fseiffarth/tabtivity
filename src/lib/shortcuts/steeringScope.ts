/**
 * Which tabs steering's tab levels walk.
 *
 * Normally the workspace's: the active scope's layout and focused subwindow.
 * While the root window shows its Root view with the `cockpit` experiment on
 * (`rootViewShown`), the window is what the user is looking at, and the tabs
 * under it are not — a status key that jumped to a root agent, or the keys
 * after Shift+Space, walk **Root's** tabs and set Root's focused subwindow, so
 * what is typed afterwards goes to the root terminal (`RootView` focuses the
 * active tab of its focused group). Without the experiment the console is
 * today's, and steering walks it as the overlay region, as it always did.
 *
 * The keys themselves are unchanged and rebindable (`steeringBindings`): only
 * the target moves.
 */
import { experimentalEnabled } from "../experimental";
import { useSettingsStore } from "../../stores/settings";
import { rootViewShown, useRootOverlayStore } from "../../stores/rootOverlay";
import { ROOT_SCOPE, allGroups, findGroup, useTabsStore, type LayoutNode, type TabEntry } from "../../stores/tabs";

/** The Root view is up and steering's tab levels belong to it. */
export function steeringInRoot(): boolean {
  return (
    experimentalEnabled(useSettingsStore.getState().settings, "cockpit") &&
    rootViewShown(useRootOverlayStore.getState())
  );
}

/** What the tab levels walk: the scope, its layout, and its focused subwindow
 *  (Root's falls back to its first, as `RootView` draws it). */
export interface SteeringTabs {
  scope: string;
  layout: LayoutNode | null;
  focusedGroupId: string | null;
  inRoot: boolean;
}

export function steeringTabs(): SteeringTabs {
  const s = useTabsStore.getState();
  if (!steeringInRoot()) {
    return { scope: s.scope, layout: s.layout, focusedGroupId: s.focusedGroupId, inRoot: false };
  }
  const layout = s.layoutByScope[ROOT_SCOPE] ?? null;
  const stored = s.focusedGroupByScope[ROOT_SCOPE] ?? null;
  const focusedGroupId = (stored && findGroup(layout, stored)?.id) || allGroups(layout)[0]?.id || null;
  return { scope: ROOT_SCOPE, layout, focusedGroupId, inRoot: true };
}

/** The active tab of the walked scope's focused subwindow. */
export function steeringTabsActive(): { scope: string; tab: TabEntry } | null {
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
