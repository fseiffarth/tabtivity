/**
 * `useOverlayAgent` — the docked agent of the mail / calendar / to-do overlays.
 * Ctrl+1–9 while an overlay is in front reach it as `OVERLAY_AGENT_EVENT`; the
 * overlay it names answers by docking that slot's ROOT agent (the root
 * console's own numbering: root-allowed agents only) in a column beside itself.
 * Locked here: only the addressed overlay answers, and only while it is up;
 * the tab goes through `addTabToRoot` (hydrate first); the reuse rule (a closed
 * column with the same agent still running comes back, anything else mints a
 * new root tab); Ctrl+1 with no root-allowed default agent shows a hint
 * instead of passing the key on, while any other empty number passes.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

const backend = vi.hoisted(() => ({
  agents: [] as { id: string; bin: string; installed: boolean }[],
  snapshot: null as unknown,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) => {
    switch (cmd) {
      case "list_agents":
        return Promise.resolve(backend.agents);
      case "list_local_drivers":
      case "probe_binaries":
        return Promise.resolve([]);
      case "workspace_snapshot":
        return Promise.resolve(backend.snapshot);
      case "root_work_dir":
        return Promise.resolve("/r");
      default:
        return Promise.resolve(undefined);
    }
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

// The PTY lifecycle bus, so a test can end (or respawn) a docked tab's program.
const bus = vi.hoisted(() => ({
  exit: new Map<string, () => void>(),
  ready: new Map<string, () => void>(),
}));
vi.mock("../../lib/terminal/terminalBus", () => ({
  onTerminalExit: (id: string, h: () => void) => {
    bus.exit.set(id, h);
    return () => bus.exit.delete(id);
  },
  onTerminalReady: (id: string, h: () => void) => {
    bus.ready.set(id, h);
    return () => bus.ready.delete(id);
  },
}));

import { invoke } from "@tauri-apps/api/core";
import { useTabsStore } from "../../stores/tabs";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { useOverlayAgentStore } from "../../stores/overlayAgent";
import { requestOverlayAgent } from "../../lib/shortcuts/newTabChord";
import type { SteeringApp } from "../../lib/shortcuts/steeringRegion";
import {
  __resetOverlayAgentExitWatchForTests,
  useOverlayAgent,
} from "../../components/layout/useOverlayAgent";
import type { Settings } from "../../types";

const rootTabs = () => useTabsStore.getState().tabsByScope.root ?? [];
const docks = () => useOverlayAgentStore.getState().docks;

function settings(patch: Partial<Settings>) {
  useSettingsStore.setState({ settings: { default_agent_cmd: "claude", ...patch } as Settings });
}

/** Mount the hook and wait for its root agent probe to answer. */
async function mount(app: SteeringApp, live = true) {
  const hook = renderHook(({ on }) => useOverlayAgent(app, on), { initialProps: { on: live } });
  if (live) {
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith("list_agents"));
    await act(async () => {});
  }
  return hook;
}

/** Fire the chord for `slot` at `app`; true when an overlay answered. */
function chord(app: SteeringApp, slot: number): boolean {
  let answered = false;
  act(() => {
    answered = requestOverlayAgent(app, slot);
  });
  return answered;
}

beforeEach(() => {
  cleanup();
  vi.mocked(invoke).mockClear();
  __resetOverlayAgentExitWatchForTests();
  backend.agents = [
    { id: "claude", bin: "claude", installed: true },
    { id: "codex", bin: "codex", installed: true },
  ];
  backend.snapshot = null;
  settings({ root_agents: ["claude", "codex"] });
  useTabsStore.setState({
    scope: "p1",
    tabsByScope: { root: [] },
    layoutByScope: { root: null },
    focusedGroupByScope: { root: null },
  });
  useProjectsStore.setState({ rootDir: "/r", activeId: "p1" });
  useOverlayAgentStore.setState({
    docks: {
      mail: { key: null, open: false },
      calendar: { key: null, open: false },
      todo: { key: null, open: false },
    },
    shownKeys: new Set(),
  });
});

describe("useOverlayAgent", () => {
  it("answers only the chords addressed to its own overlay", async () => {
    const { result } = await mount("calendar");

    expect(chord("todo", 0)).toBe(false);
    expect(rootTabs()).toHaveLength(0);

    expect(chord("calendar", 0)).toBe(true);
    expect(rootTabs()).toHaveLength(1);
    expect(rootTabs()[0]).toMatchObject({ cmd: "claude", kind: "agent", cwd: "/r" });
    expect(docks().calendar).toEqual({ key: rootTabs()[0].key, open: true });
    expect(docks().todo).toEqual({ key: null, open: false });
    expect(result.current.tab?.key).toBe(rootTabs()[0].key);
    expect(result.current.showColumn).toBe(true);
    // A root tab, not one in the project underneath.
    expect(useTabsStore.getState().tabsByScope.p1).toBeUndefined();
  });

  it("does nothing while its overlay is not up, and probes nothing", async () => {
    await mount("mail", false);

    expect(chord("mail", 0)).toBe(false);
    expect(rootTabs()).toHaveLength(0);
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("list_agents");
  });

  it("holds a chord that beats the agent probe and docks once it lands", async () => {
    renderHook(() => useOverlayAgent("todo", true));

    expect(chord("todo", 0)).toBe(true);
    await waitFor(() => expect(docks().todo.open).toBe(true));
    expect(rootTabs().map((tab) => tab.cmd)).toEqual(["claude"]);
  });

  it("restores an unhydrated root before docking the new tab in it", async () => {
    useTabsStore.setState({ tabsByScope: {}, layoutByScope: {}, focusedGroupByScope: {} });
    backend.snapshot = { tabLayout: [{ label: "Saved shell", cmd: "", cwd: "/r", kind: "shell" }] };
    await mount("calendar");

    expect(chord("calendar", 0)).toBe(true);

    await waitFor(() => expect(docks().calendar.open).toBe(true));
    expect(rootTabs().map((tab) => tab.label)).toEqual(["Saved shell", "Claude"]);
    expect(docks().calendar.key).toBe(rootTabs()[1].key);
  });

  it("re-shows a closed column on the same live agent instead of minting a tab", async () => {
    const { result } = await mount("calendar");
    chord("calendar", 0);
    const key = docks().calendar.key;
    const before = result.current.focusRequest;
    act(() => useOverlayAgentStore.getState().hide("calendar"));
    expect(result.current.showColumn).toBe(false);

    expect(chord("calendar", 0)).toBe(true);

    expect(rootTabs()).toHaveLength(1);
    expect(docks().calendar).toEqual({ key, open: true });
    expect(result.current.focusRequest).toBeGreaterThan(before);
  });

  it("mints a new tab for a different agent; the old one stays in root", async () => {
    await mount("calendar");
    chord("calendar", 0);
    const first = docks().calendar.key;
    act(() => useOverlayAgentStore.getState().hide("calendar"));

    expect(chord("calendar", 1)).toBe(true);

    expect(rootTabs().map((tab) => tab.cmd)).toEqual(["claude", "codex"]);
    expect(docks().calendar.key).not.toBe(first);
    expect(docks().calendar.key).toBe(rootTabs()[1].key);
    expect(docks().calendar.open).toBe(true);
  });

  it("mints a new tab when the docked agent's program has exited, and reuses a respawned one", async () => {
    await mount("calendar");
    chord("calendar", 0);
    const first = docks().calendar.key!;
    act(() => useOverlayAgentStore.getState().hide("calendar"));
    act(() => bus.exit.get(`root:${first}`)?.());

    chord("calendar", 0);

    expect(rootTabs()).toHaveLength(2);
    const second = docks().calendar.key!;
    expect(second).not.toBe(first);

    // The same PTY id coming back up makes a tab live again.
    act(() => useOverlayAgentStore.getState().hide("calendar"));
    act(() => bus.exit.get(`root:${second}`)?.());
    act(() => bus.ready.get(`root:${second}`)?.());
    chord("calendar", 0);
    expect(rootTabs()).toHaveLength(2);
    expect(docks().calendar).toEqual({ key: second, open: true });
  });

  it("mints a new tab when the column is already showing one", async () => {
    await mount("calendar");
    chord("calendar", 0);
    chord("calendar", 0);
    expect(rootTabs()).toHaveLength(2);
    expect(docks().calendar.key).toBe(rootTabs()[1].key);
  });

  it("answers Ctrl+1 with a hint when the default agent is not root-allowed", async () => {
    settings({ root_agents: ["codex"] });
    const { result } = await mount("todo");

    expect(chord("todo", 0)).toBe(true);

    expect(rootTabs()).toHaveLength(0);
    expect(result.current.hint).toBe(
      "Allow Claude in the root console: Models & agents → Root chip",
    );
    expect(result.current.showColumn).toBe(true);

    act(() => result.current.dismissHint());
    expect(result.current.hint).toBeNull();
  });

  it("lets any other agent number with no agent behind it pass on", async () => {
    await mount("todo");
    expect(chord("todo", 5)).toBe(false);
    expect(rootTabs()).toHaveLength(0);
  });

  it("forgets the hint when the overlay goes away", async () => {
    settings({ root_agents: [] });
    const { result, rerender } = await mount("mail");
    chord("mail", 0);
    expect(result.current.hint).not.toBeNull();
    rerender({ on: false });
    expect(result.current.hint).toBeNull();
    expect(chord("mail", 0)).toBe(false);
  });

  describe("toggle (the title-bar button)", () => {
    it("acts as Ctrl+1 with nothing docked, hides an open column, re-shows a live one", async () => {
      const { result } = await mount("calendar");

      act(() => result.current.toggle());
      expect(rootTabs()).toHaveLength(1);
      const key = docks().calendar.key;
      expect(docks().calendar).toEqual({ key, open: true });

      act(() => result.current.toggle());
      expect(docks().calendar).toEqual({ key, open: false });

      act(() => result.current.toggle());
      expect(docks().calendar).toEqual({ key, open: true });
      expect(rootTabs()).toHaveLength(1);
    });

    it("re-shows a docked live agent even when it is not slot 1's", async () => {
      const { result } = await mount("calendar");
      chord("calendar", 1);
      const key = docks().calendar.key;
      act(() => result.current.toggle());
      act(() => result.current.toggle());
      expect(docks().calendar).toEqual({ key, open: true });
      expect(rootTabs()).toHaveLength(1);
    });
  });
});
