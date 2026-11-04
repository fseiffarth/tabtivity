/**
 * Steering's status jumps: walk every tab — in every project, the root and the
 * boxes — that is waiting on an answer, working, or finished unseen, and bring
 * the next one up with `jumpToTab` (the pill status bars' own jump).
 *
 * The statuses are the activity store's, the ones the tab glow and the pill
 * bars draw: `attentionByTab` "decision" / "done" and `busyByTab`. The walk
 * order is the station ring (`projectStations`: root first, then the pills in
 * display order), any other scope (a box) after it, and each scope's tabs in
 * strip order — so pressing the key again goes on from the tab it landed on.
 */
import type { AttentionKind } from "../../stores/activity";
import { projectStations } from "../../stores/keyboardSteering";
import { rootViewShown, useRootOverlayStore } from "../../stores/rootOverlay";
import { ROOT_SCOPE, allGroups, isPtyTabKind, useTabsStore, type TabEntry } from "../../stores/tabs";

export type TabStatusKind = "decision" | "working" | "done";

export interface StatusTab {
  scope: string;
  key: string;
}

/** The scopes in walk order: the station ring, then the rest by name. */
function scopeOrder(tabsByScope: Record<string, TabEntry[]>): string[] {
  const ring = projectStations().map((id) => id ?? ROOT_SCOPE);
  const rest = Object.keys(tabsByScope)
    .filter((scope) => !ring.includes(scope))
    .sort();
  return [...ring, ...rest];
}

/** Every open tab in `kind`, in walk order. */
export function statusTabs(
  kind: TabStatusKind,
  busyByTab: Record<string, boolean>,
  attentionByTab: Record<string, AttentionKind>,
  tabsByScope: Record<string, TabEntry[]>,
): StatusTab[] {
  const out: StatusTab[] = [];
  for (const scope of scopeOrder(tabsByScope)) {
    for (const tab of tabsByScope[scope] ?? []) {
      const ptyId = `${scope}:${tab.key}`;
      const hit =
        kind === "working"
          ? isPtyTabKind(tab.kind) && !!busyByTab[ptyId]
          : attentionByTab[ptyId] === kind;
      if (hit) out.push({ scope, key: tab.key });
    }
  }
  return out;
}

/** The tab after (`delta` 1) or before (-1) the one showing, wrapping; the
 *  first (last) when the one showing is not in the list. Null when none is. */
export function nextStatusTab(
  list: StatusTab[],
  current: StatusTab | null,
  delta: 1 | -1,
): StatusTab | null {
  if (list.length === 0) return null;
  const at = current
    ? list.findIndex((t) => t.scope === current.scope && t.key === current.key)
    : -1;
  if (at < 0) return list[delta > 0 ? 0 : list.length - 1];
  return list[(at + delta + list.length) % list.length];
}

/** The tab a status jump walks on from: the one showing. While the root
 *  console's Root view is up that is its focused subwindow's tab (a jump to a
 *  root tab does not change the workspace's active tab, so going by that one
 *  would land on the same root tab again and again); else the workspace's. */
export function shownStatusTab(): StatusTab | null {
  const tabs = useTabsStore.getState();
  if (rootViewShown(useRootOverlayStore.getState())) {
    const groups = allGroups(tabs.layoutByScope[ROOT_SCOPE] ?? null);
    const focus = tabs.focusedGroupByScope[ROOT_SCOPE];
    const group = groups.find((g) => g.id === focus) ?? groups[0];
    if (group?.activeKey) return { scope: ROOT_SCOPE, key: group.activeKey };
  }
  return tabs.activeKey ? { scope: tabs.scope, key: tabs.activeKey } : null;
}
