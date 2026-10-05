/**
 * A restored agent tab must carry its schedule-target binding. The id used to
 * be computed on `loadFromLayout`'s resume-check helper object only, so every
 * restored agent tab came back without one: the desktop hid its ◷, the mobile
 * bridge answered `tab_not_found`, and the startup orphan sweep — which keeps
 * only targets found on live tabs or in the saved layout — emptied
 * `agent_tasks.json` on every launch.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { toSavedTabEntry, useTabsStore, type SavedTabEntry } from "../../stores/tabs";
import { persistScopeLayout, useAgentSchedulesStore } from "../../stores/agents/agentSchedules";
import { useProjectsStore } from "../../stores/projects";

const invokeMock = vi.mocked(invoke);

const agent = (key: string, extra: Partial<SavedTabEntry> = {}): SavedTabEntry => ({
  key,
  label: "Claude",
  cmd: "claude",
  cwd: "/tmp/p",
  kind: "agent",
  sessionId: `session-${key}`,
  ...extra,
});

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
  useTabsStore.setState({
    scope: "p",
    tabsByScope: {},
    layoutByScope: {},
    focusedGroupByScope: {},
    detachedGroupsByScope: {},
    hiddenGroupsByScope: {},
  });
});

describe("schedule target ids on restore", () => {
  it("keeps a persisted id and mints one for a layout written before schedules existed", () => {
    useTabsStore.getState().loadFromLayout(
      [agent("a", { scheduleTargetId: "keep-me" }), agent("b"), { key: "c", label: "Shell", cmd: "", cwd: "/tmp/p", kind: "shell" }],
      "/tmp/p",
      "p",
    );
    const tabs = useTabsStore.getState().tabsByScope.p;
    const [kept, minted, shell] = tabs;
    expect(kept.scheduleTargetId).toBe("keep-me");
    expect(minted.scheduleTargetId).toMatch(/^[0-9a-f-]{36}$/);
    expect(shell.scheduleTargetId).toBeUndefined();
    // …and the id is what goes back to disk, so the binding survives a relaunch.
    expect(toSavedTabEntry(kept).scheduleTargetId).toBe("keep-me");
    expect(toSavedTabEntry(minted).scheduleTargetId).toBe(minted.scheduleTargetId);
  });
});

describe("persisting the binding", () => {
  it("writes the project's scope with its local file after a schedule is saved", async () => {
    useProjectsStore.setState({
      projects: [{ id: "p", name: "P", status: "active", position: 1, local_file: "/tmp/p/project.json" }],
      loaded: true,
    });
    useTabsStore.getState().loadFromLayout([agent("a")], "/tmp/p", "p");
    await persistScopeLayout("p");
    const save = invokeMock.mock.calls.find(([command]) => command === "workspace_sync");
    expect(save).toBeDefined();
    const args = save?.[1] as { projectId: string; localFile: string; tabs: SavedTabEntry[] };
    expect(args.projectId).toBe("p");
    expect(args.localFile).toBe("/tmp/p/project.json");
    expect(args.tabs[0].scheduleTargetId).toBe(useTabsStore.getState().tabsByScope.p[0].scheduleTargetId);
  });

  it("is triggered by the desktop store's upsert", async () => {
    invokeMock.mockImplementation((command: string) =>
      Promise.resolve(command === "agent_schedule_upsert" ? [] : undefined),
    );
    useTabsStore.getState().loadFromLayout([agent("a")], "/tmp/p", "p");
    await useAgentSchedulesStore.getState().upsert("p", "target", {
      id: "s1",
      enabled: true,
      message: "hello",
      rule: { type: "daily", time: "09:00" },
    });
    await Promise.resolve();
    expect(invokeMock.mock.calls.some(([command]) => command === "workspace_sync")).toBe(true);
  });
});
