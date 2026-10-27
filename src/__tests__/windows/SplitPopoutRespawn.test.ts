/**
 * #42 (multi-pane, "Phase 4"): a SPLIT detached popout must respawn as a floating
 * window on restart — NOT dock back into the main panel. Previously
 * withDetachedDocked tagged only single-group popouts, so a split popout's subtree
 * was persisted untagged and restored docked. Now the split node carries the
 * detached tag (through prune + deserialize) and the respawn path re-detaches the
 * whole split subtree by id.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn((..._a: unknown[]) => Promise.resolve(undefined)),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import {
  useTabsStore,
  orderedTabKeys,
  allGroups,
  type SplitNode,
} from "../../stores/tabs";
import { findSplit } from "../../stores/tabs/layoutTree";

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
  useTabsStore.getState().setScope("p");
}

const BOUNDS = { x: 10, y: 20, w: 800, h: 600 };

// Scope "p": in-window group holds tab a; a split popout holds [b] | [c].
function seedSplitPopout() {
  const a = useTabsStore.getState().addTab({ label: "a", cmd: "bash", cwd: "/p", kind: "shell" });
  const b = { key: "kb", label: "b", cmd: "bash", cwd: "/p", kind: "shell" as const };
  const c = { key: "kc", label: "c", cmd: "bash", cwd: "/p", kind: "shell" as const };
  useTabsStore.setState((s) => ({
    tabsByScope: { ...s.tabsByScope, p: [...(s.tabsByScope.p ?? []), b, c] },
    tabs: [...s.tabs, b, c],
    detachedGroupsByScope: {
      p: [
        {
          id: "s-pop",
          label: "detached-p-s-pop",
          bounds: BOUNDS,
          subtree: {
            type: "split",
            id: "s-pop",
            dir: "row",
            sizes: [0.5, 0.5],
            children: [
              { type: "group", id: "g-b", tabKeys: ["kb"], activeKey: "kb" },
              { type: "group", id: "g-c", tabKeys: ["kc"], activeKey: "kc" },
            ],
          } as SplitNode,
        },
      ],
    },
  }));
  return { a, b, c };
}

describe("split popout respawns detached on restart (#42)", () => {
  beforeEach(reset);

  it("persists the split tagged detached, with its bounds", () => {
    seedSplitPopout();
    const snap = useTabsStore.getState().snapshotScopeForSwitch("p");
    const tree = snap.tabGroups!;
    expect(tree.type).toBe("split"); // [inWindow group, detached split]
    const taggedSplit =
      tree.type === "split"
        ? tree.children.find((c) => c.type === "split" && c.detached)
        : undefined;
    expect(taggedSplit).toBeTruthy();
    expect(taggedSplit && "bounds" in taggedSplit ? taggedSplit.bounds : undefined).toEqual(BOUNDS);
  });

  it("restores the split docked AND queues exactly one respawn target for it", () => {
    seedSplitPopout();
    const snap = useTabsStore.getState().snapshotScopeForSwitch("p");

    reset(); // simulate restart
    useTabsStore.getState().loadFromLayout(snap.tabs, "/p", "p", snap.tabGroups ?? undefined);

    // All three tabs restored DOCKED so their panes mount before the re-detach.
    const layout = useTabsStore.getState().layoutByScope["p"];
    expect(orderedTabKeys(layout)).toHaveLength(3);

    // Exactly one respawn target, carrying the popout's bounds, pointing at a
    // SPLIT node in the restored (docked) layout.
    const pending = useTabsStore.getState().pendingRespawnByScope["p"];
    expect(pending).toHaveLength(1);
    expect(pending[0].bounds).toEqual(BOUNDS);
    expect(findSplit(layout, pending[0].id)).toBeTruthy();
  });

  it("detachGroup re-detaches the whole split subtree by its id", () => {
    seedSplitPopout();
    const snap = useTabsStore.getState().snapshotScopeForSwitch("p");
    reset();
    useTabsStore.getState().loadFromLayout(snap.tabs, "/p", "p", snap.tabGroups ?? undefined);

    const target = useTabsStore.getState().pendingRespawnByScope["p"][0];
    const label = useTabsStore
      .getState()
      .detachGroup(target.id, { bounds: target.bounds, allowLastGroup: true, skipBackend: true });
    expect(label).toBe(`detached-p-${target.id}`);

    // The split left the in-window layout; only the single in-window tab remains.
    const layout = useTabsStore.getState().layoutByScope["p"];
    expect(allGroups(layout).map((g) => g.tabKeys).flat()).toHaveLength(1);

    // It is now a detached popout whose subtree is a 2-pane split holding b and c.
    const det = useTabsStore.getState().detachedGroupsByScope["p"];
    expect(det).toHaveLength(1);
    expect(det[0].subtree.type).toBe("split");
    const popoutKeys = orderedTabKeys(det[0].subtree);
    expect(popoutKeys).toHaveLength(2);
    // Tab payloads survive the round trip (the panes keep their PTYs).
    const labels = popoutKeys.map(
      (k) => useTabsStore.getState().tabs.find((t) => t.key === k)?.label,
    );
    expect(labels.sort()).toEqual(["b", "c"]);
  });
});
