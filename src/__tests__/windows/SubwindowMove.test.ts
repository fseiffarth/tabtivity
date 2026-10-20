/**
 * Dragging a subwindow by its tab bar's grip rearranges it in the layout, like
 * a tab (`moveGroup` via `commitDrop`, drag kind "group"): an edge moves the
 * whole group — same id, same tabs — beside the target; a bar slot or a body's
 * center merges its tabs in at that slot; a drop on itself or nowhere leaves the
 * layout alone, and nothing is ever popped out into a window.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn((..._a: unknown[]) => Promise.resolve(undefined)),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { useTabsStore, findGroup, type GroupNode, type SplitNode } from "../../stores/tabs";
import { useDragStore, type TabDrag } from "../../stores/drag/drag";
import { commitDrop } from "../../components/tabs/commitDrop";

function tab(label: string) {
  return { label, cmd: "bash", cwd: "/p", kind: "shell" as const };
}

function reset() {
  invokeMock.mockClear();
  useDragStore.setState({ drag: null });
  useTabsStore.setState({
    scope: "p",
    tabsByScope: {},
    layoutByScope: {},
    focusedGroupByScope: {},
    detachedGroupsByScope: {},
    hiddenGroupsByScope: {},
    pendingRespawnByScope: {},
    tabs: [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
    fullscreenGroupId: null,
  });
}

/** A row [G(a, a2) | G(b)]. */
function twoGroups() {
  const s = () => useTabsStore.getState();
  const a = s().addTab(tab("a"));
  const a2 = s().addTab(tab("a2"));
  const b = s().addTab(tab("b"));
  s().splitWithTab(b.key, (s().layout as GroupNode).id, "right");
  const root = s().layout as SplitNode;
  return {
    a,
    a2,
    b,
    left: root.children[0] as GroupNode,
    right: root.children[1] as GroupNode,
  };
}

function groupDrag(fromGroup: string, t: Partial<TabDrag>): TabDrag {
  useDragStore.getState().startGroupDrag({ fromGroup, label: "a", pointerX: 0, pointerY: 0 });
  useDragStore.getState().setTarget({
    overGroup: null,
    edge: null,
    reorderGroup: null,
    reorderIndex: null,
    ...t,
  });
  return useDragStore.getState().drag!;
}

describe("subwindow grip drag", () => {
  beforeEach(reset);

  it("moves the whole group to the edge it is dropped on", () => {
    const { a, a2, b, left, right } = twoGroups();
    commitDrop(groupDrag(left.id, { overGroup: right.id, edge: "right" }));
    const root = useTabsStore.getState().layout as SplitNode;
    expect(root.dir).toBe("row");
    const [first, second] = root.children as GroupNode[];
    expect(first.tabKeys).toEqual([b.key]);
    expect(second.id).toBe(left.id);
    expect(second.tabKeys).toEqual([a.key, a2.key]);
    expect(useTabsStore.getState().focusedGroupId).toBe(left.id);
  });

  it("stacks the group under the target on a bottom edge", () => {
    const { b, left, right } = twoGroups();
    commitDrop(groupDrag(left.id, { overGroup: right.id, edge: "bottom" }));
    const root = useTabsStore.getState().layout as SplitNode;
    expect(root.dir).toBe("column");
    expect((root.children[0] as GroupNode).tabKeys).toEqual([b.key]);
    expect(root.children[1].id).toBe(left.id);
  });

  it("merges its tabs into a tab bar at the drop slot", () => {
    const { a, a2, b, left, right } = twoGroups();
    commitDrop(groupDrag(left.id, { reorderGroup: right.id, reorderIndex: 0 }));
    const root = useTabsStore.getState().layout as GroupNode;
    expect(root.id).toBe(right.id);
    expect(root.tabKeys).toEqual([a.key, a2.key, b.key]);
    expect(root.activeKey).toBe(left.activeKey);
  });

  it("merges into a body's center at the end", () => {
    const { a, a2, b, left, right } = twoGroups();
    commitDrop(groupDrag(left.id, { overGroup: right.id, edge: "center" }));
    expect((useTabsStore.getState().layout as GroupNode).tabKeys).toEqual([
      b.key,
      a.key,
      a2.key,
    ]);
  });

  it("stays put on itself or nowhere, and never detaches", () => {
    const { left } = twoGroups();
    const before = useTabsStore.getState().layout;
    commitDrop(groupDrag(left.id, { overGroup: left.id, edge: "right" }));
    commitDrop(groupDrag(left.id, {}));
    expect(useTabsStore.getState().layout).toBe(before);
    expect(findGroup(useTabsStore.getState().layout, left.id)).not.toBeNull();
    expect(useTabsStore.getState().detachedGroupsByScope).toEqual({});
    expect(invokeMock).not.toHaveBeenCalledWith("detach_subwindow", expect.anything());
  });
});
