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
import { wrapStep } from "../wrapStep";
import { projectStations, type SteeringJumpBack } from "../../stores/keyboardSteering";
import { rootViewShown, useRootOverlayStore } from "../../stores/rootOverlay";
import { ROOT_SCOPE, allGroups, isPtyTabKind, useTabsStore, type TabEntry } from "../../stores/tabs";
import { isDetachedWindow } from "../../stores/detachedContext";
import { popoutActiveTab, usePopoutViewStore } from "../../stores/popoutView";

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
  return list[wrapStep(at, delta, list.length)];
}

/** The tab a status jump walks on from: the one showing. While the root
 *  console's Root view is up that is its focused subwindow's tab (a jump to a
 *  root tab does not change the workspace's active tab, so going by that one
 *  would land on the same root tab again and again); else the workspace's. */
export function shownStatusTab(): StatusTab | null {
  // A popout: the active tab of its focused subwindow (its tabs store is empty).
  if (isDetachedWindow()) {
    const view = usePopoutViewStore.getState();
    const tab = popoutActiveTab(view);
    return tab && view.scope ? { scope: view.scope, key: tab.key } : null;
  }
  const tabs = useTabsStore.getState();
  if (rootViewShown(useRootOverlayStore.getState())) {
    const groups = allGroups(tabs.layoutByScope[ROOT_SCOPE] ?? null);
    const focus = tabs.focusedGroupByScope[ROOT_SCOPE];
    const group = groups.find((g) => g.id === focus) ?? groups[0];
    if (group?.activeKey) return { scope: ROOT_SCOPE, key: group.activeKey };
  }
  return tabs.activeKey ? { scope: tabs.scope, key: tabs.activeKey } : null;
}

function sameTab(a: StatusTab, b: StatusTab): boolean {
  return a.scope === b.scope && a.key === b.key;
}

/**
 * The Back key's record after a status jump from `from` to `to`. A jump made
 * from the tab the last one landed on carries that one's origin on, so after
 * Q Q Q, Back returns to the tab the first Q left; a run that comes round to
 * that tab again has nothing left to go back to.
 */
export function afterStatusJump(
  prev: SteeringJumpBack | null,
  from: StatusTab | null,
  to: StatusTab,
): SteeringJumpBack | null {
  if (prev && from && sameTab(from, prev.landed)) {
    return sameTab(prev.origin, to) ? null : { origin: prev.origin, landed: to };
  }
  if (!from || sameTab(from, to)) return null;
  return { origin: from, landed: to };
}

/** The tab Back returns to: the record's origin while that tab is still open
 *  and not the one showing; null otherwise. */
export function jumpBackTarget(
  record: SteeringJumpBack | null,
  shown: StatusTab | null,
  tabsByScope: Record<string, TabEntry[]>,
): StatusTab | null {
  if (!record) return null;
  const { origin } = record;
  if (shown && sameTab(shown, origin)) return null;
  return (tabsByScope[origin.scope] ?? []).some((tab) => tab.key === origin.key) ? origin : null;
}
