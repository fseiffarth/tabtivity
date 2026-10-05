/**
 * End-to-end (store-level) round-trip for resumable agent sessions. A Claude
 * agent tab carrying a sessionId is saved via `saveLayout` (the persisted `tabs`
 * / `groups` args are captured from the mocked `save_tab_layout` invoke), then
 * fed straight back into `loadFromLayout`. The agent tab must come back with the
 * same sessionId and respawn with `--resume <id>` args. This locks the save side
 * (Agent 2) and the restore side (Agent 3) together so the feature can't regress
 * in halves.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import {
  useTabsStore,
  type SavedLayoutTree,
  type SavedTabEntry,
} from "../../stores/tabs";

const invokeMock = vi.mocked(invoke);

function resetStore() {
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

describe("resume session save → restore round-trip", () => {
  beforeEach(() => {
    invokeMock.mockClear();
    resetStore();
  });

  it("restores a Claude agent tab with its sessionId and --resume args", async () => {
    const SESSION = "11111111-2222-3333-4444-555555555555";

    // 1. Populate the store with a Claude agent tab (with a sessionId) plus a
    //    plain shell tab, then save.
    const store = useTabsStore.getState();
    store.setScope("p");
    store.addTab({
      label: "claude",
      cmd: "claude",
      cwd: "/p",
      kind: "agent",
      sessionId: SESSION,
    });
    store.addTab({ label: "bash", cmd: "bash", cwd: "/p", kind: "shell" });

    await useTabsStore.getState().saveLayout("/p/project.json");

    // 2. Capture what was persisted.
    const call = invokeMock.mock.calls.find((c) => c[0] === "workspace_sync");
    expect(call).toBeTruthy();
    const arg = call![1] as {
      tabs: SavedTabEntry[];
      groups: SavedLayoutTree | null;
    };
    const savedClaude = arg.tabs.find((t) => t.cmd === "claude");
    expect(savedClaude?.sessionId).toBe(SESSION);

    // 3. Feed the persisted layout back into a fresh store via loadFromLayout.
    resetStore();
    useTabsStore.getState().loadFromLayout(arg.tabs, "/p", "p", arg.groups ?? undefined);

    // 4. The agent tab comes back with the same sessionId and resume args.
    const restored = useTabsStore.getState().tabsByScope["p"] ?? [];
    const agent = restored.find((t) => t.cmd === "claude");
    expect(agent).toBeTruthy();
    expect(agent!.sessionId).toBe(SESSION);
    expect(agent!.args).toEqual(["--resume", SESSION]);
    expect(agent!.kind).toBe("agent");

    // The shell tab still round-trips with no resume args.
    const shell = restored.find((t) => t.cmd === "bash");
    expect(shell).toBeTruthy();
    expect(shell!.args).toEqual([]);
  });
});
