/**
 * The stop sweep (`AgentTabStopHost`, `docs/agent_tab_stop_plan.md` §6): with
 * fake timers and a mocked backend, it stops the least recently used tabs
 * past the cap, idle tabs and — while memory is low — the least recently used
 * whatever their idle time; it never stops a tab the backend says has no
 * conversation to resume; and after a relaunch it wakes the tabs whose
 * session survived, then the most recently used up to the cap.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(undefined)) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));

import { AgentTabStopHost } from "../../components/layout/AgentTabStopHost";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { restoreActiveProjectScopes, useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { _clearPtyActivityForTest, useActivityStore } from "../../stores/activity";
import { scheduleCacheKey, useAgentSchedulesStore } from "../../stores/agents/agentSchedules";
import { usePrintRequestsStore } from "../../stores/printRequests";
import { _resetAgentTabStopForTest } from "../../stores/agents/agentTabStop";
import { _resetAgentTabStopMarksForTest, noteRestoredStopped } from "../../lib/agents/agentTabStopMarks";
import type { ProjectEntry, Settings } from "../../types";
import { BRAND } from "../../lib/brand";

const SCOPE = "p1";
const HOUR = 3_600_000;
const NOW = new Date("2026-11-18T12:00:00").getTime();
const GiB = 1024 ** 3;

let pinned: (sessionId: string) => boolean;
let freeBytes: number;
let alive: string[];

function agent(n: number, over: Partial<TabEntry> = {}): TabEntry {
  return {
    key: `agent-${n}`,
    label: `Claude ${n}`,
    cmd: "claude",
    cwd: "/p",
    kind: "agent",
    sessionId: `00000000-0000-4000-8000-00000000000${n}`,
    scheduleTargetId: `target-${n}`,
    tmuxSession: `${BRAND.slug}-p1--agent-${n}`,
    ...over,
  };
}

function setTabs(tabs: TabEntry[]) {
  useTabsStore.setState({
    scope: SCOPE,
    tabsByScope: { [SCOPE]: tabs },
    layoutByScope: { [SCOPE]: { type: "group", id: "g1", tabKeys: tabs.map((t) => t.key), activeKey: tabs[0]?.key ?? null } },
    focusedGroupByScope: {},
  });
  useAgentSchedulesStore.setState({
    byTarget: Object.fromEntries(tabs.map((t) => [scheduleCacheKey(SCOPE, t.scheduleTargetId!), []])),
  });
}

const stoppedKeys = () => (useTabsStore.getState().tabsByScope[SCOPE] ?? []).filter((t) => t.stopped).map((t) => t.key).sort();
const settings = (s: Partial<Settings>) => useSettingsStore.setState({ settings: s as Settings, loaded: true });

async function run(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(console, "info").mockImplementation(() => {});
  pinned = () => true;
  freeBytes = 32 * GiB;
  alive = [];
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation((command: string, args?: unknown) => {
    const a = (args ?? {}) as Record<string, string>;
    switch (command) {
      case "agent_tab_resume_pinned":
        return Promise.resolve(pinned(a.sessionId));
      case "agent_tab_transcript":
        return Promise.resolve({ available: true, runningAgents: 0, entries: [] });
      case "markup_mcp_list":
        return Promise.resolve([]);
      case "machine_load_snapshot":
        return Promise.resolve({ supported: true, mem_total_bytes: 64 * GiB, mem_used_bytes: 64 * GiB - freeBytes });
      case "local_tmux_app_sessions":
        return Promise.resolve(alive);
      default:
        return Promise.resolve(undefined);
    }
  });
  _resetAgentTabStopForTest();
  _resetAgentTabStopMarksForTest();
  _clearPtyActivityForTest();
  useActivityStore.setState({ busyByTab: {}, attentionByTab: {}, lastDoneByTab: {}, lastWorkingByTab: {} });
  usePrintRequestsStore.setState({ requests: [] });
  useProjectsStore.setState({
    projects: [{ id: SCOPE, name: "P", path: "/p", status: "active" } as unknown as ProjectEntry],
    activeId: SCOPE,
  });
  settings({ stop_agent_tabs_cap: 0, stop_agent_tabs_idle_min: 0, stop_agent_tabs_min_free_mb: 0 });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the sweep", () => {
  it("stops the least recently used past the cap, after the first interval", async () => {
    settings({ stop_agent_tabs_cap: 2, stop_agent_tabs_idle_min: 0, stop_agent_tabs_min_free_mb: 0 });
    setTabs([1, 2, 3, 4].map((n) => agent(n, { lastUsedAt: NOW - n * HOUR })));
    render(<AgentTabStopHost />);
    await run(30_000);
    expect(stoppedKeys()).toEqual([]);
    await run(35_000);
    expect(stoppedKeys()).toEqual(["agent-3", "agent-4"]);
    const kills = vi.mocked(invoke).mock.calls.filter(([c]) => c === "local_tmux_kill").map(([, a]) => (a as { session: string }).session);
    expect(kills.sort()).toEqual([`${BRAND.slug}-p1--agent-3`, `${BRAND.slug}-p1--agent-4`]);
  });

  it("stops idle tabs only", async () => {
    settings({ stop_agent_tabs_cap: 0, stop_agent_tabs_idle_min: 120, stop_agent_tabs_min_free_mb: 0 });
    setTabs([agent(1, { lastUsedAt: NOW - HOUR }), agent(2, { lastUsedAt: NOW - 3 * HOUR })]);
    render(<AgentTabStopHost />);
    await run(65_000);
    expect(stoppedKeys()).toEqual(["agent-2"]);
  });

  it("stops for low memory at most three a sweep, idle or not", async () => {
    settings({ stop_agent_tabs_cap: 0, stop_agent_tabs_idle_min: 0, stop_agent_tabs_min_free_mb: 4096 });
    freeBytes = 1 * GiB;
    setTabs([1, 2, 3, 4, 5].map((n) => agent(n, { lastUsedAt: NOW - n * 60_000 })));
    render(<AgentTabStopHost />);
    await run(65_000);
    expect(stoppedKeys()).toEqual(["agent-3", "agent-4", "agent-5"]);
  });

  it("never stops a tab the backend says would not resume its conversation, and stops the next instead", async () => {
    settings({ stop_agent_tabs_cap: 2, stop_agent_tabs_idle_min: 0, stop_agent_tabs_min_free_mb: 0 });
    setTabs([1, 2, 3].map((n) => agent(n, { lastUsedAt: NOW - n * HOUR })));
    pinned = (id) => !id.endsWith("3");
    render(<AgentTabStopHost />);
    await run(65_000);
    expect(stoppedKeys()).toEqual(["agent-2"]);
  });

  it("leaves a Gemini tab and a tab with a decision open", async () => {
    settings({ stop_agent_tabs_cap: 0, stop_agent_tabs_idle_min: 30, stop_agent_tabs_min_free_mb: 0 });
    setTabs([agent(1, { cmd: "gemini", lastUsedAt: NOW - 5 * HOUR }), agent(2, { lastUsedAt: NOW - 5 * HOUR })]);
    useActivityStore.setState({ attentionByTab: { [`${SCOPE}:agent-2`]: "decision" } });
    render(<AgentTabStopHost />);
    await run(65_000);
    expect(stoppedKeys()).toEqual([]);
  });

  it("does nothing with every trigger off", async () => {
    setTabs([1, 2].map((n) => agent(n, { lastUsedAt: NOW - 10 * HOUR })));
    render(<AgentTabStopHost />);
    await run(130_000);
    expect(stoppedKeys()).toEqual([]);
    expect(vi.mocked(invoke).mock.calls.some(([c]) => c === "agent_tab_resume_pinned")).toBe(false);
  });
});

describe("the restore wake", () => {
  it("wakes surviving sessions first, then the most recently used up to the cap", async () => {
    settings({ stop_agent_tabs_cap: 3, stop_agent_tabs_idle_min: 0, stop_agent_tabs_min_free_mb: 0 });
    setTabs([
      agent(1, { stopped: true, lastUsedAt: NOW - 5 * HOUR }),
      agent(2, { stopped: true, lastUsedAt: NOW - 1 * HOUR }),
      agent(3, { stopped: true, lastUsedAt: NOW - 2 * HOUR }),
      agent(4, { stopped: true, lastUsedAt: NOW - 3 * HOUR }),
      agent(5, { lastUsedAt: NOW }),
    ]);
    alive = [`${BRAND.slug}-p1--agent-1`];
    noteRestoredStopped(SCOPE, ["agent-1", "agent-2", "agent-3", "agent-4"]);
    useProjectsStore.setState({ projects: [] });
    await restoreActiveProjectScopes();
    render(<AgentTabStopHost />);
    await run(6_000);
    // Live: agent-5, then agent-1 (its session survived), then agent-2.
    expect(stoppedKeys()).toEqual(["agent-3", "agent-4"]);
  });
});
