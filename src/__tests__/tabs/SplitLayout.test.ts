/**
 * Tests for the tiling split-subwindow layout model in the tabs store
 * (docs/split_subwindows_plan.md). Covers split injection on all four edges,
 * 50/50 sizing, empty-group collapse on removeTab/move, resizeSplit, moveTab,
 * and legacy (no `groups`) load → single root group.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  useTabsStore,
  findGroup,
  findGroupOfTab,
  allGroups,
  type GroupNode,
  type SplitNode,
  type LayoutNode,
} from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";

function tab(label: string) {
  return { label, cmd: "bash", cwd: "/p", kind: "shell" as const };
}

function reset() {
  // These cases pin the collapse; the kept-empty default has its own block.
  useSettingsStore.setState({ settings: { close_subwindow_on_last_tab: true } });
  useTabsStore.setState({
    scope: "p",
    tabsByScope: {},
    layoutByScope: {},
    focusedGroupByScope: {},
    tabs: [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
  });
}

function rootGroupId() {
  return (useTabsStore.getState().layout as GroupNode).id;
}

describe("tabs store — split layout", () => {
  beforeEach(reset);

  it("addTab into an empty scope creates a root group", () => {
    const a = useTabsStore.getState().addTab(tab("a"));
    const layout = useTabsStore.getState().layout as GroupNode;
    expect(layout.type).toBe("group");
    expect(layout.tabKeys).toEqual([a.key]);
    expect(layout.activeKey).toBe(a.key);
    expect(useTabsStore.getState().focusedGroupId).toBe(layout.id);
  });

  it("addTab adds into the focused group", () => {
    const a = useTabsStore.getState().addTab(tab("a"));
    const b = useTabsStore.getState().addTab(tab("b"));
    const layout = useTabsStore.getState().layout as GroupNode;
    expect(layout.tabKeys).toEqual([a.key, b.key]);
    expect(layout.activeKey).toBe(b.key);
  });

  describe("splitWithTab edges", () => {
    function twoTabsThenSplit(edge: "left" | "right" | "top" | "bottom") {
      const a = useTabsStore.getState().addTab(tab("a"));
      const b = useTabsStore.getState().addTab(tab("b"));
      const gid = rootGroupId();
      useTabsStore.getState().splitWithTab(b.key, gid, edge);
      return { a, b, gid };
    }

    it("right → row split, new group after target", () => {
      const { a, b } = twoTabsThenSplit("right");
      const root = useTabsStore.getState().layout as SplitNode;
      expect(root.type).toBe("split");
      expect(root.dir).toBe("row");
      expect(root.children.length).toBe(2);
      const [first, second] = root.children as GroupNode[];
      expect(first.tabKeys).toEqual([a.key]); // original target
      expect(second.tabKeys).toEqual([b.key]); // new, to the right
      expect(root.sizes).toEqual([0.5, 0.5]);
    });

    it("left → row split, new group before target", () => {
      const { a, b } = twoTabsThenSplit("left");
      const root = useTabsStore.getState().layout as SplitNode;
      expect(root.dir).toBe("row");
      const [first, second] = root.children as GroupNode[];
      expect(first.tabKeys).toEqual([b.key]); // new, to the left
      expect(second.tabKeys).toEqual([a.key]);
    });

    it("bottom → column split, new group below target", () => {
      const { a, b } = twoTabsThenSplit("bottom");
      const root = useTabsStore.getState().layout as SplitNode;
      expect(root.dir).toBe("column");
      const [first, second] = root.children as GroupNode[];
      expect(first.tabKeys).toEqual([a.key]);
      expect(second.tabKeys).toEqual([b.key]); // new, below
    });

    it("top → column split, new group above target", () => {
      const { a, b } = twoTabsThenSplit("top");
      const root = useTabsStore.getState().layout as SplitNode;
      expect(root.dir).toBe("column");
      const [first, second] = root.children as GroupNode[];
      expect(first.tabKeys).toEqual([b.key]); // new, above
      expect(second.tabKeys).toEqual([a.key]);
    });

    it("focuses the freshly split-off group", () => {
      const { b } = twoTabsThenSplit("right");
      const focused = useTabsStore.getState().focusedGroupId;
      const fg = findGroup(useTabsStore.getState().layout, focused!);
      expect(fg!.tabKeys).toEqual([b.key]);
    });

    it("edge 'center' is equivalent to moveTab (no new split)", () => {
      const a = useTabsStore.getState().addTab(tab("a"));
      const b = useTabsStore.getState().addTab(tab("b"));
      // First split b off to the right so there are two groups.
      const gid = rootGroupId();
      useTabsStore.getState().splitWithTab(b.key, gid, "right");
      const root = useTabsStore.getState().layout as SplitNode;
      const leftGroup = root.children[0] as GroupNode;
      // Now drop b back onto the left group's center → it merges in.
      useTabsStore.getState().splitWithTab(b.key, leftGroup.id, "center");
      const merged = useTabsStore.getState().layout as GroupNode;
      expect(merged.type).toBe("group"); // split collapsed back to a single group
      expect(merged.tabKeys.sort()).toEqual([a.key, b.key].sort());
    });

    it("splitting the lone tab of the target group is a no-op", () => {
      const a = useTabsStore.getState().addTab(tab("a"));
      const gid = rootGroupId();
      useTabsStore.getState().splitWithTab(a.key, gid, "right");
      const layout = useTabsStore.getState().layout as GroupNode;
      expect(layout.type).toBe("group");
      expect(layout.tabKeys).toEqual([a.key]);
    });
  });

  it("removeTab from a focused group inside a 3-way split keeps focus valid", () => {
    // Build a 3-way row split: [G(a), G(b), G(c)].
    useTabsStore.getState().addTab(tab("a"));
    const b = useTabsStore.getState().addTab(tab("b"));
    const c = useTabsStore.getState().addTab(tab("c"));
    const gid = rootGroupId();
    useTabsStore.getState().splitWithTab(b.key, gid, "right"); // a | b
    // Re-find the last group and split c off it to the right → 3 leaf groups.
    const split2Groups = allGroups(useTabsStore.getState().layout);
    const lastGroup = split2Groups[split2Groups.length - 1];
    useTabsStore.getState().splitWithTab(c.key, lastGroup.id, "right");
    const threeWay = useTabsStore.getState().layout;
    expect(allGroups(threeWay).length).toBe(3);

    // Focus the middle group, then remove its only tab.
    const groups = allGroups(threeWay);
    const middle = groups[1];
    const middleKey = middle.tabKeys[0];
    useTabsStore.getState().focusGroup(middle.id);
    expect(useTabsStore.getState().focusedGroupId).toBe(middle.id);

    useTabsStore.getState().removeTab(middleKey);
    const after = useTabsStore.getState().layout;
    // The emptied middle group collapsed out; two groups remain.
    expect(allGroups(after).length).toBe(2);
    // Focus must point at a surviving group, never the removed one.
    const focus = useTabsStore.getState().focusedGroupId;
    expect(focus).not.toBe(middle.id);
    expect(findGroup(after, focus!)).toBeTruthy();
    // The mirrored per-scope focus map must also be a live group.
    const scope = useTabsStore.getState().scope;
    const mapped = useTabsStore.getState().focusedGroupByScope[scope];
    expect(findGroup(after, mapped!)).toBeTruthy();
    // activeKey resolves to the surviving focused group's active tab.
    const fg = findGroup(after, focus!)!;
    expect(useTabsStore.getState().activeKey).toBe(fg.activeKey);
  });

  it("removeTab of a non-focused group's tab preserves the existing focus", () => {
    const a = useTabsStore.getState().addTab(tab("a"));
    const b = useTabsStore.getState().addTab(tab("b"));
    const gid = rootGroupId();
    useTabsStore.getState().splitWithTab(b.key, gid, "right");
    // Focus the group holding a, then remove b (the other, non-focused group).
    const aGroup = findGroupOfTab(useTabsStore.getState().layout, a.key)!.group;
    useTabsStore.getState().focusGroup(aGroup.id);
    useTabsStore.getState().removeTab(b.key);
    // Focus stayed on a's group (now the lone root group).
    const layout = useTabsStore.getState().layout as GroupNode;
    expect(layout.tabKeys).toEqual([a.key]);
    expect(useTabsStore.getState().focusedGroupId).toBe(layout.id);
  });

  it("resizeSplit on a 3-way split adjusts only the targeted divider pair", () => {
    const a = useTabsStore.getState().addTab(tab("a"));
    const b = useTabsStore.getState().addTab(tab("b"));
    const c = useTabsStore.getState().addTab(tab("c"));
    const gid = rootGroupId();
    useTabsStore.getState().splitWithTab(b.key, gid, "right");
    const grps = allGroups(useTabsStore.getState().layout);
    const last = grps[grps.length - 1];
    useTabsStore.getState().splitWithTab(c.key, last.id, "right");
    void a;
    const split = useTabsStore.getState().layout as SplitNode;
    expect(split.children.length).toBe(3);
    expect(split.sizes.length).toBe(3);
    const before = [...split.sizes];
    // Resize the SECOND divider (index 1) → only sizes[1] and sizes[2] change.
    useTabsStore.getState().resizeSplit(split.id, 1, before[1] + 0.1);
    const after = useTabsStore.getState().layout as SplitNode;
    expect(after.sizes[0]).toBeCloseTo(before[0]); // untouched
    expect(after.sizes[1] + after.sizes[2]).toBeCloseTo(before[1] + before[2]);
    expect(after.sizes.reduce((x, y) => x + y, 0)).toBeCloseTo(1);
  });

  it("resizeSplit ignores an out-of-range divider index", () => {
    const a = useTabsStore.getState().addTab(tab("a"));
    const b = useTabsStore.getState().addTab(tab("b"));
    void a;
    const gid = rootGroupId();
    useTabsStore.getState().splitWithTab(b.key, gid, "right");
    const split = useTabsStore.getState().layout as SplitNode;
    const before = [...split.sizes];
    useTabsStore.getState().resizeSplit(split.id, 5, 0.7); // no divider 5
    const after = useTabsStore.getState().layout as SplitNode;
    expect(after.sizes).toEqual(before);
  });

  it("moveTab keeps source and destination active keys valid", () => {
    // Group L = [a, b] (active b), group R = [c] (active c).
    const a = useTabsStore.getState().addTab(tab("a"));
    const b = useTabsStore.getState().addTab(tab("b"));
    const c = useTabsStore.getState().addTab(tab("c"));
    const gid = rootGroupId();
    useTabsStore.getState().splitWithTab(c.key, gid, "right");
    const rGroup = findGroupOfTab(useTabsStore.getState().layout, c.key)!.group;
    // Make b the active tab of the left group, then move it into R.
    const lGroup = findGroupOfTab(useTabsStore.getState().layout, a.key)!.group;
    useTabsStore.getState().setGroupActive(lGroup.id, b.key);
    useTabsStore.getState().moveTab(b.key, rGroup.id);
    const layout = useTabsStore.getState().layout;
    // Source (left) survives with [a]; its active key fell back to a surviving tab.
    const srcAfter = findGroupOfTab(layout, a.key)!.group;
    expect(srcAfter.tabKeys).toEqual([a.key]);
    expect(srcAfter.activeKey).toBe(a.key);
    // Destination has b active.
    const dstAfter = findGroupOfTab(layout, b.key)!.group;
    expect(dstAfter.activeKey).toBe(b.key);
  });

  it("removeTab collapses an emptied group and its parent split", () => {
    const a = useTabsStore.getState().addTab(tab("a"));
    const b = useTabsStore.getState().addTab(tab("b"));
    const gid = rootGroupId();
    useTabsStore.getState().splitWithTab(b.key, gid, "right");
    expect((useTabsStore.getState().layout as SplitNode).type).toBe("split");

    // Remove b → its group empties → split collapses to the lone a group.
    useTabsStore.getState().removeTab(b.key);
    const layout = useTabsStore.getState().layout as GroupNode;
    expect(layout.type).toBe("group");
    expect(layout.tabKeys).toEqual([a.key]);
  });

  describe("closing a subwindow's last tab, setting unset (keep it)", () => {
    beforeEach(() => useSettingsStore.setState({ settings: {} }));

    function splitAB() {
      const a = useTabsStore.getState().addTab(tab("a"));
      const b = useTabsStore.getState().addTab(tab("b"));
      useTabsStore.getState().splitWithTab(b.key, rootGroupId(), "right");
      const bGroup = findGroupOfTab(useTabsStore.getState().layout, b.key)!.group;
      return { a, b, bGroup };
    }

    it("leaves the emptied subwindow standing and focused", () => {
      const { a, b, bGroup } = splitAB();
      useTabsStore.getState().focusGroup(bGroup.id);
      useTabsStore.getState().removeTab(b.key);
      const layout = useTabsStore.getState().layout as SplitNode;
      expect(layout.type).toBe("split");
      const kept = findGroup(layout, bGroup.id)!;
      expect(kept.tabKeys).toEqual([]);
      expect(kept.activeKey).toBeNull();
      expect(findGroupOfTab(layout, a.key)).toBeTruthy();
      expect(useTabsStore.getState().focusedGroupId).toBe(bGroup.id);
      expect(useTabsStore.getState().activeKey).toBeNull();
    });

    it("a new tab lands in the kept subwindow, which is ordinary again", () => {
      const { b, bGroup } = splitAB();
      useTabsStore.getState().focusGroup(bGroup.id);
      useTabsStore.getState().removeTab(b.key);
      const c = useTabsStore.getState().addTab(tab("c"));
      const group = findGroup(useTabsStore.getState().layout, bGroup.id)!;
      expect(group.tabKeys).toEqual([c.key]);
      expect(group.keepEmpty).toBeFalsy();
      // Moved away (not closed), the tab takes the subwindow with it.
      const aGroup = allGroups(useTabsStore.getState().layout).find((g) => g.id !== bGroup.id)!;
      useTabsStore.getState().moveTab(c.key, aGroup.id);
      expect(useTabsStore.getState().layout?.type).toBe("group");
    });

    it("the subwindow's × still closes it", () => {
      const { b, bGroup } = splitAB();
      useTabsStore.getState().removeTab(b.key);
      useTabsStore.getState().closeGroup(bGroup.id);
      expect(useTabsStore.getState().layout?.type).toBe("group");
      expect(findGroup(useTabsStore.getState().layout, bGroup.id)).toBeNull();
    });

    it("the last subwindow of the scope still falls back to the placeholder", () => {
      const a = useTabsStore.getState().addTab(tab("a"));
      useTabsStore.getState().removeTab(a.key);
      expect(useTabsStore.getState().layout).toBeNull();
    });
  });

  it("removing the last tab leaves an empty scope", () => {
    const a = useTabsStore.getState().addTab(tab("a"));
    useTabsStore.getState().removeTab(a.key);
    expect(useTabsStore.getState().layout).toBeNull();
    expect(useTabsStore.getState().tabs).toEqual([]);
    expect(useTabsStore.getState().activeKey).toBeNull();
  });

  it("moveTab moves a tab between groups and collapses the empty source", () => {
    const a = useTabsStore.getState().addTab(tab("a"));
    const b = useTabsStore.getState().addTab(tab("b"));
    const gid = rootGroupId();
    useTabsStore.getState().splitWithTab(b.key, gid, "right");
    const root = useTabsStore.getState().layout as SplitNode;
    const leftGroup = root.children[0] as GroupNode; // holds a

    // Move b into the left group → right group empties → collapse to one group.
    useTabsStore.getState().moveTab(b.key, leftGroup.id);
    const layout = useTabsStore.getState().layout as GroupNode;
    expect(layout.type).toBe("group");
    expect(layout.tabKeys.sort()).toEqual([a.key, b.key].sort());
    expect(layout.activeKey).toBe(b.key);
  });

  it("moveTab with an index inserts at that position", () => {
    const a = useTabsStore.getState().addTab(tab("a"));
    const b = useTabsStore.getState().addTab(tab("b"));
    const c = useTabsStore.getState().addTab(tab("c"));
    const gid = rootGroupId();
    // Split c off, then move it back to index 0 of the original group.
    useTabsStore.getState().splitWithTab(c.key, gid, "right");
    const root = useTabsStore.getState().layout as SplitNode;
    const left = root.children[0] as GroupNode;
    useTabsStore.getState().moveTab(c.key, left.id, 0);
    const layout = useTabsStore.getState().layout as GroupNode;
    expect(layout.tabKeys).toEqual([c.key, a.key, b.key]);
  });

  it("resizeSplit adjusts the divider fractions, clamped", () => {
    useTabsStore.getState().addTab(tab("a"));
    const b = useTabsStore.getState().addTab(tab("b"));
    const gid = rootGroupId();
    useTabsStore.getState().splitWithTab(b.key, gid, "right");
    const split = useTabsStore.getState().layout as SplitNode;
    useTabsStore.getState().resizeSplit(split.id, 0, 0.7);
    const after = useTabsStore.getState().layout as SplitNode;
    expect(after.sizes[0]).toBeCloseTo(0.7);
    expect(after.sizes[1]).toBeCloseTo(0.3);
    expect(after.sizes[0] + after.sizes[1]).toBeCloseTo(1);

    // Clamp: a too-large fraction is bounded so both panes keep a min size.
    useTabsStore.getState().resizeSplit(split.id, 0, 5);
    const clamped = useTabsStore.getState().layout as SplitNode;
    expect(clamped.sizes[0]).toBeLessThan(1);
    expect(clamped.sizes[1]).toBeGreaterThan(0);
  });

  describe("loadFromLayout", () => {
    it("legacy load (no groups) builds a single root group, active = first", () => {
      useTabsStore.getState().loadFromLayout(
        [
          { key: "saved-1", label: "one", cmd: "bash", cwd: "/x", kind: "shell" },
          { key: "saved-2", label: "two", cmd: "bash", cwd: "/x", kind: "shell" },
        ],
        "/proj",
        "p",
      );
      const layout = useTabsStore.getState().layout as GroupNode;
      expect(layout.type).toBe("group");
      expect(layout.tabKeys.length).toBe(2);
      expect(layout.activeKey).toBe(layout.tabKeys[0]);
      // Keys are re-minted, not the saved ones.
      expect(layout.tabKeys).not.toContain("saved-1");
      // All tabs are placed; none orphaned.
      expect(useTabsStore.getState().tabs.length).toBe(2);
    });

    it("re-mints tab keys and rebuilds the tree from a saved groups tree", () => {
      useTabsStore.getState().loadFromLayout(
        [
          { key: "k1", label: "one", cmd: "bash", cwd: "/x", kind: "shell" },
          { key: "k2", label: "two", cmd: "bash", cwd: "/x", kind: "shell" },
        ],
        "/proj",
        "p",
        {
          type: "split",
          dir: "row",
          sizes: [0.6, 0.4],
          children: [
            { type: "group", tabKeys: ["k1"], activeKey: "k1" },
            { type: "group", tabKeys: ["k2"], activeKey: "k2" },
          ],
        },
      );
      const root = useTabsStore.getState().layout as SplitNode;
      expect(root.type).toBe("split");
      expect(root.dir).toBe("row");
      expect(root.sizes).toEqual([0.6, 0.4]);
      const groups = allGroups(root);
      expect(groups.length).toBe(2);
      // Two distinct re-minted keys, one per group.
      const allKeys = groups.flatMap((g) => g.tabKeys);
      expect(new Set(allKeys).size).toBe(2);
      expect(allKeys).not.toContain("k1");
    });

    it("appends tabs missing from the saved tree so none are orphaned", () => {
      useTabsStore.getState().loadFromLayout(
        [
          { key: "k1", label: "one", cmd: "bash", cwd: "/x", kind: "shell" },
          { key: "k2", label: "two", cmd: "bash", cwd: "/x", kind: "shell" },
        ],
        "/proj",
        "p",
        // Tree only references k1.
        { type: "group", tabKeys: ["k1"], activeKey: "k1" },
      );
      const layout = useTabsStore.getState().layout as GroupNode;
      expect(layout.tabKeys.length).toBe(2); // k2 appended
      expect(useTabsStore.getState().tabs.length).toBe(2);
    });

    it("resumable Claude agent restores with --resume <id> and carries sessionId", () => {
      const sid = "abcd-1234";
      useTabsStore.getState().loadFromLayout(
        [{ key: "a1", label: "claude", cmd: "claude", cwd: "/x", kind: "agent", sessionId: sid }],
        "/proj",
        "p",
      );
      const tabEntry = useTabsStore.getState().tabs[0];
      expect(tabEntry.args).toEqual(["--resume", sid]);
      expect(tabEntry.sessionId).toBe(sid);
    });

    it("non-resumable agent (no sessionId / not in map) gets no resume args", () => {
      useTabsStore.getState().loadFromLayout(
        [
          { key: "a1", label: "claude", cmd: "claude", cwd: "/x", kind: "agent" },
          { key: "a2", label: "aider", cmd: "aider", cwd: "/x", kind: "agent", sessionId: "g" },
        ],
        "/proj",
        "p",
      );
      const tabs = useTabsStore.getState().tabs;
      expect(tabs[0].args).toEqual([]); // claude, no sessionId
      expect(tabs[1].args).toEqual([]); // aider not in RESUMABLE_AGENTS
    });
  });

  it("setActive focuses the tab's group and marks it active", () => {
    const a = useTabsStore.getState().addTab(tab("a"));
    const b = useTabsStore.getState().addTab(tab("b"));
    const gid = rootGroupId();
    useTabsStore.getState().splitWithTab(b.key, gid, "right");
    // a is in the left group; activating it should refocus that group.
    useTabsStore.getState().setActive(a.key);
    const focused = useTabsStore.getState().focusedGroupId!;
    const fg = findGroup(useTabsStore.getState().layout, focused)!;
    expect(fg.activeKey).toBe(a.key);
    expect(useTabsStore.getState().activeKey).toBe(a.key);
  });

  it("tree helpers find groups and tabs", () => {
    const a = useTabsStore.getState().addTab(tab("a"));
    const b = useTabsStore.getState().addTab(tab("b"));
    const gid = rootGroupId();
    useTabsStore.getState().splitWithTab(b.key, gid, "right");
    const layout = useTabsStore.getState().layout as LayoutNode;
    expect(findGroupOfTab(layout, a.key)).toBeTruthy();
    expect(findGroupOfTab(layout, b.key)).toBeTruthy();
    expect(findGroupOfTab(layout, "nope")).toBeNull();
  });
});
