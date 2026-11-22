/**
 * Stopped agent tabs, the pane layer (`docs/done/agent_tab_stop_plan.md` §3–§4):
 * a stopped tab's slot renders `StoppedPane` — no `TabPane`, so nothing
 * spawns — a sleeping pane stopped has its parked PTY killed by the slot, and
 * a stopped tab shown wakes on its resume args in the same commit.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(undefined)) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    scaleFactor: () => Promise.resolve(1),
    innerPosition: () => Promise.resolve({ toLogical: () => ({ x: 0, y: 0 }) }),
    onMoved: () => Promise.resolve(() => {}),
    onResized: () => Promise.resolve(() => {}),
    onFocusChanged: () => Promise.resolve(() => {}),
  }),
}));
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const mounts = new Map<string, number>();
const mountedArgs = new Map<string, unknown>();
vi.mock("../../components/tabs/TabPane", () => {
  function TabPane(props: { tab: { key: string; args?: string[] } }) {
    const key = props.tab.key;
    useEffect(() => {
      mounts.set(key, (mounts.get(key) ?? 0) + 1);
      mountedArgs.set(key, props.tab.args);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <div data-testid={`pane-${key}`} />;
  }
  return { TabPane };
});

import { CenterPanel } from "../../components/layout/CenterPanel";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { useOverlayAgentStore } from "../../stores/overlayAgent";
import { useSettingsStore } from "../../stores/settings";
import { _clearAsleepPtysForTest, asleepPty } from "../../lib/terminal/sleepingPtys";
import { SLEEP_TABS_DEFAULT_MIN } from "../../lib/sleepWhenHidden";
import {
  _resetAgentTabStopMarksForTest,
  agentPaneLastShownAt,
  agentPaneShown,
  agentTabStartedAt,
  notePhoneSawTab,
  phoneSawTabAt,
} from "../../lib/agents/agentTabStopMarks";
import type { ProjectEntry } from "../../types";

const SCOPE = "p1";
const SESSION = "00000000-0000-4000-8000-0000000000aa";
const st = () => useTabsStore.getState();
const isMounted = (key: string) => document.querySelector(`[data-testid="pane-${key}"]`) != null;
const stoppedPanes = () => document.querySelectorAll("[data-stopped]").length;
const kills = () => vi.mocked(invoke).mock.calls.filter(([c]) => c === "pty_kill").map(([, a]) => (a as { id: string }).id);
let agentKey: string;
let shellKey: string;

async function mount() {
  render(<CenterPanel />);
  await act(async () => {});
}

beforeEach(() => {
  cleanup();
  vi.useFakeTimers();
  mounts.clear();
  mountedArgs.clear();
  _clearAsleepPtysForTest();
  _resetAgentTabStopMarksForTest();
  vi.mocked(invoke).mockClear();
  localStorage.clear();
  useSettingsStore.setState({ settings: null });
  useRemoteStatusStore.setState({ byProject: {}, byHost: {} });
  useProjectsStore.setState({
    projects: [{ id: SCOPE, name: "P", path: "/p", status: "active" } as unknown as ProjectEntry],
    activeId: SCOPE,
    rootDir: "/r",
  });
  useTabsStore.setState({
    scope: SCOPE,
    tabsByScope: { [SCOPE]: [] },
    layoutByScope: { [SCOPE]: null },
    focusedGroupByScope: { [SCOPE]: null },
    detachedGroupsByScope: {},
    fullscreenGroupId: null,
  });
  st().setScope(SCOPE);
  agentKey = st().addTabToScope(SCOPE, {
    label: "Claude",
    cmd: "claude",
    cwd: "/p",
    kind: "agent",
    sessionId: SESSION,
    args: ["--session-id", SESSION],
    initialInput: "first prompt\r",
  } as Omit<TabEntry, "key">).key;
  // A shell last, so it is the visible tab and the agent is hidden.
  shellKey = st().addTabToScope(SCOPE, { label: "Shell", cmd: "bash", cwd: "/p", kind: "shell" }).key;
  useRootOverlayStore.setState({ open: false, installTabs: {} });
  useOverlayAgentStore.setState({ shownKeys: new Set() });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a stopped agent tab's pane", () => {
  it("renders StoppedPane and no TabPane while hidden", async () => {
    await mount();
    expect(isMounted(agentKey)).toBe(true);
    expect(agentTabStartedAt(`${SCOPE}:${agentKey}`)).toBeDefined();
    await act(async () => {
      st().setTabStopped(SCOPE, agentKey, true);
    });
    expect(isMounted(agentKey)).toBe(false);
    expect(stoppedPanes()).toBe(1);
    expect(st().tabsByScope[SCOPE]?.find((t) => t.key === agentKey)?.stopped).toBe(true);
    // The shell is untouched.
    expect(isMounted(shellKey)).toBe(true);
  });

  it("wakes on its resume args, its first prompt cleared, the render it is shown", async () => {
    await mount();
    await act(async () => {
      st().setTabStopped(SCOPE, agentKey, true);
    });
    await act(async () => {
      st().setActive(agentKey);
    });
    const tab = st().tabsByScope[SCOPE]?.find((t) => t.key === agentKey);
    expect(tab?.stopped).toBeUndefined();
    expect(tab?.initialInput).toBeUndefined();
    expect(tab?.args).toEqual(["--resume", SESSION]);
    expect(isMounted(agentKey)).toBe(true);
    expect(mountedArgs.get(agentKey)).toEqual(["--resume", SESSION]);
    expect(stoppedPanes()).toBe(0);
    expect(agentPaneShown(`${SCOPE}:${agentKey}`)).toBe(true);
  });

  it("kills the parked PTY of a sleeping pane that is stopped", async () => {
    await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SLEEP_TABS_DEFAULT_MIN * 60_000);
    });
    const ptyId = `${SCOPE}:${agentKey}`;
    expect(asleepPty(ptyId)).toBeDefined();
    await act(async () => {
      st().setTabStopped(SCOPE, agentKey, true);
    });
    expect(kills()).toEqual([ptyId]);
    expect(asleepPty(ptyId)).toBeUndefined();
    expect(stoppedPanes()).toBe(1);
  });

  it("forgets the tab's marks when the tab closes, never while it stays", async () => {
    await mount();
    const ptyId = `${SCOPE}:${agentKey}`;
    notePhoneSawTab(ptyId);
    await act(async () => {
      st().setActive(agentKey);
    });
    await act(async () => {
      st().setActive(shellKey);
    });
    expect(agentPaneLastShownAt(ptyId)).toBeDefined();
    expect(agentTabStartedAt(ptyId)).toBeDefined();
    expect(phoneSawTabAt(ptyId)).toBeDefined();
    await act(async () => {
      st().removeTabInScope(SCOPE, agentKey);
    });
    expect(agentPaneLastShownAt(ptyId)).toBeUndefined();
    expect(agentTabStartedAt(ptyId)).toBeUndefined();
    expect(phoneSawTabAt(ptyId)).toBeUndefined();
  });

  it("only agent tabs: a stopped flag on a shell is ignored", async () => {
    await mount();
    await act(async () => {
      useTabsStore.setState((s) => ({
        tabsByScope: {
          ...s.tabsByScope,
          [SCOPE]: (s.tabsByScope[SCOPE] ?? []).map((t) => (t.key === shellKey ? { ...t, stopped: true } : t)),
        },
      }));
    });
    expect(isMounted(shellKey)).toBe(true);
  });
});
