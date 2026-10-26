// Pure layout-tree operations (no store access). Moved out of `stores/tabs.ts`.

import type { DropEdge, GroupNode, LayoutNode, SplitDir, SplitNode } from "./types";
import { nextGroupId, nextSplitId } from "./ids";

/**
 * Synthetic group id for the empty-state placeholder subwindow (rendered by
 * CenterPanel when a scope has no layout yet). It is NOT a real group in the
 * store — a drop onto it creates the first tab (addTab builds the root group).
 */
export const EMPTY_GROUP_ID = "__empty__";

/**
 * Fallback minimum subwindow (split pane) size in px a divider drag may shrink a
 * pane to, per axis, when `settings.min_subwindow_width/height` is unset. Mirrors
 * the Rust schema note on those fields (schema/settings.rs).
 */
export const DEFAULT_MIN_SUBWINDOW_PX = 120;

// ── Pure tree helpers ───────────────────────────────────────────────────────

/** Find a group node by id anywhere in the tree. */
export function findGroup(node: LayoutNode | null, id: string): GroupNode | null {
  if (!node) return null;
  if (node.type === "group") return node.id === id ? node : null;
  for (const child of node.children) {
    const found = findGroup(child, id);
    if (found) return found;
  }
  return null;
}

/** Find a SPLIT node by id anywhere in the tree (#42: a multi-pane popout's root
 *  is a split, so its respawn detaches the whole split subtree by this id). */
export function findSplit(node: LayoutNode | null, id: string): SplitNode | null {
  if (!node || node.type !== "split") return null;
  if (node.id === id) return node;
  for (const child of node.children) {
    const found = findSplit(child, id);
    if (found) return found;
  }
  return null;
}

/** Remove the subtree rooted at `id` (a group OR split) from `node`, collapsing
 *  single-child splits that result. Returns the remaining tree (null if it
 *  empties). Used to pop a whole multi-pane popout out of the in-window layout. */
export function removeNodeById(node: LayoutNode | null, id: string): LayoutNode | null {
  if (!node) return null;
  if (node.id === id) return null;
  if (node.type === "group") return node;
  const kept: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, i) => {
    const r = removeNodeById(child, id);
    if (r) {
      kept.push(r);
      sizes.push(node.sizes[i] ?? 1);
    }
  });
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0];
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  return { ...node, children: kept, sizes: sizes.map((s) => s / total) };
}

/** Find the group that currently holds `key` (and the key's index in it). */
export function findGroupOfTab(
  node: LayoutNode | null,
  key: string,
): { group: GroupNode; index: number } | null {
  if (!node) return null;
  if (node.type === "group") {
    const index = node.tabKeys.indexOf(key);
    return index >= 0 ? { group: node, index } : null;
  }
  for (const child of node.children) {
    const found = findGroupOfTab(child, key);
    if (found) return found;
  }
  return null;
}

/** All group nodes in document order. */
export function allGroups(node: LayoutNode | null): GroupNode[] {
  if (!node) return [];
  if (node.type === "group") return [node];
  return node.children.flatMap(allGroups);
}

/** Flat list of all tab keys, in stable left-to-right tree order. */
export function orderedTabKeys(node: LayoutNode | null): string[] {
  return allGroups(node).flatMap((g) => g.tabKeys);
}

/** Remove a tab key from whichever group holds it within a subtree, collapsing
 *  an emptied group / lone-child split. Returns the new (possibly null) subtree;
 *  returns the input unchanged if the key isn't present. Used by the detached
 *  subtree mutators, which (post-split) operate on a LayoutNode, not a single
 *  group. */
export function removeKeyFromTree(
  node: LayoutNode,
  key: string,
  keepEmpty = false,
): LayoutNode | null {
  const found = findGroupOfTab(node, key);
  if (!found) return node;
  const removed = mapGroup(node, found.group.id, (g) => {
    const tabKeys = g.tabKeys.filter((k) => k !== key);
    return {
      ...g,
      tabKeys,
      activeKey: g.activeKey === key ? (tabKeys[0] ?? null) : g.activeKey,
      ...(keepEmpty && tabKeys.length === 0 ? { keepEmpty: true } : {}),
    };
  });
  return collapse(removed);
}

/** Append a tab key to a subtree's FIRST group (depth-first) and activate it
 *  there. Mirrors the single-group append for a tree subtree. */
function appendKeyToTree(node: LayoutNode, key: string): LayoutNode {
  const g = firstGroup(node);
  return mapGroup(node, g.id, (grp) => ({
    ...grp,
    tabKeys: [...grp.tabKeys, key],
    activeKey: key,
  }));
}

/**
 * #42: where to place a NEW key inside a detached popout's subtree when docking a
 * tab/file INTO it from another window. `edge` carves a new pane at that side of
 * the target group (center merges into it); `index` inserts into the target
 * group's bar at that slot. Mirrors the within-popout drop semantics.
 */
export type DetachedDockTarget =
  | { groupId: string; edge: DropEdge }
  | { groupId: string; index: number };

/** Place a NEW key into a subtree at `target` (or the first group when no target,
 *  matching the legacy append). A non-center edge splits off a new pane beside the
 *  target group; center / a bar slot inserts into the target group. Falls back to
 *  an append when the target group is gone. Pure; activates the key. */
export function placeKeyInTree(
  node: LayoutNode,
  key: string,
  target?: DetachedDockTarget,
): LayoutNode {
  if (!target || !findGroup(node, target.groupId)) return appendKeyToTree(node, key);
  if ("index" in target) {
    return mapGroup(node, target.groupId, (g) => {
      const at = Math.min(Math.max(target.index, 0), g.tabKeys.length);
      const tabKeys = [...g.tabKeys];
      tabKeys.splice(at, 0, key);
      return { ...g, tabKeys, activeKey: key };
    });
  }
  if (target.edge === "center") {
    return mapGroup(node, target.groupId, (g) => ({
      ...g,
      tabKeys: [...g.tabKeys, key],
      activeKey: key,
    }));
  }
  const newGroup: GroupNode = { type: "group", id: nextGroupId(), tabKeys: [key], activeKey: key };
  const dir: SplitDir = target.edge === "left" || target.edge === "right" ? "row" : "column";
  const before = target.edge === "left" || target.edge === "top";
  return insertAdjacent(node, target.groupId, newGroup, dir, before);
}

/** Move `key` out of its current group into `targetGroupId` at `index` (append
 *  when `index` is undefined), activating it there. Collapses the source group /
 *  lone-child split if the move empties it — so dragging a split pane's only tab
 *  onto the other pane's bar merges the two panes back into one. Pure; used by a
 *  detached popout to merge a tab across its own groups. Returns the input
 *  unchanged when the key isn't present, or null if removal empties the tree
 *  (can't happen for a cross-group move, which always leaves the target).
 *  No-ops (returns the input) when the target is the key's own group — that case
 *  is a within-group reorder, handled elsewhere. */
export function moveKeyInTree(
  node: LayoutNode,
  key: string,
  targetGroupId: string,
  index?: number,
): LayoutNode | null {
  const source = findGroupOfTab(node, key);
  if (!source) return node;
  if (source.group.id === targetGroupId) return node;
  const cleaned = removeKeyFromTree(node, key);
  if (!cleaned) return null;
  // The target survives the removal (it's non-empty); bail if it somehow doesn't.
  if (!findGroup(cleaned, targetGroupId)) return node;
  return mapGroup(cleaned, targetGroupId, (g) => {
    const tabKeys = [...g.tabKeys];
    const at = index == null ? tabKeys.length : Math.min(Math.max(index, 0), tabKeys.length);
    tabKeys.splice(at, 0, key);
    return { ...g, tabKeys, activeKey: key };
  });
}

/** Ids a caller may pre-mint for the nodes a split creates: the new pane's
 *  group, and the split node that wraps it when the target's parent runs the
 *  other axis (unused when the pane just joins an existing split). A detached
 *  popout mints these so the main store's copy of its tree uses the same names —
 *  see `DetachedEditPayload`'s `split`. An id already present in the tree is
 *  ignored (a fresh one is minted instead) so a bad value can't corrupt it. */
export interface SplitNodeIds {
  groupId?: string;
  splitId?: string;
}

/** Does any node in `node` carry `id`? */
function treeHasId(node: LayoutNode, id: string): boolean {
  if (node.id === id) return true;
  return node.type === "split" && node.children.some((c) => treeHasId(c, id));
}

/** Split `key` out of its group into a new pane at `edge` of `targetGroupId`,
 *  within `node`. Pure; mirrors `splitWithTab`'s algorithm but on an arbitrary
 *  subtree so the in-window layout AND a detached popout's subtree share it.
 *  Returns the new subtree, or null if the split is a no-op / invalid. */
export function splitSubtree(
  node: LayoutNode,
  key: string,
  targetGroupId: string,
  edge: DropEdge,
  ids?: SplitNodeIds,
): LayoutNode | null {
  if (edge === "center") return null; // center merges, it isn't a split
  const source = findGroupOfTab(node, key);
  const target = findGroup(node, targetGroupId);
  if (!source || !target) return null;
  // Dropping a group's only tab onto its own edge would remove then re-add it.
  if (source.group.id === targetGroupId && source.group.tabKeys.length === 1) {
    return null;
  }
  const cleaned = removeKeyFromTree(node, key);
  if (!cleaned || !findGroup(cleaned, targetGroupId)) return null;
  const groupId =
    ids?.groupId && !treeHasId(cleaned, ids.groupId) ? ids.groupId : nextGroupId();
  const splitId =
    ids?.splitId && !treeHasId(cleaned, ids.splitId) && ids.splitId !== groupId
      ? ids.splitId
      : undefined;
  const newGroup: GroupNode = {
    type: "group",
    id: groupId,
    tabKeys: [key],
    activeKey: key,
  };
  const dir: SplitDir = edge === "left" || edge === "right" ? "row" : "column";
  const before = edge === "left" || edge === "top";
  return insertAdjacent(cleaned, targetGroupId, newGroup, dir, before, splitId);
}

/** The first group reached by descending `node` (depth-first, left-to-right). */
export function firstGroup(node: LayoutNode): GroupNode {
  let cur = node;
  while (cur.type === "split") cur = cur.children[0];
  return cur;
}

/** An empty group the collapse drops: one without the `keepEmpty` mark. */
function isDroppableGroup(node: LayoutNode): boolean {
  return node.type === "group" && node.tabKeys.length === 0 && !node.keepEmpty;
}

/** A group emptied so the collapse drops it (merged, moved, detached, hidden
 *  away) — never left standing as an empty subwindow. */
export function vacated(g: GroupNode): GroupNode {
  return { ...g, tabKeys: [], activeKey: null, keepEmpty: false };
}

/**
 * Collapse a tree bottom-up:
 *  - a split with a single remaining child is replaced by that child;
 *  - empty groups inside a split are dropped (a lone empty root group is kept
 *    so an empty scope still has a root container, but callers may pass null),
 *    except one marked `keepEmpty`.
 * Returns the new (possibly null) root.
 */
export function collapse(node: LayoutNode | null): LayoutNode | null {
  if (!node) return null;
  if (node.type === "group") {
    return node;
  }
  // Recurse, drop emptied groups / null children.
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, i) => {
    const c = collapse(child);
    if (!c) return;
    if (isDroppableGroup(c)) return; // drop empty group
    children.push(c);
    sizes.push(node.sizes[i] ?? 1);
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  // Renormalize sizes to sum to 1.
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  return {
    ...node,
    children,
    sizes: sizes.map((s) => s / total),
  };
}

/**
 * Eff #5: prune-to-keys + collapse in a SINGLE bottom-up pass, also collecting
 * every surviving group into `groupsOut` (in document order) so `writeScope`
 * doesn't re-walk the tree to refind its focus / active / fullscreen groups.
 * Replaces the former `pruneLayoutToKeys` → `collapse` → repeated
 * `findGroup`/`allGroups` walks (4–5 traversals per mutation, one pass now).
 *
 * Behaviour matches running prune-to-keys then collapse: a group keeps only keys
 * in `keep` (its active repicked to the first survivor if it was dropped), empty
 * groups are dropped inside splits, single-child splits unwrap to their child,
 * and sibling sizes renormalize. `groupsOut` only ever receives groups that
 * survive into the returned tree.
 */
export function pruneCollapseCollect(
  node: LayoutNode | null,
  keep: Set<string>,
  groupsOut: GroupNode[],
): LayoutNode | null {
  if (!node) return null;
  if (node.type === "group") {
    const tabKeys = node.tabKeys.filter((k) => keep.has(k));
    const activeKey =
      node.activeKey && tabKeys.includes(node.activeKey)
        ? node.activeKey
        : (tabKeys[0] ?? null);
    // A kept-empty subwindow that got a tab again is an ordinary group.
    const unmark = !!node.keepEmpty && tabKeys.length > 0;
    // Identity is preserved when nothing was pruned: `layout` must not change
    // for a write that only touched a tab payload (performance plan §3.1) — a
    // fresh tree per write re-rendered every group on a viewer's scroll pause.
    const next: GroupNode =
      tabKeys.length === node.tabKeys.length && activeKey === node.activeKey && !unmark
        ? node
        : { ...node, tabKeys, activeKey, ...(unmark ? { keepEmpty: false } : {}) };
    groupsOut.push(next);
    return next;
  }
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  let same = true;
  node.children.forEach((child, i) => {
    // Collect each child's descendants into a scratch list first; only merge it
    // into groupsOut once we know the child survives (isn't an emptied group or
    // a fully-collapsed split) so groupsOut never lists a dropped group.
    const scratch: GroupNode[] = [];
    const c = pruneCollapseCollect(child, keep, scratch);
    if (!c) {
      same = false;
      return;
    }
    if (isDroppableGroup(c)) {
      same = false;
      return; // drop empty group
    }
    if (c !== child) same = false;
    children.push(c);
    sizes.push(node.sizes[i] ?? 1);
    for (const g of scratch) groupsOut.push(g);
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  // Every child survived unchanged: the split itself is unchanged (its sizes
  // were normalized when they were last set).
  if (same && sizes.length === node.sizes.length) return node;
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  return { ...node, children, sizes: sizes.map((s) => s / total) };
}

/**
 * Insert `newGroup` adjacent to the group `targetId` in the given direction.
 * `before` controls whether the new group goes before (left/top) or after
 * (right/bottom) the target. The target's slot is split 50/50 with the new
 * group. Returns the new root.
 */
export function insertAdjacent(
  root: LayoutNode,
  targetId: string,
  // The node to inject beside the target. Usually a fresh GroupNode, but may be
  // a whole SplitNode (e.g. re-attaching a multi-pane detached popout's subtree).
  newGroup: LayoutNode,
  dir: SplitDir,
  before: boolean,
  // Id for the split node this may have to create (see `SplitNodeIds`).
  splitId?: string,
): LayoutNode {
  // Root itself is the target → wrap into a split.
  if (root.type === "group" && root.id === targetId) {
    return makeSplit(dir, before ? [newGroup, root] : [root, newGroup], splitId);
  }

  function recurse(node: LayoutNode): LayoutNode {
    if (node.type === "group") return node;

    // Is the target a direct group child of this split?
    const childIdx = node.children.findIndex(
      (c) => c.type === "group" && c.id === targetId,
    );
    if (childIdx >= 0) {
      if (node.dir === dir) {
        // Same axis: insert the new group beside the target, splitting the
        // target's size slot 50/50.
        const children = [...node.children];
        const sizes = [...node.sizes];
        const targetSize = sizes[childIdx];
        const half = targetSize / 2;
        const insertAt = before ? childIdx : childIdx + 1;
        children.splice(insertAt, 0, newGroup);
        sizes.splice(childIdx, 1, half, half); // replace target slot with two halves
        // After splice the order of the two halves matches children order at
        // childIdx / childIdx+1; ensure the half list aligns with insertion.
        // We replaced 1 size with [half, half]; if `before`, the new group is
        // the first half — already correct since both halves are equal.
        return { ...node, children, sizes };
      }
      // Different axis: wrap just the target child in a nested split.
      const children = [...node.children];
      const target = children[childIdx] as GroupNode;
      children[childIdx] = makeSplit(
        dir,
        before ? [newGroup, target] : [target, newGroup],
        splitId,
      );
      return { ...node, children };
    }

    // Recurse into split children.
    return { ...node, children: node.children.map(recurse) };
  }

  return recurse(root);
}

function makeSplit(dir: SplitDir, children: LayoutNode[], id?: string): SplitNode {
  const n = children.length;
  return {
    type: "split",
    id: id ?? nextSplitId(),
    dir,
    children,
    sizes: children.map(() => 1 / n),
  };
}

/** Apply a resize to the divider between child i and i+1 of `splitId`. Exported
 *  so a detached popout's subtree can be resized through the same pure path. */
export function applyResize(
  node: LayoutNode,
  splitId: string,
  dividerIndex: number,
  fraction: number,
): LayoutNode {
  if (node.type === "group") return node;
  if (node.id === splitId) {
    if (dividerIndex < 0 || dividerIndex >= node.children.length - 1) {
      return node;
    }
    const sizes = [...node.sizes];
    const pair = sizes[dividerIndex] + sizes[dividerIndex + 1];
    const min = 0.05;
    const left = Math.min(Math.max(fraction, min), pair - min);
    sizes[dividerIndex] = left;
    sizes[dividerIndex + 1] = pair - left;
    return { ...node, sizes };
  }
  return { ...node, children: node.children.map((c) => applyResize(c, splitId, dividerIndex, fraction)) };
}

/**
 * Pure divider-drag math shared by the main window's SplitView and the detached
 * popout (the two used to carry verbatim copies): given the pointer position
 * `pos` within a split container of extent `total` (both along the split axis,
 * px), the new size FRACTION of the child left of divider `dividerIndex`. The
 * pair sum is preserved by the caller (`applyResize` shape); neither side of the
 * dragged pair may shrink below `minPx` — when the pair is too small to fit both
 * minimums it splits evenly.
 */
export function dividerFraction(
  node: SplitNode,
  dividerIndex: number,
  pos: number,
  total: number,
  minPx: number,
): number {
  // Fraction of the whole container up to the pointer.
  const wholeFraction = Math.min(Math.max(pos / total, 0), 1);
  // Sum of sizes before this divider's left child.
  let before = 0;
  for (let i = 0; i < dividerIndex; i++) before += node.sizes[i];
  const pair = node.sizes[dividerIndex] + node.sizes[dividerIndex + 1];
  // Desired size of the left child of the pair = pointer fraction minus the
  // space taken by everything before the pair.
  const leftSize = wholeFraction - before;
  const minFrac = Math.min(minPx / total, pair / 2);
  return Math.min(Math.max(leftSize, minFrac), pair - minFrac);
}

/** Every node id in a tree — groups AND splits. Used by a popout to mint split
 *  ids that cannot collide with what it already renders (#227). */
export function allNodeIds(node: LayoutNode | null): string[] {
  if (!node) return [];
  if (node.type === "group") return [node.id];
  return [node.id, ...node.children.flatMap(allNodeIds)];
}

/** Deep-clone a layout tree, regenerating all group/split ids. */
export function regenIds(node: LayoutNode): LayoutNode {
  if (node.type === "group") {
    return { ...node, id: nextGroupId() };
  }
  return {
    ...node,
    id: nextSplitId(),
    children: node.children.map(regenIds),
  };
}

/** Replace the group `groupId` via `fn`, returning a new tree (structural). */
export function mapGroup(
  node: LayoutNode,
  groupId: string,
  fn: (g: GroupNode) => GroupNode,
): LayoutNode {
  if (node.type === "group") {
    return node.id === groupId ? fn(node) : node;
  }
  return {
    ...node,
    children: node.children.map((c) => mapGroup(c, groupId, fn)),
  };
}
