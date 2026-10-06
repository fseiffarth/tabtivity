/**
 * #42: a popout's visibility follows the active SCOPE, not the active project.
 *
 * A detached subwindow is an OS window of its own, so nothing about switching
 * what the main window shows hides it — the backend parks the outgoing scope's
 * popouts and un-parks the incoming scope's. That park used to ride entirely on
 * `switch_project_runtime`, which entering a `box:<id>` scope never performs
 * (`openBox` only sets the scope), so a project's popout kept floating over the
 * box's tabs. Every scope change funnels through `setScope`, which is where the
 * sync is now asked for.
 *
 * It is also where the incoming scope's popouts are asked for again: native
 * Wayland closes an inactive scope's popouts (a minimized one could come back
 * blank over the other project) and keeps their records, so `setScope` rebuilds
 * them from those records — a no-op on the platforms that park by hiding.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn((..._a: unknown[]) => Promise.resolve(undefined)),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { useTabsStore, type LayoutNode } from "../../stores/tabs";
import { setDetachedWindowContext } from "../../stores/detachedContext";

/** The scopes `sync_detached_scope` was asked to make visible, in order. */
function syncedScopes(): string[] {
  return invokeMock.mock.calls
    .filter((c) => c[0] === "sync_detached_scope")
    .map((c) => (c[1] as { scope: string }).scope);
}

/** The popouts `detach_subwindow` was asked for, in order. */
function detachCalls(): Array<Record<string, unknown>> {
  return invokeMock.mock.calls
    .filter((c) => c[0] === "detach_subwindow")
    .map((c) => c[1] as Record<string, unknown>);
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

function record(scope: string, id: string, key: string, bounds?: { x: number; y: number; w: number; h: number }) {
  const subtree: LayoutNode = { type: "group", id, tabKeys: [key], activeKey: key };
  return { id, subtree, label: `detached-${scope}-${id}`, bounds };
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve(undefined));
  setDetachedWindowContext(null);
  useTabsStore.setState({
    scope: "p1",
    tabsByScope: {},
    layoutByScope: {},
    focusedGroupByScope: {},
    detachedGroupsByScope: {},
    tabs: [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
  });
});

describe("popout visibility follows the scope", () => {
  it("entering a box scope syncs the popouts to that box", () => {
    useTabsStore.getState().setScope("box:b7");
    expect(syncedScopes()).toEqual(["box:b7"]);
  });

  it("a project switch and a return to the root sync too", () => {
    useTabsStore.getState().setScope("p2");
    useTabsStore.getState().setScope("root");
    expect(syncedScopes()).toEqual(["p2", "root"]);
  });

  it("re-setting the same scope asks for nothing", () => {
    useTabsStore.getState().setScope("p1");
    expect(syncedScopes()).toEqual([]);
  });

  it("a popout's own heap never drives which windows the main window shows", () => {
    setDetachedWindowContext({
      scope: "p1",
      groupId: "g-1",
      label: "detached-p1-g-1",
      targetGroupId: () => "g-1",
      pushEdit: () => {},
      closeTab: () => {},
    });
    useTabsStore.getState().setScope("box:b7");
    expect(syncedScopes()).toEqual([]);
    setDetachedWindowContext(null);
  });
});

describe("popouts come back with their scope", () => {
  beforeEach(() => {
    useTabsStore.setState({
      scope: "A",
      tabsByScope: {
        A: [{ key: "a1", label: "a", cmd: "bash", cwd: "/", kind: "shell", scope: "A" } as never],
        B: [{ key: "b1", label: "b", cmd: "bash", cwd: "/", kind: "shell", scope: "B" } as never],
      },
      layoutByScope: {},
      detachedGroupsByScope: {
        A: [record("A", "g-1", "a1", { x: 10, y: 20, w: 700, h: 500 })],
        B: [record("B", "g-2", "b1")],
      },
    });
  });

  it("entering a scope asks for its popouts only, after the sync, with their bounds", async () => {
    useTabsStore.getState().setScope("B");
    await flush();
    expect(detachCalls()).toEqual([
      { projectId: "B", groupId: "g-2", x: null, y: null, width: null, height: null },
    ]);
    const order = invokeMock.mock.calls.map((c) => c[0]);
    expect(order.indexOf("sync_detached_scope")).toBeLessThan(order.indexOf("detach_subwindow"));

    invokeMock.mockClear();
    useTabsStore.getState().setScope("A");
    await flush();
    expect(detachCalls()).toEqual([
      { projectId: "A", groupId: "g-1", x: 10, y: 20, width: 700, height: 500 },
    ]);
  });

  it("a fast A→B→A asks for A's popouts only — B was left before its sync returned", async () => {
    useTabsStore.getState().setScope("B");
    useTabsStore.getState().setScope("A");
    await flush();
    expect(syncedScopes()).toEqual(["B", "A"]);
    expect(detachCalls().map((c) => c.projectId)).toEqual(["A"]);
  });

  it("a popout's own heap never respawns anything", async () => {
    setDetachedWindowContext({
      scope: "A",
      groupId: "g-1",
      label: "detached-A-g-1",
      targetGroupId: () => "g-1",
      pushEdit: () => {},
      closeTab: () => {},
    });
    useTabsStore.getState().setScope("B");
    useTabsStore.getState().respawnDetachedForScope("B");
    await flush();
    expect(detachCalls()).toEqual([]);
    setDetachedWindowContext(null);
  });

  it("a popout that cannot be rebuilt docks its tabs back", async () => {
    invokeMock.mockImplementation((...a: unknown[]) =>
      a[0] === "detach_subwindow" ? Promise.reject(new Error("no")) : Promise.resolve(undefined),
    );
    vi.useFakeTimers();
    try {
      useTabsStore.getState().setScope("B");
      await flush();
      expect(useTabsStore.getState().detachedGroupsByScope.B).toHaveLength(1);
      // A display switch takes seconds: still detached after half a minute.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(useTabsStore.getState().detachedGroupsByScope.B).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(180_000);
      const s = useTabsStore.getState();
      expect(detachCalls()).toHaveLength(13);
      expect(s.detachedGroupsByScope.B).toEqual([]);
      expect(JSON.stringify(s.layoutByScope.B)).toContain("b1");
      // The scope that was left keeps its record untouched.
      expect(s.detachedGroupsByScope.A).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
