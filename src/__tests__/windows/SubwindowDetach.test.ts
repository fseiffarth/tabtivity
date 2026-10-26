/**
 * #42: detach / re-attach a tiling subwindow (group) in the tabs store.
 *
 * Covers: detach removes the group from `layoutByScope` and records it in
 * `detachedGroupsByScope` while keeping every tab payload in `tabsByScope`;
 * attach re-injects the group with regenerated ids; the lone group can't be
 * detached; save-side pruning (`withDetachedDocked`) re-docks detached tabs so
 * they persist; and the #55 owned-keys union keeps detached tabs scope-bound.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn((..._a: unknown[]) => Promise.resolve(undefined)),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import {
  useTabsStore,
  findGroup,
  allGroups,
  pruneSavedTree,
  isDetachedPtyId,
  type GroupNode,
  type SplitNode,
} from "../../stores/tabs";
import { serializeTree, withDetachedDocked } from "../../stores/tabs/savedLayout";

function tab(label: string) {
  return { label, cmd: "bash", cwd: "/p", kind: "shell" as const };
}

function reset() {
  invokeMock.mockClear();
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

/** Find the (first) group node tagged `detached` in a serialized tree. */
function findDetachedGroup(
  tree: ReturnType<typeof serializeTree>,
): Extract<NonNullable<ReturnType<typeof serializeTree>>, { type: "group" }> | null {
  if (!tree) return null;
  if (tree.type === "group") return tree.detached ? tree : null;
  for (const c of tree.children) {
    const hit = findDetachedGroup(c);
    if (hit) return hit;
  }
  return null;
}

/** Build a 2-group row split [G(a), G(b)] and return the keys + group ids. */
function twoGroups() {
  const a = useTabsStore.getState().addTab(tab("a"));
  const b = useTabsStore.getState().addTab(tab("b"));
  const rootGid = (useTabsStore.getState().layout as GroupNode).id;
  useTabsStore.getState().splitWithTab(b.key, rootGid, "right");
  const root = useTabsStore.getState().layout as SplitNode;
  const left = root.children[0] as GroupNode; // [a]
  const right = root.children[1] as GroupNode; // [b]
  return { a, b, left, right };
}

describe("tabs store — detach / attach subwindow (#42)", () => {
  beforeEach(reset);

  it("detach removes the group from the layout but keeps its tab payloads", () => {
    const { a, b, right } = twoGroups();
    const label = useTabsStore.getState().detachGroup(right.id);
    expect(label).toBe(`detached-p-${right.id}`);

    const layout = useTabsStore.getState().layout as GroupNode;
    // Tree collapsed to the lone surviving group holding `a`.
    expect(layout.type).toBe("group");
    expect(layout.tabKeys).toEqual([a.key]);
    expect(findGroup(layout, right.id)).toBeNull();

    // The detached group is recorded; b's payload survives in tabsByScope.
    const detached = useTabsStore.getState().detachedGroupsByScope["p"];
    expect(detached).toHaveLength(1);
    expect(detached[0].id).toBe(right.id);
    expect((detached[0].subtree as GroupNode).tabKeys).toEqual([b.key]);
    expect(useTabsStore.getState().tabs.map((t) => t.key).sort()).toEqual(
      [a.key, b.key].sort(),
    );

    // The backend command fired exactly once with the right args. No restore
    // bounds for a fresh (user-initiated) detach, so geometry is null.
    expect(invokeMock).toHaveBeenCalledWith("detach_subwindow", {
      projectId: "p",
      groupId: right.id,
      x: null,
      y: null,
      width: null,
      height: null,
    });
  });

  it("keeps a popout separate when its first OS window build fails", async () => {
    const { right } = twoGroups();
    invokeMock.mockClear();
    invokeMock.mockRejectedValueOnce(new Error("display still changing"));
    vi.useFakeTimers();
    try {
      useTabsStore.getState().detachGroup(right.id);
      await Promise.resolve();
      expect(useTabsStore.getState().detachedGroupsByScope.p).toHaveLength(1);
      expect(findDetachedGroup(useTabsStore.getState().snapshotScopeForSwitch("p").tabGroups))
        .toMatchObject({ detached: true });

      await vi.advanceTimersByTimeAsync(300);
      expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "detach_subwindow")).toHaveLength(2);
      expect(useTabsStore.getState().detachedGroupsByScope.p).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flags a detached group's PTY ids so the main pane's unmount skips pty_kill", () => {
    const { b, right } = twoGroups();
    const ptyId = `p:${b.key}`;
    // Before detach the PTY is owned by the main pane → killable on unmount.
    expect(isDetachedPtyId(ptyId)).toBe(false);

    useTabsStore.getState().detachGroup(right.id);
    // Once detached, the main pane unmounts but must NOT kill the PTY — the
    // popped-out attach-only viewer is now reading it.
    expect(isDetachedPtyId(ptyId)).toBe(true);
    // A different/unknown id is unaffected; a malformed id (no scope) is false.
    expect(isDetachedPtyId("p:other")).toBe(false);
    expect(isDetachedPtyId("nocolon")).toBe(false);
  });

  it("refuses to detach the lone group", () => {
    const a = useTabsStore.getState().addTab(tab("a"));
    const gid = (useTabsStore.getState().layout as GroupNode).id;
    const label = useTabsStore.getState().detachGroup(gid);
    expect(label).toBeNull();
    // Layout untouched; nothing detached; no backend call.
    const layout = useTabsStore.getState().layout as GroupNode;
    expect(layout.tabKeys).toEqual([a.key]);
    expect(useTabsStore.getState().detachedGroupsByScope["p"] ?? []).toHaveLength(0);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("attach re-injects the group with regenerated ids and clears the entry", () => {
    const { a, b, right } = twoGroups();
    useTabsStore.getState().detachGroup(right.id);
    invokeMock.mockClear();

    useTabsStore.getState().attachGroup(right.id, { edge: "right" });

    const layout = useTabsStore.getState().layout as SplitNode;
    expect(layout.type).toBe("split");
    const groups = allGroups(layout);
    const keys = groups.flatMap((g) => g.tabKeys).sort();
    expect(keys).toEqual([a.key, b.key].sort());
    // The re-docked group's node id was regenerated (not the old right.id).
    expect(findGroup(layout, right.id)).toBeNull();
    // The detached entry is gone.
    expect(useTabsStore.getState().detachedGroupsByScope["p"]).toHaveLength(0);
    expect(invokeMock).toHaveBeenCalledWith("attach_subwindow", {
      registryId: `detached-p-${right.id}`,
    });
  });

  it("attach installs as root when the in-window tree emptied while detached", () => {
    const { a, b, left, right } = twoGroups();
    useTabsStore.getState().detachGroup(right.id, { skipBackend: true });
    // Close the remaining in-window group's tab, emptying the layout.
    useTabsStore.getState().removeTab(a.key);
    expect(useTabsStore.getState().layout).toBeNull();
    void left;

    useTabsStore.getState().attachGroup(right.id, { skipBackend: true });
    const layout = useTabsStore.getState().layout as GroupNode;
    expect(layout.type).toBe("group");
    expect(layout.tabKeys).toEqual([b.key]);
  });

  it("skipBackend suppresses the IPC call (used by message-passed re-dock)", () => {
    const { right } = twoGroups();
    useTabsStore.getState().detachGroup(right.id, { skipBackend: true });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("withDetachedDocked re-docks detached groups for persistence", () => {
    const { a, b, right } = twoGroups();
    useTabsStore.getState().detachGroup(right.id, { skipBackend: true });

    const layout = useTabsStore.getState().layout;
    const detached = useTabsStore.getState().detachedGroupsByScope["p"];
    const merged = withDetachedDocked(serializeTree(layout), detached);
    // The persisted tree must contain BOTH a's docked group and the detached
    // group's tabs — so a restart restores the detached group as docked.
    const persistedKeys = collectSavedKeys(merged);
    expect(persistedKeys.sort()).toEqual([a.key, b.key].sort());
  });

  it("save-side pruning keeps a detached group's restorable tabs", () => {
    const { a, b, right } = twoGroups();
    useTabsStore.getState().detachGroup(right.id, { skipBackend: true });
    const layout = useTabsStore.getState().layout;
    const detached = useTabsStore.getState().detachedGroupsByScope["p"];
    const merged = withDetachedDocked(serializeTree(layout), detached);
    // Both shells are restorable → both keys survive pruning.
    const keep = new Set([a.key, b.key]);
    const pruned = pruneSavedTree(merged, keep);
    expect(collectSavedKeys(pruned).sort()).toEqual([a.key, b.key].sort());
  });

  it("save-side pruning preserves the detached tag + bounds (restores as a popout)", () => {
    const { a, b, right } = twoGroups();
    useTabsStore.getState().detachGroup(right.id, { skipBackend: true });
    useTabsStore.getState().setDetachedBounds("p", right.id, { x: 10, y: 20, w: 800, h: 600 });
    const layout = useTabsStore.getState().layout;
    const detached = useTabsStore.getState().detachedGroupsByScope["p"];
    const merged = withDetachedDocked(serializeTree(layout), detached);
    // Pruning must NOT strip the detached tag/bounds, or restore would dock the
    // popout inside the main panel instead of re-opening it as a floating window.
    const pruned = pruneSavedTree(merged, new Set([a.key, b.key]));
    const tagged = findDetachedGroup(pruned);
    expect(tagged).not.toBeNull();
    expect(tagged?.bounds).toEqual({ x: 10, y: 20, w: 800, h: 600 });
  });

  it("withDetachedDocked tags the detached group with its bounds for respawn", () => {
    const { right } = twoGroups();
    useTabsStore.getState().detachGroup(right.id, { skipBackend: true });
    useTabsStore.getState().setDetachedBounds("p", right.id, { x: 10, y: 20, w: 800, h: 600 });
    const layout = useTabsStore.getState().layout;
    const detached = useTabsStore.getState().detachedGroupsByScope["p"];
    const merged = withDetachedDocked(serializeTree(layout), detached);
    const tagged = findDetachedGroup(merged);
    expect(tagged).not.toBeNull();
    expect(tagged?.bounds).toEqual({ x: 10, y: 20, w: 800, h: 600 });
  });

  it("loadFromLayout restores a detached group docked + queues it for respawn", () => {
    const { a, b, right } = twoGroups();
    useTabsStore.getState().detachGroup(right.id, { skipBackend: true });
    useTabsStore.getState().setDetachedBounds("p", right.id, { x: 5, y: 6, w: 700, h: 500 });
    const layout = useTabsStore.getState().layout;
    const detached = useTabsStore.getState().detachedGroupsByScope["p"];
    const groups = withDetachedDocked(serializeTree(layout), detached);
    const savedTabs = useTabsStore.getState().tabs.map((t) => ({
      key: t.key,
      label: t.label,
      cmd: t.cmd,
      cwd: t.cwd,
      kind: t.kind,
    }));
    void a;
    void b;

    // Simulate a restart: fresh store, load the persisted layout into a scope.
    reset();
    useTabsStore.getState().loadFromLayout(savedTabs, "/p", "p2", groups ?? undefined);

    // Both groups come back DOCKED so their panes mount + spawn PTYs first.
    const restored = allGroups(useTabsStore.getState().layoutByScope["p2"]);
    expect(restored.length).toBe(2);
    // Exactly one is queued for respawn, carrying its persisted bounds, and its
    // id matches a live group in the restored layout.
    const pending = useTabsStore.getState().consumePendingRespawn("p2");
    expect(pending.length).toBe(1);
    expect(pending[0].bounds).toEqual({ x: 5, y: 6, w: 700, h: 500 });
    expect(restored.some((g) => g.id === pending[0].id)).toBe(true);
    // Draining is idempotent.
    expect(useTabsStore.getState().consumePendingRespawn("p2")).toEqual([]);
  });

  it("allowLastGroup lets the respawn path detach the lone group (empties the layout)", () => {
    const a = useTabsStore.getState().addTab(tab("a"));
    const gid = (useTabsStore.getState().layout as GroupNode).id;

    // Without the flag the lone group can't detach (guarded above); WITH it the
    // restart respawn path detaches it, leaving the in-window layout empty.
    const label = useTabsStore.getState().detachGroup(gid, { allowLastGroup: true });
    expect(label).toBe(`detached-p-${gid}`);
    expect(useTabsStore.getState().layout).toBeNull();
    const detached = useTabsStore.getState().detachedGroupsByScope["p"];
    expect(detached).toHaveLength(1);
    expect((detached[0].subtree as GroupNode).tabKeys).toEqual([a.key]);
    expect(invokeMock).toHaveBeenCalledWith(
      "detach_subwindow",
      expect.objectContaining({ projectId: "p", groupId: gid }),
    );
  });

  it("restore re-detaches a popout that became the scope's only group", () => {
    // Saved tree: an in-window group holding a NON-restorable tab (dropped on
    // restore) plus the detached group holding a restorable tab. After the drop
    // the detached group is the lone surviving group — it must still respawn.
    const groups = {
      type: "split" as const,
      dir: "row" as const,
      sizes: [0.5, 0.5],
      children: [
        { type: "group" as const, tabKeys: ["k-dropped"], activeKey: "k-dropped" },
        {
          type: "group" as const,
          tabKeys: ["k-keep"],
          activeKey: "k-keep",
          detached: true,
          bounds: { x: 1, y: 2, w: 640, h: 480 },
        },
      ],
    };
    // Only the restorable tab is passed (the dropped tab is absent from keyMap).
    const savedTabs = [
      { key: "k-keep", label: "keep", cmd: "bash", cwd: "/p", kind: "shell" as const },
    ];

    reset();
    useTabsStore.getState().loadFromLayout(savedTabs, "/p", "p", groups);

    // The in-window group was dropped → the restored layout is the lone (docked)
    // detached group, still queued for respawn.
    const restored = allGroups(useTabsStore.getState().layoutByScope["p"]);
    expect(restored.length).toBe(1);
    const pending = useTabsStore.getState().consumePendingRespawn("p");
    expect(pending.length).toBe(1);

    // Respawn it exactly as CenterPanel does — the lone group must detach, not
    // stay docked (the regression: it used to be refused and remain in-window).
    const label = useTabsStore
      .getState()
      .detachGroup(pending[0].id, { bounds: pending[0].bounds, allowLastGroup: true });
    expect(label).not.toBeNull();
    expect(useTabsStore.getState().layout).toBeNull();
    expect(useTabsStore.getState().detachedGroupsByScope["p"]).toHaveLength(1);
  });

  it("withDetachedDocked returns the in-window tree unchanged with no detached groups", () => {
    const { a } = twoGroups();
    void a;
    const layout = serializeTree(useTabsStore.getState().layout);
    expect(withDetachedDocked(layout, [])).toBe(layout);
    expect(withDetachedDocked(layout, undefined)).toBe(layout);
  });
});

/** Flatten every tabKey referenced by a serialized layout tree. */
function collectSavedKeys(
  tree: ReturnType<typeof serializeTree>,
): string[] {
  if (!tree) return [];
  if (tree.type === "group") return [...tree.tabKeys];
  return tree.children.flatMap(collectSavedKeys);
}

describe("tabs store — drag a tab/file to another monitor → standalone window", () => {
  beforeEach(reset);

  const bounds = { x: 1920, y: 40, w: 900, h: 640 };

  it("detachTab pops one tab out of its group into its own detached window", () => {
    // One group holding [a, b]; pop `b` out to a new monitor.
    const a = useTabsStore.getState().addTab(tab("a"));
    const b = useTabsStore.getState().addTab(tab("b"));
    const gid = (useTabsStore.getState().layout as GroupNode).id;

    const label = useTabsStore.getState().detachTab(b.key, bounds);

    // Source group keeps `a`; `b` is gone from the in-window layout.
    const layout = useTabsStore.getState().layout as GroupNode;
    expect(layout.type).toBe("group");
    expect(layout.tabKeys).toEqual([a.key]);
    expect(layout.activeKey).toBe(a.key);

    // A fresh single-tab detached group references `b`; its payload survives.
    const detached = useTabsStore.getState().detachedGroupsByScope["p"];
    expect(detached).toHaveLength(1);
    expect((detached[0].subtree as GroupNode).tabKeys).toEqual([b.key]);
    expect(detached[0].bounds).toEqual(bounds);
    expect(label).toBe(`detached-p-${detached[0].id}`);
    // The new group id is distinct from the source group it left.
    expect(detached[0].id).not.toBe(gid);
    expect(useTabsStore.getState().tabs.map((t) => t.key).sort()).toEqual(
      [a.key, b.key].sort(),
    );

    expect(invokeMock).toHaveBeenCalledWith("detach_subwindow", {
      projectId: "p",
      groupId: detached[0].id,
      x: bounds.x,
      y: bounds.y,
      width: bounds.w,
      height: bounds.h,
    });
  });

  it("detachTab may empty the main center (lone tab is allowed to leave)", () => {
    const a = useTabsStore.getState().addTab(tab("a"));
    const label = useTabsStore.getState().detachTab(a.key, bounds);

    // Unlike detachGroup, the per-tab path never refuses: layout drops to null.
    expect(label).not.toBeNull();
    expect(useTabsStore.getState().layout).toBeNull();
    const detached = useTabsStore.getState().detachedGroupsByScope["p"];
    expect(detached).toHaveLength(1);
    expect((detached[0].subtree as GroupNode).tabKeys).toEqual([a.key]);
    // Payload still present so the detached window can render it.
    expect(useTabsStore.getState().tabs.map((t) => t.key)).toEqual([a.key]);
  });

  it("detachTab returns null and no-ops for an unknown tab key", () => {
    useTabsStore.getState().addTab(tab("a"));
    const before = useTabsStore.getState().layout;
    const label = useTabsStore.getState().detachTab("missing", bounds);
    expect(label).toBeNull();
    expect(useTabsStore.getState().layout).toBe(before);
    expect(useTabsStore.getState().detachedGroupsByScope["p"] ?? []).toHaveLength(0);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("detachNewTab mints a tab straight into a standalone window, layout untouched", () => {
    const a = useTabsStore.getState().addTab(tab("a"));
    const beforeLayout = useTabsStore.getState().layout;

    const label = useTabsStore.getState().detachNewTab(
      { label: "doc.pdf", cmd: "", cwd: "/p", kind: "embed", embedPath: "/p/doc.pdf" },
      bounds,
    );

    // The in-window layout is completely unaffected.
    expect(useTabsStore.getState().layout).toBe(beforeLayout);

    const detached = useTabsStore.getState().detachedGroupsByScope["p"];
    expect(detached).toHaveLength(1);
    expect(label).toBe(`detached-p-${detached[0].id}`);
    const newKey = (detached[0].subtree as GroupNode).tabKeys[0];
    expect(newKey).not.toBe(a.key);

    // The fresh tab payload is in tabsByScope, scope-stamped, embed kind.
    const newTab = useTabsStore.getState().tabs.find((t) => t.key === newKey);
    expect(newTab).toMatchObject({ label: "doc.pdf", kind: "embed", scope: "p" });

    expect(invokeMock).toHaveBeenCalledWith("detach_subwindow", {
      projectId: "p",
      groupId: detached[0].id,
      x: bounds.x,
      y: bounds.y,
      width: bounds.w,
      height: bounds.h,
    });
  });
});

describe("tabs store — dock a single popout tab back (#42 attachDetachedTab)", () => {
  beforeEach(reset);

  // Build [G1=[b,c] (detached), G2=[a] (live)] and return ids + keys.
  function setup() {
    const a = useTabsStore.getState().addTab(tab("a"));
    const b = useTabsStore.getState().addTab(tab("b"));
    const c = useTabsStore.getState().addTab(tab("c")); // G1=[a,b,c]
    const rootGid = (useTabsStore.getState().layout as GroupNode).id;
    useTabsStore.getState().splitWithTab(a.key, rootGid, "right"); // G1=[b,c], new=[a]
    const root = useTabsStore.getState().layout as SplitNode;
    const left = root.children[0] as GroupNode; // [b,c]
    const right = root.children[1] as GroupNode; // [a]
    useTabsStore.getState().detachGroup(left.id); // detach [b,c]
    invokeMock.mockClear();
    return { a, b, c, g1: left.id, g2: right.id };
  }

  it("center-merges a popout tab into a live group and drops it from the subtree", () => {
    const { a, b, c, g1, g2 } = setup();
    useTabsStore.getState().attachDetachedTab("p", g1, b.key, {
      targetGroupId: g2,
      edge: "center",
    });

    // b joined G2 (now the lone surviving in-window group) and is active.
    const layout = useTabsStore.getState().layout as GroupNode;
    expect(layout.type).toBe("group");
    expect(layout.tabKeys).toEqual([a.key, b.key]);
    expect(layout.activeKey).toBe(b.key);

    // The popout keeps c; every payload survives. Window stays open.
    const det = useTabsStore.getState().detachedGroupsByScope["p"];
    expect(det).toHaveLength(1);
    expect((det[0].subtree as GroupNode).tabKeys).toEqual([c.key]);
    expect(useTabsStore.getState().tabs.map((t) => t.key).sort()).toEqual(
      [a.key, b.key, c.key].sort(),
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("edge-splits a popout tab off into a new in-window group", () => {
    const { b, g1, g2 } = setup();
    useTabsStore.getState().attachDetachedTab("p", g1, b.key, {
      targetGroupId: g2,
      edge: "right",
    });
    const root = useTabsStore.getState().layout as SplitNode;
    expect(root.type).toBe("split");
    expect(root.dir).toBe("row");
    // b lives in its own fresh group beside G2.
    const groups = allGroups(root);
    expect(groups.some((g) => g.tabKeys.includes(b.key))).toBe(true);
  });

  it("default placement (no target) merges into the first group", () => {
    const { a, b, g1 } = setup();
    useTabsStore.getState().attachDetachedTab("p", g1, b.key);
    const layout = useTabsStore.getState().layout as GroupNode;
    expect(layout.tabKeys).toEqual([a.key, b.key]);
  });

  it("closes the popout once its last tab is docked away", () => {
    const { b, c, g1, g2 } = setup();
    useTabsStore.getState().attachDetachedTab("p", g1, b.key, {
      targetGroupId: g2,
      edge: "center",
    });
    invokeMock.mockClear();
    // Docking the last remaining tab empties + closes the popout.
    useTabsStore.getState().attachDetachedTab("p", g1, c.key, {
      targetGroupId: g2,
      edge: "center",
    });
    expect(useTabsStore.getState().detachedGroupsByScope["p"]).toHaveLength(0);
    expect(invokeMock).toHaveBeenCalledWith("attach_subwindow", {
      registryId: `detached-p-${g1}`,
    });
  });

  it("no-ops for an unknown group or a tab not in the popout", () => {
    const { b, g1, g2 } = setup();
    const before = useTabsStore.getState().layout;
    useTabsStore.getState().attachDetachedTab("p", "missing", b.key);
    useTabsStore.getState().attachDetachedTab("p", g1, "missing", {
      targetGroupId: g2,
    });
    expect(useTabsStore.getState().layout).toBe(before);
    expect((useTabsStore.getState().detachedGroupsByScope["p"][0].subtree as GroupNode).tabKeys)
      .toEqual([b.key, useTabsStore.getState().tabs.find((t) => t.label === "c")!.key]);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("tabs store — dock a main-window tab INTO a popout (#42 dockTabIntoDetached)", () => {
  beforeEach(reset);

  // Build [G1=[b,c] (detached), G2=[a] (live)] and return ids + keys. Mirrors the
  // attachDetachedTab setup; here a live tab is dragged INTO the popout instead.
  function setup() {
    const a = useTabsStore.getState().addTab(tab("a"));
    const b = useTabsStore.getState().addTab(tab("b"));
    const c = useTabsStore.getState().addTab(tab("c")); // G1=[a,b,c]
    const rootGid = (useTabsStore.getState().layout as GroupNode).id;
    useTabsStore.getState().splitWithTab(a.key, rootGid, "right"); // G1=[b,c], new=[a]
    const root = useTabsStore.getState().layout as SplitNode;
    const left = root.children[0] as GroupNode; // [b,c]
    const right = root.children[1] as GroupNode; // [a]
    useTabsStore.getState().detachGroup(left.id); // detach [b,c]
    invokeMock.mockClear();
    return { a, b, c, g1: left.id, g2: right.id };
  }

  it("moves a live tab into the popout's group, activates it, and keeps payloads", () => {
    const { a, b, c, g1 } = setup();
    useTabsStore.getState().dockTabIntoDetached("p", g1, a.key);

    // a is appended to the popout's subtree and is the popout's active tab.
    const det = useTabsStore.getState().detachedGroupsByScope["p"];
    expect(det).toHaveLength(1);
    expect((det[0].subtree as GroupNode).tabKeys).toEqual([b.key, c.key, a.key]);
    expect((det[0].subtree as GroupNode).activeKey).toBe(a.key);

    // G2 emptied → the main center has no layout, but every payload survives so
    // the popout (and the main's hidden-but-mounted pane) keep the PTY alive.
    expect(useTabsStore.getState().layout).toBeNull();
    expect(useTabsStore.getState().tabs.map((t) => t.key).sort()).toEqual(
      [a.key, b.key, c.key].sort(),
    );
    // No backend call — docking into an existing popout opens no window.
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("leaves the source group intact when other tabs remain in it", () => {
    const { a, g1 } = setup();
    const d = useTabsStore.getState().addTab(tab("d")); // joins the focused G2 → [a,d]
    useTabsStore.getState().dockTabIntoDetached("p", g1, a.key);

    // Source group keeps d; the popout gained a.
    const layout = useTabsStore.getState().layout as GroupNode;
    expect(layout.type).toBe("group");
    expect(layout.tabKeys).toEqual([d.key]);
    const popoutKeys = (useTabsStore.getState().detachedGroupsByScope["p"][0]
      .subtree as GroupNode).tabKeys;
    expect(popoutKeys[popoutKeys.length - 1]).toBe(a.key);
  });

  it("no-ops for an unknown popout, a foreign tab, or a tab already in the popout", () => {
    const { a, b, g1 } = setup();
    const before = useTabsStore.getState().layout;
    const subBefore =
      (useTabsStore.getState().detachedGroupsByScope["p"][0].subtree as GroupNode).tabKeys;
    useTabsStore.getState().dockTabIntoDetached("p", "missing", a.key);
    useTabsStore.getState().dockTabIntoDetached("p", g1, "nope");
    useTabsStore.getState().dockTabIntoDetached("p", g1, b.key); // already in popout
    expect(useTabsStore.getState().layout).toBe(before);
    expect(
      (useTabsStore.getState().detachedGroupsByScope["p"][0].subtree as GroupNode).tabKeys,
    ).toBe(subBefore);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  // #42: docking into a SPLIT (multi-pane) popout targets the resolved pane, not
  // always the first one. Turn the popout [b,c] into a 2-pane split [b] | [c].
  function splitSetup() {
    const ids = setup(); // popout g1=[b,c]
    useTabsStore.getState().splitDetachedGroup("p", ids.g1, ids.c.key, ids.g1, "right");
    const sub = useTabsStore.getState().detachedGroupsByScope["p"][0].subtree as SplitNode;
    const paneB = sub.children[0] as GroupNode; // [b] (keeps g1)
    const paneC = sub.children[1] as GroupNode; // [c] (fresh id)
    invokeMock.mockClear();
    return { ...ids, paneB: paneB.id, paneC: paneC.id };
  }

  it("docks into the SPECIFIC pane (center merge), not the first one", () => {
    const { a, c, paneC } = splitSetup();
    const popoutId = useTabsStore.getState().detachedGroupsByScope["p"][0].id;
    useTabsStore.getState().dockTabIntoDetached("p", popoutId, a.key, {
      groupId: paneC,
      edge: "center",
    });
    const sub = useTabsStore.getState().detachedGroupsByScope["p"][0].subtree as SplitNode;
    const cPane = sub.children.find((g) => (g as GroupNode).id === paneC) as GroupNode;
    expect(cPane.tabKeys).toEqual([c.key, a.key]); // merged into the c-pane, active
    expect(cPane.activeKey).toBe(a.key);
  });

  it("docks at a body EDGE → carves a new pane in the popout", () => {
    const { a, paneB } = splitSetup();
    const popoutId = useTabsStore.getState().detachedGroupsByScope["p"][0].id;
    useTabsStore.getState().dockTabIntoDetached("p", popoutId, a.key, {
      groupId: paneB,
      edge: "bottom",
    });
    // The popout now has 3 panes (b | c, with b split into b/a vertically); a sits
    // alone in its own fresh group and is active there.
    const sub = useTabsStore.getState().detachedGroupsByScope["p"][0].subtree as SplitNode;
    const aGroup = allGroupsOf(sub).find((g) => g.tabKeys.includes(a.key))!;
    expect(aGroup.tabKeys).toEqual([a.key]);
    expect(aGroup.activeKey).toBe(a.key);
  });

  it("docks at a bar SLOT (index) → inserts into that pane at the slot", () => {
    const { a, c, paneC } = splitSetup();
    const popoutId = useTabsStore.getState().detachedGroupsByScope["p"][0].id;
    useTabsStore.getState().dockTabIntoDetached("p", popoutId, a.key, { groupId: paneC, index: 0 });
    const sub = useTabsStore.getState().detachedGroupsByScope["p"][0].subtree as SplitNode;
    const cPane = sub.children.find((g) => (g as GroupNode).id === paneC) as GroupNode;
    expect(cPane.tabKeys).toEqual([a.key, c.key]); // inserted before c
  });
});

/** Flatten every group in a subtree (test-local; mirrors allGroups). */
function allGroupsOf(node: SplitNode | GroupNode): GroupNode[] {
  if (node.type === "group") return [node];
  return node.children.flatMap((c) => allGroupsOf(c as SplitNode | GroupNode));
}
