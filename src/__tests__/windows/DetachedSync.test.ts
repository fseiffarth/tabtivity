/**
 * #42: pure reducers + payload builders for the detached-subwindow protocol
 * (`src/stores/detached.ts`). These run identically in the main and detached
 * windows, so they must be deterministic and membership-preserving.
 */
import { describe, it, expect } from "vitest";

import {
  parseDetachedParam,
  buildSeed,
  applyEditToSubtree,
  applyRenameToTabs,
  detachedSeedEvent,
} from "../../stores/detached";
import type { GroupNode, LayoutNode, SplitNode, TabEntry } from "../../stores/tabs";

function tab(key: string, label = key): TabEntry {
  return { key, scope: "p", label, cmd: "bash", cwd: "/p", kind: "shell" };
}

/** The fixture group's id stays clear of the store's own `g-<n>` counter: a
 * split mints the next `g-<n>`, which on a fresh counter (this file first, or
 * shuffled) would otherwise be `g-1` again — two groups with one id. */
const G = "g-fixture";

function group(tabKeys: string[], activeKey: string | null = tabKeys[0] ?? null): GroupNode {
  return { type: "group", id: G, tabKeys, activeKey };
}

describe("detached — parseDetachedParam", () => {
  it("returns null when the param is absent", () => {
    expect(parseDetachedParam("")).toBeNull();
    expect(parseDetachedParam("?foo=bar")).toBeNull();
  });

  it("reads the two-key form the backend writes", () => {
    expect(parseDetachedParam("?detached=p&group=g-3")).toEqual({ scope: "p", groupId: "g-3" });
    expect(parseDetachedParam("?detached=root&group=g-1")).toEqual({
      scope: "root",
      groupId: "g-1",
    });
  });

  it("a BOX scope survives, colon and all (#224)", () => {
    // The bug: one `scope:group` value split on the FIRST colon, so a box
    // scope's own colon made `box:abc:g-3` parse as scope "box", group
    // "abc:g-3". The host had no record under that scope, never answered the
    // seed, and the popout destroyed itself after 8 s — with the group's tabs
    // stranded in a `detached: true` record that repeated the failure at every
    // launch. Box-scope detach could never work at all.
    expect(parseDetachedParam("?detached=box%3Aabc&group=g-3")).toEqual({
      scope: "box:abc",
      groupId: "g-3",
    });
  });

  it("still reads the legacy single-value form, splitting on the LAST colon", () => {
    // A popout URL minted by an older backend. The last colon is the right one:
    // a group id (`g-3`, `s-12`) never contains one, a scope may.
    expect(parseDetachedParam("?detached=p:g-3")).toEqual({ scope: "p", groupId: "g-3" });
    expect(parseDetachedParam("?detached=box:abc:g-3")).toEqual({
      scope: "box:abc",
      groupId: "g-3",
    });
  });

  it("rejects malformed values (missing colon / empty side)", () => {
    expect(parseDetachedParam("?detached=nopair")).toBeNull();
    expect(parseDetachedParam("?detached=:g-1")).toBeNull();
    expect(parseDetachedParam("?detached=p:")).toBeNull();
  });

  it("namespaces the seed event by label", () => {
    expect(detachedSeedEvent("detached-p-g3")).toBe("detached-seed-detached-p-g3");
  });
});

describe("detached — buildSeed", () => {
  it("ships only the group's own tabs + the subtree", () => {
    const sub = group(["a", "b"]);
    const seed = buildSeed("p", G, [tab("a"), tab("b"), tab("c")], sub);
    expect(seed.scope).toBe("p");
    expect(seed.groupId).toBe(G);
    expect(seed.subtree).toBe(sub);
    expect(seed.tabs.map((t) => t.key)).toEqual(["a", "b"]);
  });
});

describe("detached — applyEditToSubtree", () => {
  it("activate switches activeKey only for an owned key", () => {
    const sub = group(["a", "b"], "a");
    expect((applyEditToSubtree(sub, { kind: "activate", key: "b" }) as GroupNode).activeKey).toBe("b");
    // A non-owned key is a no-op.
    expect(applyEditToSubtree(sub, { kind: "activate", key: "z" })).toBe(sub);
  });

  it("close drops the key and re-derives activeKey when it was active", () => {
    const next = applyEditToSubtree(group(["a", "b"], "a"), { kind: "close", key: "a" }) as GroupNode;
    expect(next.tabKeys).toEqual(["b"]);
    expect(next.activeKey).toBe("b");
  });

  it("close keeps activeKey when a non-active key is closed", () => {
    const next = applyEditToSubtree(group(["a", "b"], "b"), { kind: "close", key: "a" }) as GroupNode;
    expect(next.tabKeys).toEqual(["b"]);
    expect(next.activeKey).toBe("b");
  });

  it("reorder permutes owned keys and refreshes activeKey membership", () => {
    const next = applyEditToSubtree(group(["a", "b", "c"], "b"), {
      kind: "reorder",
      tabKeys: ["c", "b", "a"],
    }) as GroupNode;
    expect(next.tabKeys).toEqual(["c", "b", "a"]);
    expect(next.activeKey).toBe("b");
  });

  it("reorder that changes membership is rejected (no node change)", () => {
    const sub = group(["a", "b"], "a");
    expect(applyEditToSubtree(sub, { kind: "reorder", tabKeys: ["a"] })).toBe(sub);
  });

  it("rename does not touch the group node (label lives on the tab payload)", () => {
    const sub = group(["a", "b"], "a");
    expect(applyEditToSubtree(sub, { kind: "rename", key: "a", label: "x" })).toBe(sub);
  });

  it("split carves a tab out into a new pane beside its group", () => {
    const sub = group(["a", "b"], "a");
    const next = applyEditToSubtree(sub, {
      kind: "split",
      key: "b",
      targetGroupId: G,
      edge: "right",
    }) as SplitNode;
    expect(next.type).toBe("split");
    expect(next.dir).toBe("row");
    const [left, right] = next.children as GroupNode[];
    expect(left.tabKeys).toEqual(["a"]);
    expect(right.tabKeys).toEqual(["b"]);
  });

  it("split of a group's only tab is a no-op (keeps the subtree)", () => {
    const sub = group(["a"], "a");
    expect(
      applyEditToSubtree(sub, { kind: "split", key: "a", targetGroupId: G, edge: "right" }),
    ).toBe(sub);
  });

  it("move merges a tab into another group's bar at the slot", () => {
    // Split b out of [a, b] → row[ group[a], group[b] ], then split c... build a
    // two-group popout with [a, b] | [c] and merge a into the [c] group at slot 0.
    const split = applyEditToSubtree(group(["a", "b", "c"], "a"), {
      kind: "split",
      key: "c",
      targetGroupId: G,
      edge: "right",
    }) as SplitNode;
    const [leftG, rightG] = split.children as GroupNode[];
    expect(leftG.tabKeys).toEqual(["a", "b"]);
    expect(rightG.tabKeys).toEqual(["c"]);
    const merged = applyEditToSubtree(split, {
      kind: "move",
      key: "a",
      targetGroupId: rightG.id,
      index: 0,
    }) as SplitNode;
    const [l, r] = merged.children as GroupNode[];
    expect(l.tabKeys).toEqual(["b"]);
    expect(r.tabKeys).toEqual(["a", "c"]);
    expect(r.activeKey).toBe("a");
  });

  it("move of a pane's only tab collapses the split back to one group", () => {
    const split = applyEditToSubtree(group(["a", "b"], "a"), {
      kind: "split",
      key: "b",
      targetGroupId: G,
      edge: "right",
    }) as SplitNode;
    const [leftG, rightG] = split.children as GroupNode[];
    // Move b (the only tab of the right pane) onto the left group → un-split.
    const merged = applyEditToSubtree(split, {
      kind: "move",
      key: "b",
      targetGroupId: leftG.id,
    });
    expect((merged as GroupNode).type).toBe("group");
    expect((merged as GroupNode).tabKeys).toEqual(["a", "b"]);
    void rightG;
  });

  it("move into the tab's own group is a no-op (within-group reorder is separate)", () => {
    const sub = group(["a", "b"], "a");
    expect(applyEditToSubtree(sub, { kind: "move", key: "a", targetGroupId: G })).toBe(sub);
  });

  it("resize adjusts a split's divider fractions, clamped, leaving the pair sum", () => {
    const sub: LayoutNode = applyEditToSubtree(group(["a", "b"], "a"), {
      kind: "split",
      key: "b",
      targetGroupId: G,
      edge: "right",
    })!;
    const split = sub as SplitNode;
    const next = applyEditToSubtree(split, {
      kind: "resize",
      splitId: split.id,
      dividerIndex: 0,
      fraction: 0.7,
    }) as SplitNode;
    expect(next.sizes[0]).toBeCloseTo(0.7);
    expect(next.sizes[0] + next.sizes[1]).toBeCloseTo(1);
    // Out-of-range fraction is clamped to the [min, pair-min] window.
    const clampedHigh = applyEditToSubtree(split, {
      kind: "resize",
      splitId: split.id,
      dividerIndex: 0,
      fraction: 5,
    }) as SplitNode;
    expect(clampedHigh.sizes[0]).toBeLessThan(1);
    expect(clampedHigh.sizes[0]).toBeGreaterThan(0.9);
  });
});

describe("detached — applyRenameToTabs", () => {
  it("renames only the matching tab and trims", () => {
    const next = applyRenameToTabs([tab("a", "A"), tab("b", "B")], "a", "  New  ");
    expect(next.find((t) => t.key === "a")!.label).toBe("New");
    expect(next.find((t) => t.key === "b")!.label).toBe("B");
  });

  it("ignores an all-whitespace label", () => {
    const tabs = [tab("a", "A")];
    expect(applyRenameToTabs(tabs, "a", "   ")).toBe(tabs);
  });
});
