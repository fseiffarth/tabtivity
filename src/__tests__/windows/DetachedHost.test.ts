/**
 * #42: the MAIN window's host side of the detached protocol
 * (`listenDetachedHost`) and its wiring.
 *
 * Regression guard: `listenDetachedHost` was dead code (never called), so a
 * popped-out window hung on "Loading subwindow…" forever. These tests assert
 * (1) the host registers all three channels and drives the real tabs store
 * (seed → edit → dock), and (2) AppShell wires the host on the MAIN-window
 * startup path (it imports and calls `listenDetachedHost`).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
// Vite/Vitest `?raw` import loads the AppShell source as a string (no node:fs).
import appShellSource from "../../components/layout/AppShell.tsx?raw";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn((..._a: unknown[]) => Promise.resolve(undefined)),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

// Capture registered listeners by channel and the emitted payloads so we can
// drive the host as the detached window would.
type Handler = (ev: { payload: unknown }) => void;
const { handlers, emitted, emit, listen } = vi.hoisted(() => {
  const handlers = new Map<string, Handler>();
  const emitted: Array<{ event: string; payload: unknown }> = [];
  return {
    handlers,
    emitted,
    emit: vi.fn((event: string, payload?: unknown) => {
      emitted.push({ event, payload });
      return Promise.resolve();
    }),
    listen: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, handler);
      return Promise.resolve(() => handlers.delete(event));
    }),
  };
});
vi.mock("@tauri-apps/api/event", () => ({ emit, listen }));

// Track the per-label popout windows `shutdownDetachedWindows` destroys.
const { destroyed, getByLabel } = vi.hoisted(() => {
  const destroyed: string[] = [];
  return {
    destroyed,
    getByLabel: vi.fn((label: string) =>
      Promise.resolve({ destroy: () => { destroyed.push(label); return Promise.resolve(); } }),
    ),
  };
});
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: { getByLabel: (l: string) => getByLabel(l) },
}));

import { useTabsStore, orderedTabKeys, type GroupNode } from "../../stores/tabs";
import { useProjectsStore } from "../../stores/projects";
import {
  listenDetachedHost,
  shutdownDetachedWindows,
  DETACHED_REQUEST_SEED,
  DETACHED_EDIT,
  DETACHED_DOCK,
  DETACHED_CLOSE,
  DETACHED_HIDE,
  DETACHED_WINDOW_DESTROYED,
  DETACHED_GAVE_UP,
  detachedRespawnDelay,
  detachedSeedEvent,
  type DetachedSeed,
} from "../../stores/detached";

function reset() {
  handlers.clear();
  emitted.length = 0;
  destroyed.length = 0;
  getByLabel.mockClear();
  invokeMock.mockClear();
  emit.mockClear();
  listen.mockClear();
  useTabsStore.setState({
    scope: "p",
    tabsByScope: {},
    layoutByScope: {},
    focusedGroupByScope: {},
    detachedGroupsByScope: {},
    hiddenGroupsByScope: {},
    tabs: [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
  });
  useProjectsStore.setState({ projects: [] });
}

/** Detach the second of two row-split groups, returning its id + label. */
function detachSecond(): { groupId: string; label: string; bKey: string } {
  const store = useTabsStore.getState();
  const a = store.addTab({ label: "a", cmd: "bash", cwd: "/p", kind: "shell" });
  const b = store.addTab({ label: "b", cmd: "bash", cwd: "/p", kind: "shell" });
  void a;
  const rootGid = (useTabsStore.getState().layout as GroupNode).id;
  useTabsStore.getState().splitWithTab(b.key, rootGid, "right");
  const root = useTabsStore.getState().layout as { children: GroupNode[] };
  const right = root.children[1];
  const label = useTabsStore.getState().detachGroup(right.id, { skipBackend: true })!;
  return { groupId: right.id, label, bKey: b.key };
}

describe("detached host (#42)", () => {
  beforeEach(reset);

  it("registers all protocol channels", async () => {
    await listenDetachedHost();
    expect(handlers.has(DETACHED_REQUEST_SEED)).toBe(true);
    expect(handlers.has(DETACHED_EDIT)).toBe(true);
    expect(handlers.has(DETACHED_DOCK)).toBe(true);
    expect(handlers.has(DETACHED_CLOSE)).toBe(true);
    expect(handlers.has(DETACHED_HIDE)).toBe(true);
  });

  it("does not answer a seed until every protocol listener is registered", async () => {
    const { groupId, label } = detachSecond();
    let releaseEdit!: (unlisten: () => boolean) => void;
    listen
      .mockImplementationOnce((event: string, handler: Handler) => {
        handlers.set(event, handler);
        return Promise.resolve(() => handlers.delete(event));
      })
      .mockImplementationOnce((event: string, handler: Handler) => {
        handlers.set(event, handler);
        return new Promise<() => boolean>((resolve) => {
          releaseEdit = resolve;
        });
      });

    const hosting = listenDetachedHost();
    await vi.waitFor(() => expect(handlers.has(DETACHED_REQUEST_SEED)).toBe(true));
    handlers.get(DETACHED_REQUEST_SEED)!({
      payload: { label, scope: "p", groupId },
    });
    expect(emitted.some((entry) => entry.event === detachedSeedEvent(label))).toBe(false);

    releaseEdit(() => handlers.delete(DETACHED_EDIT));
    const unlisten = await hosting;
    expect(emitted.some((entry) => entry.event === detachedSeedEvent(label))).toBe(true);
    unlisten();
  });

  it("a seed request emits the group's tabs + subtree to the requesting label", async () => {
    const { groupId, label, bKey } = detachSecond();
    await listenDetachedHost();

    handlers.get(DETACHED_REQUEST_SEED)!({
      payload: { label, scope: "p", groupId },
    });

    const seedEvent = emitted.find((e) => e.event === detachedSeedEvent(label));
    expect(seedEvent).toBeDefined();
    const seed = seedEvent!.payload as DetachedSeed;
    expect(seed.tabs.map((t) => t.key)).toEqual([bKey]);
    expect((seed.subtree as GroupNode).tabKeys).toEqual([bKey]);
  });

  it("an edit is applied to the host's detached record", async () => {
    const { groupId } = detachSecond();
    await listenDetachedHost();

    handlers.get(DETACHED_EDIT)!({
      payload: { scope: "p", groupId, edit: { kind: "close", key: "nope" } },
    });
    // The close of a non-owned key leaves the record intact (still detached).
    expect(useTabsStore.getState().detachedGroupsByScope["p"]).toHaveLength(1);
  });

  it("an 'add' edit mints a tab into the popout's subtree, keeps the PTY in the main store, and re-seeds", async () => {
    const { groupId, label, bKey } = detachSecond();
    await listenDetachedHost();
    emitted.length = 0;

    handlers.get(DETACHED_EDIT)!({
      payload: {
        scope: "p",
        groupId,
        edit: {
          kind: "add",
          targetGroupId: groupId,
          tab: { label: "new", cmd: "bash", cwd: "/p", kind: "shell" },
        },
      },
    });

    // The popout's subtree now holds the original tab + the freshly-minted one.
    const rec = useTabsStore.getState().detachedGroupsByScope["p"]![0];
    const subKeys = (rec.subtree as GroupNode).tabKeys;
    expect(subKeys).toHaveLength(2);
    expect(subKeys[0]).toBe(bKey);
    const newKey = subKeys[1];
    // It became the active tab of the popout group.
    expect((rec.subtree as GroupNode).activeKey).toBe(newKey);
    // The payload lives in the main store (its pane mounts + owns the PTY there).
    const payload = useTabsStore.getState().tabsByScope["p"]!.find((t) => t.key === newKey);
    expect(payload).toMatchObject({ label: "new", cmd: "bash", kind: "shell", scope: "p" });
    // The popout is re-seeded so it renders (+ attaches to) the new tab, tagged
    // as the landed key so it plays the drop-in flourish.
    const seed = emitted.find((e) => e.event === detachedSeedEvent(label));
    expect(seed).toBeDefined();
    const payloadSeed = seed!.payload as DetachedSeed & { landedKey?: string };
    expect(payloadSeed.landedKey).toBe(newKey);
    expect(payloadSeed.tabs.map((t) => t.key)).toEqual([bKey, newKey]);
  });

  it("an 'add' edit with a side edge carves a NEW pane in the popout (a file dropped on a body edge)", async () => {
    const { groupId, label, bKey } = detachSecond();
    await listenDetachedHost();
    emitted.length = 0;

    handlers.get(DETACHED_EDIT)!({
      payload: {
        scope: "p",
        groupId,
        edit: {
          kind: "add",
          targetGroupId: groupId,
          edge: "right",
          tab: { label: "readme.md", cmd: "", cwd: "/p", kind: "embed", embedPath: "/p/readme.md" },
        },
      },
    });

    // The popout's subtree is now a split: the original group + a NEW group
    // holding the dropped file's embed tab (the target's own tab is untouched).
    const rec = useTabsStore.getState().detachedGroupsByScope["p"]![0];
    const sub = rec.subtree as { type: string; children: GroupNode[] };
    expect(sub.type).toBe("split");
    expect(sub.children).toHaveLength(2);
    const original = sub.children.find((g) => g.tabKeys.includes(bKey))!;
    const carved = sub.children.find((g) => !g.tabKeys.includes(bKey))!;
    expect(original.tabKeys).toEqual([bKey]);
    expect(carved.tabKeys).toHaveLength(1);
    const newKey = carved.tabKeys[0];
    // The embed payload lives in the main store (its pane mounts + owns anything).
    const payload = useTabsStore.getState().tabsByScope["p"]!.find((t) => t.key === newKey);
    expect(payload).toMatchObject({ kind: "embed", embedPath: "/p/readme.md", scope: "p" });
    // The popout is re-seeded with the landed key so it renders the new pane.
    const seed = emitted.find((e) => e.event === detachedSeedEvent(label));
    expect((seed!.payload as DetachedSeed & { landedKey?: string }).landedKey).toBe(newKey);
  });

  it("an active-scope dock re-docks the group and closes the OS window", async () => {
    const { groupId, label } = detachSecond();
    await listenDetachedHost();
    invokeMock.mockClear();

    handlers.get(DETACHED_DOCK)!({ payload: { scope: "p", groupId } });

    expect(useTabsStore.getState().detachedGroupsByScope["p"]).toHaveLength(0);
    expect(invokeMock).toHaveBeenCalledWith("attach_subwindow", { registryId: label });
  });

  it("a cross-scope dock drops the record + closes the window without touching the live scope", async () => {
    const { groupId, label } = detachSecond();
    // Simulate the detached group's scope no longer being active.
    useTabsStore.setState({ scope: "other" });
    await listenDetachedHost();
    invokeMock.mockClear();

    handlers.get(DETACHED_DOCK)!({ payload: { scope: "p", groupId } });

    expect(useTabsStore.getState().detachedGroupsByScope["p"]).toHaveLength(0);
    expect(invokeMock).toHaveBeenCalledWith("attach_subwindow", { registryId: label });
  });

  it("a hide parks the group in the scope's Hidden list, keeps its tabs, and closes the window", async () => {
    const { groupId, label, bKey } = detachSecond();
    await listenDetachedHost();
    invokeMock.mockClear();

    handlers.get(DETACHED_HIDE)!({ payload: { scope: "p", groupId } });

    // Moved out of the detached record and into the scope's hidden list…
    expect(useTabsStore.getState().detachedGroupsByScope["p"]).toHaveLength(0);
    const hidden = useTabsStore.getState().hiddenGroupsByScope["p"];
    expect(hidden).toHaveLength(1);
    expect(hidden![0].id).toBe(groupId);
    // …with its tab payload intact (PTY stays mounted, unlike a WM-close)…
    expect(useTabsStore.getState().tabsByScope["p"]?.some((t) => t.key === bKey)).toBe(true);
    expect(invokeMock).not.toHaveBeenCalledWith("pty_kill", expect.anything());
    // …and the OS window closed (registry entry dropped).
    expect(invokeMock).toHaveBeenCalledWith("attach_subwindow", { registryId: label });
  });

  it("a hide persists the (parked) scope so it restores as hidden, not detached", async () => {
    const { groupId } = detachSecond();
    useTabsStore.setState({ scope: "other" });
    useProjectsStore.setState({
      projects: [{ id: "p", name: "p", local_file: "/p/project.json" } as never],
    });
    await listenDetachedHost();
    invokeMock.mockClear();

    handlers.get(DETACHED_HIDE)!({ payload: { scope: "p", groupId } });

    // The record still moved to hidden even for an inactive scope…
    expect(useTabsStore.getState().hiddenGroupsByScope["p"]).toHaveLength(1);
    // …and the scope is persisted so disk agrees (saved as hidden).
    expect(invokeMock).toHaveBeenCalledWith(
      "workspace_sync",
      expect.objectContaining({ localFile: "/p/project.json" }),
    );
  });

  it("a WM-close drops the group's tabs (no dock-back), kills their PTYs, and closes the window", async () => {
    const { groupId, label, bKey } = detachSecond();
    await listenDetachedHost();
    invokeMock.mockClear();

    handlers.get(DETACHED_CLOSE)!({ payload: { scope: "p", groupId } });

    // The detached record is gone and the popout's tab payload was dropped — not
    // re-injected into any layout — so it won't restore.
    expect(useTabsStore.getState().detachedGroupsByScope["p"]).toHaveLength(0);
    expect(useTabsStore.getState().tabsByScope["p"]?.some((t) => t.key === bKey)).toBe(false);
    // The PTY is killed explicitly (the main pane isn't mounted to do it on unmount).
    expect(invokeMock).toHaveBeenCalledWith("pty_kill", { id: `p:${bKey}` });
    // And the OS window is closed.
    expect(invokeMock).toHaveBeenCalledWith("attach_subwindow", { registryId: label });
  });

  it("a WM-close persists the (parked) scope so its tabs don't restore", async () => {
    const { groupId } = detachSecond();
    // Parked: the popout's scope is no longer the active one in the main window.
    useTabsStore.setState({ scope: "other" });
    useProjectsStore.setState({
      projects: [{ id: "p", name: "p", local_file: "/p/project.json" } as never],
    });
    await listenDetachedHost();
    invokeMock.mockClear();

    handlers.get(DETACHED_CLOSE)!({ payload: { scope: "p", groupId } });

    expect(invokeMock).toHaveBeenCalledWith(
      "workspace_sync",
      expect.objectContaining({ localFile: "/p/project.json" }),
    );
  });

  it("reopens a popout lost during a monitor change without docking its tabs", async () => {
    const { label, bKey } = detachSecond();
    await listenDetachedHost();
    invokeMock.mockClear();

    handlers.get(DETACHED_WINDOW_DESTROYED)!({ payload: { label } });
    await Promise.resolve();

    expect(invokeMock).toHaveBeenCalledWith(
      "detach_subwindow",
      expect.objectContaining({ projectId: "p" }),
    );
    expect(useTabsStore.getState().detachedGroupsByScope.p).toHaveLength(1);
    expect((useTabsStore.getState().layout as GroupNode).tabKeys).not.toContain(bKey);
    expect(invokeMock).not.toHaveBeenCalledWith("workspace_sync", expect.anything());
  });

  it("keeps reopening a popout the display switch kills again and again, never docking it", async () => {
    // Switching to one screen reconfigures the outputs in several steps, and a
    // compositor may drop the popout at each. It used to dock on the third death
    // in a minute — the popout "went back into the main subwindow".
    const { label, bKey } = detachSecond();
    await listenDetachedHost();
    const detachCalls = () =>
      invokeMock.mock.calls.filter(([cmd]) => cmd === "detach_subwindow").length;
    vi.useFakeTimers();
    try {
      invokeMock.mockClear();
      for (let i = 0; i < 4; i++) {
        handlers.get(DETACHED_WINDOW_DESTROYED)!({ payload: { label } });
        await vi.advanceTimersByTimeAsync(detachedRespawnDelay(i + 1));
      }
      expect(detachCalls()).toBe(4);
      expect(useTabsStore.getState().detachedGroupsByScope.p).toHaveLength(1);
      expect((useTabsStore.getState().layout as GroupNode).tabKeys).not.toContain(bKey);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a popout that gives up on its seed during a display switch detached", async () => {
    // Disconnecting a screen stalls the main window; a respawned popout then
    // gives up on its seed a few times in a row. Three in a minute used to dock
    // it into the main window.
    const { label, bKey } = detachSecond();
    await listenDetachedHost();
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 4; i++) {
        handlers.get(DETACHED_GAVE_UP)!({ payload: { label } });
        handlers.get(DETACHED_WINDOW_DESTROYED)!({ payload: { label } });
        await vi.advanceTimersByTimeAsync(8_000 + detachedRespawnDelay(i + 1));
      }
      expect(useTabsStore.getState().detachedGroupsByScope.p).toHaveLength(1);
      expect((useTabsStore.getState().layout as GroupNode).tabKeys).not.toContain(bKey);
      // It rendered again: a later death ends the streak.
      handlers.get(DETACHED_WINDOW_DESTROYED)!({ payload: { label } });
      await vi.advanceTimersByTimeAsync(30_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("docks a popout that keeps giving up on its seed for minutes, so its tabs stay reachable", async () => {
    const { label, bKey } = detachSecond();
    await listenDetachedHost();
    vi.useFakeTimers();
    try {
      let docked = -1;
      for (let i = 0; i < 8 && docked < 0; i++) {
        handlers.get(DETACHED_GAVE_UP)!({ payload: { label } });
        handlers.get(DETACHED_WINDOW_DESTROYED)!({ payload: { label } });
        if (!(useTabsStore.getState().detachedGroupsByScope.p ?? []).length) docked = i;
        await vi.advanceTimersByTimeAsync(38_000);
      }
      // Not before three minutes of nothing but give-ups.
      expect(docked).toBeGreaterThanOrEqual(5);
      expect(orderedTabKeys(useTabsStore.getState().layout)).toContain(bKey);
    } finally {
      vi.useRealTimers();
    }
  });

  it("backs off reopening a window something keeps killing", () => {
    expect(detachedRespawnDelay(1)).toBe(0);
    expect(detachedRespawnDelay(2)).toBe(0);
    expect(detachedRespawnDelay(3)).toBe(1000);
    expect(detachedRespawnDelay(4)).toBe(2000);
    expect(detachedRespawnDelay(20)).toBe(30_000);
  });

  it("app-quit teardown persists each detached scope and destroys its popout (no discard)", async () => {
    const { label, bKey } = detachSecond();
    useProjectsStore.setState({
      projects: [{ id: "p", name: "p", local_file: "/p/project.json" } as never],
    });
    invokeMock.mockClear();

    await shutdownDetachedWindows();

    // The scope is persisted (so detached:true + bounds reach disk for restore).
    expect(invokeMock).toHaveBeenCalledWith(
      "workspace_sync",
      expect.objectContaining({ localFile: "/p/project.json" }),
    );
    // The popout's OS window is destroyed (closed, not stranded on screen).
    expect(destroyed).toContain(label);
    // Crucially, the group is NOT discarded — it survives so it can re-open at
    // its saved bounds next launch (unlike an explicit per-popout WM close).
    expect(useTabsStore.getState().detachedGroupsByScope["p"]).toHaveLength(1);
    expect(useTabsStore.getState().tabsByScope["p"]?.some((t) => t.key === bKey)).toBe(true);
    // It does NOT call attach_subwindow (that path also drops the registry entry).
    expect(invokeMock).not.toHaveBeenCalledWith("attach_subwindow", expect.anything());
  });

  it("app-quit teardown persists a scope with no project.json too (root/box), and closes it", async () => {
    // Group B #229. A scope with no matching project entry — the root scope,
    // and any `box:<id>` scope — has no `local_file`, and the teardown used to
    // read that as "can't persist" and skip it entirely. But those scopes DO
    // persist: they live under their own session directory in the state dir and
    // simply have no project-tree export copy, which the backend expresses as an
    // empty `localFile`. Skipping them meant a root popout's detached flag and
    // bounds never reached disk, so it came back wrong (or came back at all)
    // after a relaunch. Persist for every scope; only the export path differs.
    const { label } = detachSecond();
    useProjectsStore.setState({ projects: [] });
    invokeMock.mockClear();

    await shutdownDetachedWindows();

    expect(invokeMock).toHaveBeenCalledWith(
      "workspace_sync",
      expect.objectContaining({ projectId: "p", localFile: "" }),
    );
    expect(destroyed).toContain(label);
  });

  it("AppShell tears down popouts on close before destroying the main window", () => {
    const src = appShellSource as string;
    expect(src).toMatch(/import\s*\{[^}]*shutdownDetachedWindows[^}]*\}\s*from\s*["'][^"']*detached["']/);
    expect(src).toMatch(/shutdownDetachedWindows\s*\(/);
  });

  it("the combined unlisten removes every channel", async () => {
    const un = await listenDetachedHost();
    un();
    expect(handlers.has(DETACHED_REQUEST_SEED)).toBe(false);
    expect(handlers.has(DETACHED_EDIT)).toBe(false);
    expect(handlers.has(DETACHED_DOCK)).toBe(false);
    expect(handlers.has(DETACHED_CLOSE)).toBe(false);
  });

  it("AppShell wires the host on main-window startup (regression: it was dead code)", () => {
    // The blocker was that no main-window code imported/called the host. Assert
    // the wiring statically so a regression (removing the call) fails the suite.
    const src = appShellSource as string;
    expect(src).toMatch(/import\s*\{[^}]*listenDetachedHost[^}]*\}\s*from\s*["'][^"']*detached["']/);
    expect(src).toMatch(/listenDetachedHost\s*\(/);
  });
});
