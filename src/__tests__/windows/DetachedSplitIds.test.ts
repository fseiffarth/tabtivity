/**
 * A pane split made INSIDE a popout is applied twice — optimistically in the
 * popout (`applyEditToSubtree`) and in the main store (`applyDetachedEdit`) —
 * and each window has its own id counter. Left to mint independently, the two
 * named the new pane differently, so anything the popout later said about that
 * pane by id (the drop target it reported for a file dragged over it, a divider
 * resize) addressed a group the main store did not have: a file dropped on the
 * pane split off inside a popout landed in the OTHER pane or nowhere. The popout
 * now mints the ids and ships them in the edit; both sides adopt them.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(undefined) }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: () => Promise.resolve(),
  listen: () => Promise.resolve(() => {}),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ WebviewWindow: {} }));

import { applyEditToSubtree, mintDetachedSplitIds, type DetachedEdit } from "../../stores/detached";
import {
  findGroupOfTab,
  useTabsStore,
  type GroupNode,
  type SplitNode,
} from "../../stores/tabs";
import { splitSubtree } from "../../stores/tabs/layoutTree";

function shell(label: string) {
  return { label, cmd: "bash", cwd: "/p", kind: "shell" as const };
}

// Main window: popout = [b, c] detached; [a] stays in-window.
function setup() {
  useTabsStore.setState({
    scope: "p",
    tabsByScope: {},
    layoutByScope: {},
    focusedGroupByScope: {},
    detachedGroupsByScope: {},
    tabs: [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
  });
  useTabsStore.getState().setScope("p");
  const a = useTabsStore.getState().addTab(shell("a"));
  const b = useTabsStore.getState().addTab(shell("b"));
  const c = useTabsStore.getState().addTab(shell("c"));
  const rootGid = (useTabsStore.getState().layout as GroupNode).id;
  useTabsStore.getState().splitWithTab(a.key, rootGid, "right");
  const root = useTabsStore.getState().layout as SplitNode;
  useTabsStore.getState().detachGroup((root.children[0] as GroupNode).id);
  const entry = useTabsStore.getState().detachedGroupsByScope["p"][0];
  return { a, b, c, entry };
}

describe("popout-side split ids are shared with the main store", () => {
  it("both windows name the new pane and its wrapping split identically", () => {
    const { b, entry } = setup();
    const origPane = (entry.subtree as GroupNode).id;
    const ids = mintDetachedSplitIds(entry.label);
    const edit: DetachedEdit = {
      kind: "split",
      key: b.key,
      targetGroupId: origPane,
      edge: "left",
      newGroupId: ids.groupId,
      newSplitId: ids.splitId,
    };

    // The popout's optimistic copy…
    const popoutTree = applyEditToSubtree(entry.subtree, edit) as SplitNode;
    // …and the main store's copy of the same edit.
    useTabsStore.getState().applyDetachedEdit("p", entry.id, edit);
    const mainTree = useTabsStore.getState().detachedGroupsByScope["p"][0].subtree as SplitNode;

    expect(popoutTree.type).toBe("split");
    expect(mainTree.type).toBe("split");
    expect(popoutTree.id).toBe(ids.splitId);
    expect(mainTree.id).toBe(ids.splitId);
    const popoutNew = popoutTree.children[0] as GroupNode;
    const mainNew = mainTree.children[0] as GroupNode;
    expect(popoutNew.id).toBe(ids.groupId);
    expect(mainNew.id).toBe(ids.groupId);
    expect(mainNew.tabKeys).toEqual([b.key]);
  });

  it("a drop targeting the pane BY THE POPOUT'S ID lands in that pane", () => {
    const { b, c, entry } = setup();
    const origPane = (entry.subtree as GroupNode).id;
    const ids = mintDetachedSplitIds(entry.label);
    useTabsStore.getState().applyDetachedEdit("p", entry.id, {
      kind: "split",
      key: b.key,
      targetGroupId: origPane,
      edge: "left",
      newGroupId: ids.groupId,
      newSplitId: ids.splitId,
    });
    // A tab from the main window dropped on the NEW (left) pane's centre — the
    // target id is what the popout reports from its own tree.
    const d = useTabsStore.getState().addTab(shell("d"));
    useTabsStore
      .getState()
      .dockTabIntoDetached("p", entry.id, d.key, { groupId: ids.groupId, edge: "center" });
    const sub = useTabsStore.getState().detachedGroupsByScope["p"][0].subtree;
    const home = findGroupOfTab(sub, d.key)!;
    expect(home.group.id).toBe(ids.groupId);
    expect(home.group.tabKeys).toEqual([b.key, d.key]);
    expect(findGroupOfTab(sub, c.key)!.group.id).toBe(origPane);
  });

  it("a divider resize addressed by the popout's split id reaches the main store", () => {
    const { b, entry } = setup();
    const origPane = (entry.subtree as GroupNode).id;
    const ids = mintDetachedSplitIds(entry.label);
    useTabsStore.getState().applyDetachedEdit("p", entry.id, {
      kind: "split",
      key: b.key,
      targetGroupId: origPane,
      edge: "left",
      newGroupId: ids.groupId,
      newSplitId: ids.splitId,
    });
    useTabsStore.getState().applyDetachedEdit("p", entry.id, {
      kind: "resize",
      splitId: ids.splitId,
      dividerIndex: 0,
      fraction: 0.25,
    });
    const sub = useTabsStore.getState().detachedGroupsByScope["p"][0].subtree as SplitNode;
    expect(sub.sizes[0]).toBeCloseTo(0.25);
  });

  it("ignores a supplied id the tree already carries (mints a fresh one instead)", () => {
    const { b, entry } = setup();
    const origPane = (entry.subtree as GroupNode).id;
    const out = splitSubtree(entry.subtree, b.key, origPane, "left", {
      groupId: origPane, // collides with the existing pane
      splitId: origPane,
    }) as SplitNode;
    const newPane = out.children[0] as GroupNode;
    expect(newPane.id).not.toBe(origPane);
    expect(out.id).not.toBe(origPane);
    expect(out.id).not.toBe(newPane.id);
  });

  it("mints ids namespaced by the popout label, distinct per call", () => {
    const x = mintDetachedSplitIds("detached-p-g-3");
    const y = mintDetachedSplitIds("detached-p-g-3");
    expect(x.groupId).toContain("detached-p-g-3");
    expect(x.groupId).not.toBe(y.groupId);
    expect(x.splitId).not.toBe(x.groupId);
  });
});
