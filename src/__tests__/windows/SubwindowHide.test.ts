/**
 * Hide / unhide / close a tiling subwindow (group) in the tabs store.
 *
 * Hiding is "detach minus the OS window": the group leaves `layoutByScope` and
 * is parked in `hiddenGroupsByScope`, while its tab payloads stay in
 * `tabsByScope` (so the flat pane layer keeps their PTYs mounted, hidden).
 * Covers: hide strips + parks the group and keeps payloads; hiding the last
 * group is allowed (empties the layout); unhide re-injects with regenerated ids
 * beside the focused subwindow and can restore focused on a chosen tab;
 * closeHiddenGroup discards the tabs; and the persist round-trip (snapshot →
 * loadFromLayout) restores it STILL hidden, with its user-given name, rather
 * than docked live.
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
  orderedTabKeys,
  serializeTree,
  pruneSavedTree,
  withHiddenDocked,
  type GroupNode,
  type SplitNode,
} from "../../stores/tabs";

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
    hiddenGroupsByScope: {},
    pendingRespawnByScope: {},
    tabs: [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
    fullscreenGroupId: null,
  });
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

/** Flatten every tabKey referenced by a serialized layout tree. */
function collectSavedKeys(tree: ReturnType<typeof serializeTree>): string[] {
  if (!tree) return [];
  if (tree.type === "group") return [...tree.tabKeys];
  return tree.children.flatMap(collectSavedKeys);
}

/** Find the (first) node tagged `hidden` in a serialized tree. */
function findHiddenNode(
  tree: ReturnType<typeof serializeTree>,
): NonNullable<ReturnType<typeof serializeTree>> | null {
  if (!tree) return null;
  if (tree.hidden) return tree;
  if (tree.type === "split") {
    for (const c of tree.children) {
      const hit = findHiddenNode(c);
      if (hit) return hit;
    }
  }
  return null;
}

describe("tabs store — hide / unhide subwindow", () => {
  beforeEach(reset);

  it("hide removes the group from the layout but keeps its tab payloads", () => {
    const { a, b, right } = twoGroups();
    useTabsStore.getState().hideGroup(right.id);

    const layout = useTabsStore.getState().layout as GroupNode;
    // Tree collapsed to the lone surviving group holding `a`.
    expect(layout.type).toBe("group");
    expect(layout.tabKeys).toEqual([a.key]);
    expect(findGroup(layout, right.id)).toBeNull();

    // The hidden group is recorded; b's payload survives in tabsByScope.
    const hidden = useTabsStore.getState().hiddenGroupsByScope["p"];
    expect(hidden).toHaveLength(1);
    expect(hidden[0].id).toBe(right.id);
    expect((hidden[0].subtree as GroupNode).tabKeys).toEqual([b.key]);
    expect(useTabsStore.getState().tabs.map((t) => t.key).sort()).toEqual(
      [a.key, b.key].sort(),
    );

    // Hiding never spawns an OS window (unlike detach).
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("moves focus off a hidden group onto a survivor", () => {
    const { left, right } = twoGroups();
    // Focus the group about to be hidden.
    useTabsStore.getState().focusGroup(right.id);
    useTabsStore.getState().hideGroup(right.id);
    // Focus re-picked onto the surviving group.
    expect(useTabsStore.getState().focusedGroupId).toBe(left.id);
  });

  it("allows hiding the last group (empties the layout → placeholder)", () => {
    const a = useTabsStore.getState().addTab(tab("a"));
    const gid = (useTabsStore.getState().layout as GroupNode).id;
    useTabsStore.getState().hideGroup(gid);

    // Unlike closeGroup/detachGroup's refusal, the lone group hides: layout null.
    expect(useTabsStore.getState().layout).toBeNull();
    const hidden = useTabsStore.getState().hiddenGroupsByScope["p"];
    expect(hidden).toHaveLength(1);
    expect((hidden[0].subtree as GroupNode).tabKeys).toEqual([a.key]);
    // Payload survives so the pane stays mounted (hidden) and the PTY lives.
    expect(useTabsStore.getState().tabs.map((t) => t.key)).toEqual([a.key]);
  });

  it("unhide re-injects the group with regenerated ids and clears the entry", () => {
    const { a, b, right } = twoGroups();
    useTabsStore.getState().hideGroup(right.id);

    useTabsStore.getState().unhideGroup(right.id);

    const layout = useTabsStore.getState().layout as SplitNode;
    expect(layout.type).toBe("split");
    const keys = allGroups(layout).flatMap((g) => g.tabKeys).sort();
    expect(keys).toEqual([a.key, b.key].sort());
    // The restored group's node id was regenerated (not the old right.id).
    expect(findGroup(layout, right.id)).toBeNull();
    // The hidden entry is gone; no IPC.
    expect(useTabsStore.getState().hiddenGroupsByScope["p"]).toHaveLength(0);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("unhide puts the group beside the focused subwindow, not the first", () => {
    const { a, b, left, right } = twoGroups();
    const c = useTabsStore.getState().addTab(tab("c"));
    useTabsStore.getState().splitWithTab(c.key, right.id, "right");
    const cGroup = allGroups(useTabsStore.getState().layout).find((g) =>
      g.tabKeys.includes(c.key),
    )!;
    useTabsStore.getState().hideGroup(left.id); // layout: [b, c]
    useTabsStore.getState().focusGroup(cGroup.id);

    useTabsStore.getState().unhideGroup(left.id);

    const order = allGroups(useTabsStore.getState().layout).flatMap((g) => g.tabKeys);
    expect(order).toEqual([b.key, c.key, a.key]);
  });

  it("unhide with activeKey restores focused on that tab", () => {
    // A 2-tab group [b, c] hidden whole; restore focused on c (not the first).
    const a = useTabsStore.getState().addTab(tab("a"));
    const b = useTabsStore.getState().addTab(tab("b"));
    const c = useTabsStore.getState().addTab(tab("c"));
    const rootGid = (useTabsStore.getState().layout as GroupNode).id;
    // Split [a] off so [b,c] is its own group.
    useTabsStore.getState().splitWithTab(a.key, rootGid, "right");
    const root = useTabsStore.getState().layout as SplitNode;
    const bc = root.children[0] as GroupNode; // [b, c]
    useTabsStore.getState().hideGroup(bc.id);

    useTabsStore.getState().unhideGroup(bc.id, { activeKey: c.key });

    const restored = allGroups(useTabsStore.getState().layout).find((g) =>
      g.tabKeys.includes(b.key),
    )!;
    expect(restored.tabKeys.sort()).toEqual([b.key, c.key].sort());
    expect(restored.activeKey).toBe(c.key);
  });

  it("unhide installs as root when the in-window tree emptied while hidden", () => {
    const { a, b, right } = twoGroups();
    useTabsStore.getState().hideGroup(right.id);
    // Close the remaining in-window group's tab, emptying the layout.
    useTabsStore.getState().removeTab(a.key);
    expect(useTabsStore.getState().layout).toBeNull();

    useTabsStore.getState().unhideGroup(right.id);
    const layout = useTabsStore.getState().layout as GroupNode;
    expect(layout.type).toBe("group");
    expect(layout.tabKeys).toEqual([b.key]);
  });

  it("closeHiddenGroup discards the hidden group's tabs and record", () => {
    const { a, b, right } = twoGroups();
    useTabsStore.getState().hideGroup(right.id);

    useTabsStore.getState().closeHiddenGroup(right.id);

    // The hidden record is gone and b's payload is dropped (its PTY dies when the
    // flat pane layer stops rendering the key).
    expect(useTabsStore.getState().hiddenGroupsByScope["p"] ?? []).toHaveLength(0);
    expect(useTabsStore.getState().tabs.map((t) => t.key)).toEqual([a.key]);
    void b;
  });

  it("hide/unhide/close no-op for an unknown id", () => {
    const { a } = twoGroups();
    const before = useTabsStore.getState().layout;
    useTabsStore.getState().hideGroup("missing");
    useTabsStore.getState().unhideGroup("missing");
    useTabsStore.getState().closeHiddenGroup("missing");
    expect(useTabsStore.getState().layout).toBe(before);
    expect(useTabsStore.getState().hiddenGroupsByScope["p"] ?? []).toHaveLength(0);
    void a;
  });
});

describe("tabs store — hidden-subwindow persistence", () => {
  beforeEach(reset);

  it("withHiddenDocked folds hidden groups into the tree tagged `hidden`", () => {
    const { a, b, right } = twoGroups();
    useTabsStore.getState().hideGroup(right.id);

    const layout = useTabsStore.getState().layout;
    const hidden = useTabsStore.getState().hiddenGroupsByScope["p"];
    const merged = withHiddenDocked(serializeTree(layout), hidden);

    // Both a's docked group and the hidden group's tab persist.
    expect(collectSavedKeys(merged).sort()).toEqual([a.key, b.key].sort());
    // The hidden group is tagged so restore re-parks it.
    const tagged = findHiddenNode(merged);
    expect(tagged).not.toBeNull();
    expect((tagged as { tabKeys: string[] }).tabKeys).toEqual([b.key]);
  });

  it("pruning preserves the hidden tag (restores parked, not docked)", () => {
    const { a, b, right } = twoGroups();
    useTabsStore.getState().hideGroup(right.id);
    const merged = withHiddenDocked(
      serializeTree(useTabsStore.getState().layout),
      useTabsStore.getState().hiddenGroupsByScope["p"],
    );
    const pruned = pruneSavedTree(merged, new Set([a.key, b.key]));
    expect(findHiddenNode(pruned)).not.toBeNull();
  });

  it("round-trips through snapshot → loadFromLayout still hidden", () => {
    const { a, b, right } = twoGroups();
    useTabsStore.getState().hideGroup(right.id);

    const snap = useTabsStore.getState().snapshotScopeForSwitch("p");
    const savedTabs = snap.tabs.map((t) => ({
      key: t.key,
      label: t.label,
      cmd: t.cmd,
      cwd: t.cwd,
      kind: t.kind,
    }));

    // Simulate a restart into a fresh scope.
    reset();
    useTabsStore.getState().loadFromLayout(savedTabs, "/p", "p2", snap.tabGroups ?? undefined);

    // The visible layout is only the group holding `a` (b's group stayed hidden).
    const visible = allGroups(useTabsStore.getState().layoutByScope["p2"]);
    expect(visible).toHaveLength(1);
    expect(visible[0].tabKeys.map(labelOf("p2")).sort()).toEqual(["a"]);

    // The hidden group came back parked, referencing the restored `b` tab.
    const hidden = useTabsStore.getState().hiddenGroupsByScope["p2"];
    expect(hidden).toHaveLength(1);
    const hiddenLabels = orderedTabKeys(hidden[0].subtree).map(labelOf("p2"));
    expect(hiddenLabels).toEqual(["b"]);

    void a;
    void b;
    void right;
  });

  it("a hidden group's name round-trips; a blank rename clears it", () => {
    const { right } = twoGroups();
    useTabsStore.getState().hideGroup(right.id);
    useTabsStore.getState().renameHiddenGroup(right.id, "  Builds  ");
    expect(useTabsStore.getState().hiddenGroupsByScope["p"][0].name).toBe("Builds");

    const snap = useTabsStore.getState().snapshotScopeForSwitch("p");
    const savedTabs = snap.tabs.map((t) => ({
      key: t.key,
      label: t.label,
      cmd: t.cmd,
      cwd: t.cwd,
      kind: t.kind,
    }));
    reset();
    useTabsStore.getState().loadFromLayout(savedTabs, "/p", "p2", snap.tabGroups ?? undefined);
    useTabsStore.setState({ scope: "p2" });
    const [restored] = useTabsStore.getState().hiddenGroupsByScope["p2"];
    expect(restored.name).toBe("Builds");

    useTabsStore.getState().renameHiddenGroup(restored.id, "   ");
    expect(useTabsStore.getState().hiddenGroupsByScope["p2"][0].name).toBeUndefined();
  });

  it("withHiddenDocked returns the in-window tree unchanged with no hidden groups", () => {
    twoGroups();
    const layout = serializeTree(useTabsStore.getState().layout);
    expect(withHiddenDocked(layout, [])).toBe(layout);
    expect(withHiddenDocked(layout, undefined)).toBe(layout);
  });
});

/** Resolve a tab key to its label within a scope (post-restore key remap). */
function labelOf(scope: string) {
  return (key: string) =>
    useTabsStore.getState().tabsByScope[scope]?.find((t) => t.key === key)?.label ?? key;
}
