/**
 * Multi-pane popouts — Phase 1 (store foundation): splitting a tab INSIDE a
 * detached popout turns its single-group `subtree` into a split tree, mirroring
 * the main window's `splitWithTab` but mutating the detached record. Also guards
 * the single-group invariant is no longer assumed (the subtree is a LayoutNode).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  useTabsStore,
  allGroups,
  orderedTabKeys,
  type GroupNode,
  type SplitNode,
  type SavedLayoutTree,
} from "../../stores/tabs";
import { splitSubtree } from "../../stores/tabs/layoutTree";
import { withDetachedDocked } from "../../stores/tabs/savedLayout";
import { applyEditToSubtree } from "../../stores/detached";

/** Collect every tab key referenced by a serialized tree. */
function savedKeys(tree: SavedLayoutTree | null): string[] {
  if (!tree) return [];
  if (tree.type === "group") return tree.tabKeys;
  return tree.children.flatMap(savedKeys);
}

function tab(label: string) {
  return { label, cmd: "bash", cwd: "/p", kind: "shell" as const };
}

function reset() {
  useTabsStore.setState({
    scope: "p",
    tabsByScope: {},
    layoutByScope: {},
    focusedGroupByScope: {},
    detachedGroupsByScope: {},
    pendingRespawnByScope: {},
    tabs: [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
  });
}

const s = () => useTabsStore.getState();

/** Detach a 2-tab group [a,b] into a popout, leaving another group behind so the
 *  detach is allowed (a lone group can't detach). Returns the popout record. */
function popoutWithTwoTabs() {
  const a = s().addTab(tab("a"));
  const b = s().addTab(tab("b"));
  const lid = (s().layout as GroupNode).id;
  const c = s().addTab(tab("c"));
  s().splitWithTab(c.key, lid, "right"); // L=[a,b], R=[c]
  const label = s().detachGroup(lid, { skipBackend: true });
  expect(label).toBeTruthy();
  const det = s().detachedGroupsByScope["p"][0];
  expect(det.subtree.type).toBe("group");
  expect((det.subtree as GroupNode).tabKeys).toEqual([a.key, b.key]);
  return { a, b, c, det };
}

describe("tabs store — split inside a detached popout", () => {
  beforeEach(reset);

  it("turns the popout's single-group subtree into a 2-pane split", () => {
    const { a, b, det } = popoutWithTwoTabs();
    const groupId = det.subtree.id;

    s().splitDetachedGroup("p", det.id, b.key, groupId, "right");

    const det2 = s().detachedGroupsByScope["p"][0];
    expect(det2.id).toBe(det.id); // popout identity unchanged
    expect(det2.subtree.type).toBe("split");
    const split = det2.subtree as SplitNode;
    expect(split.dir).toBe("row");
    expect(split.children).toHaveLength(2);
    const [g1, g2] = split.children as GroupNode[];
    expect(g1.tabKeys).toEqual([a.key]);
    expect(g2.tabKeys).toEqual([b.key]);
    // Both tabs still belong to the popout (nothing leaked to the main layout).
    expect(orderedTabKeys(det2.subtree).sort()).toEqual([a.key, b.key].sort());
    expect(s().detachedGroupsByScope["p"]).toHaveLength(1);
  });

  it("splits along the column axis for a top/bottom edge", () => {
    const { a, b, det } = popoutWithTwoTabs();
    s().splitDetachedGroup("p", det.id, b.key, det.subtree.id, "bottom");
    const split = s().detachedGroupsByScope["p"][0].subtree as SplitNode;
    expect(split.dir).toBe("column");
    const [g1, g2] = split.children as GroupNode[];
    expect(g1.tabKeys).toEqual([a.key]); // original stays first (top)
    expect(g2.tabKeys).toEqual([b.key]); // new pane below
  });

  it("is a no-op when splitting a group's only tab onto its own edge", () => {
    const { a, b, det } = popoutWithTwoTabs();
    // First split → two single-tab panes.
    s().splitDetachedGroup("p", det.id, b.key, det.subtree.id, "right");
    const split = s().detachedGroupsByScope["p"][0].subtree as SplitNode;
    const paneA = (split.children as GroupNode[]).find((g) => g.tabKeys[0] === a.key)!;
    // Splitting paneA's lone tab onto paneA's own edge must do nothing.
    s().splitDetachedGroup("p", det.id, a.key, paneA.id, "left");
    const after = s().detachedGroupsByScope["p"][0].subtree as SplitNode;
    expect(allGroups(after)).toHaveLength(2);
  });

  it("a 'split' DetachedEdit streamed from the popout splits the host's record", () => {
    const { a, b, det } = popoutWithTwoTabs();
    s().applyDetachedEdit("p", det.id, {
      kind: "split",
      key: b.key,
      targetGroupId: det.subtree.id,
      edge: "right",
    });
    const sub = s().detachedGroupsByScope["p"][0].subtree as SplitNode;
    expect(sub.type).toBe("split");
    expect((sub.children as GroupNode[]).map((g) => g.tabKeys)).toEqual([[a.key], [b.key]]);
  });
});

describe("detached — split via applyEditToSubtree (popout-local, pure)", () => {
  it("splits a single-group subtree into a 2-pane tree", () => {
    const g: GroupNode = { type: "group", id: "g1", tabKeys: ["a", "b"], activeKey: "a" };
    const next = applyEditToSubtree(g, {
      kind: "split",
      key: "b",
      targetGroupId: "g1",
      edge: "bottom",
    }) as SplitNode;
    expect(next.type).toBe("split");
    expect(next.dir).toBe("column");
    expect((next.children as GroupNode[]).map((c) => c.tabKeys)).toEqual([["a"], ["b"]]);
  });

  it("matches the pure splitSubtree helper for the same inputs", () => {
    const g: GroupNode = { type: "group", id: "g1", tabKeys: ["a", "b"], activeKey: "a" };
    const viaHelper = splitSubtree(g, "b", "g1", "right") as SplitNode;
    expect(viaHelper.type).toBe("split");
    expect(orderedTabKeys(viaHelper).sort()).toEqual(["a", "b"]);
  });
});

describe("detached — split popout persistence (respawns detached on restart)", () => {
  beforeEach(reset);

  it("tags the split popout detached so restore re-opens it as a floating window", () => {
    const { a, b, det } = popoutWithTwoTabs();
    s().splitDetachedGroup("p", det.id, b.key, det.subtree.id, "right");
    const split = s().detachedGroupsByScope["p"][0];

    const saved = withDetachedDocked(null, [split]);
    // Both tabs are referenced by the saved tree → they persist across a restart.
    expect(savedKeys(saved).sort()).toEqual([a.key, b.key].sort());
    // The split structure is preserved AND tagged detached (with its bounds) so
    // the respawn path re-detaches the whole subtree rather than docking it.
    expect(saved?.type).toBe("split");
    expect(saved?.type === "split" ? saved.detached : undefined).toBe(true);
  });
});
