// The shared tab order (headless owner plan, H1) as this window's tree and
// lists hold it. Pure. Moved out of `stores/tabs.ts`.

import type { LayoutNode, TabEntry } from "./types";
import { orderedTabKeys } from "./layoutTree";

/** The order a scope's tabs are saved in — the shared order as this window
 * states it: its pane tree left to right, then any tab the tree does not
 * place (a popout's, a parked group's) in list order. */
export function persistOrder(layout: LayoutNode | null, tabs: readonly TabEntry[]): TabEntry[] {
  const keyOrder = orderedTabKeys(layout);
  const byKey = new Map(tabs.map((t) => [t.key, t] as const));
  const ordered = keyOrder.map((k) => byKey.get(k)).filter((t): t is TabEntry => t != null);
  const placed = new Set(keyOrder);
  for (const t of tabs) {
    if (!placed.has(t.key)) ordered.push(t);
  }
  return ordered;
}

/** `items` with the ones `rank` names put in its order, each into a slot one
 * of them held; the rest keep theirs. The same array when nothing moved. */
export function inSharedOrder<T>(items: T[], keyOf: (item: T) => string, rank: ReadonlyMap<string, number>): T[] {
  const ranked = items.filter((item) => rank.has(keyOf(item)));
  const sorted = [...ranked].sort((a, b) => (rank.get(keyOf(a)) ?? 0) - (rank.get(keyOf(b)) ?? 0));
  if (sorted.every((item, i) => item === ranked[i])) return items;
  let next = 0;
  return items.map((item) => (rank.has(keyOf(item)) ? sorted[next++] : item));
}

/** The shared order as this window's panes show it: each pane keeps its own
 * tabs, in the shared order. A move across panes has no slot to land in, as
 * in `reorderTabInScope`, and the owner refuses one
 * (`workspace::reorder_tab_in`), so the panes left to right then read as the
 * shared order again. The same tree when nothing moved. */
export function followSharedOrder(node: LayoutNode, rank: ReadonlyMap<string, number>): LayoutNode {
  if (node.type === "group") {
    const tabKeys = inSharedOrder(node.tabKeys, (k) => k, rank);
    return tabKeys === node.tabKeys ? node : { ...node, tabKeys };
  }
  const children = node.children.map((c) => followSharedOrder(c, rank));
  return children.every((c, i) => c === node.children[i]) ? node : { ...node, children };
}

export function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}
