/**
 * Stopping and waking one agent tab (`stores/agents/agentTabStop`): the
 * guards are read again at the call, the tab's own minted tmux session is
 * ended (never an attach), a wake waits for that kill and respawns on the
 * resume args, and the last-use mark moves only in coarse steps.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(undefined)) }));

import { invoke } from "@tauri-apps/api/core";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { useProjectsStore } from "../../stores/projects";
import { useActivityStore } from "../../stores/activity";
import { useAgentSchedulesStore, scheduleCacheKey } from "../../stores/agents/agentSchedules";
import { usePrintRequestsStore } from "../../stores/printRequests";
import {
  LAST_USED_STEP_MS,
  _resetAgentTabStopForTest,
  ensureAgentTabAwake,
  noteAgentTabUsed,
  promptQueued,
  stopAgentTab,
  wakeAgentTab,
} from "../../stores/agents/agentTabStop";
import { _resetAgentTabStopMarksForTest, noteAgentPaneShown, noteAgentTabStarted } from "../../lib/agents/agentTabStopMarks";
import type { ProjectEntry } from "../../types";
import { BRAND } from "../../lib/brand";
import type { ScheduledAgentPrompt } from "../../lib/agents/agentSchedule";

const SCOPE = "p1";
const SESSION = "00000000-0000-4000-8000-0000000000bb";
const TARGET = "target-1";
const PINNED = { resumePinned: true, runningSubagents: 0, markupAsk: false };

function agent(over: Partial<TabEntry> = {}): TabEntry {
  return {
    key: "agent-1",
    label: "Claude",
    cmd: "claude",
    cwd: "/p",
    kind: "agent",
    sessionId: SESSION,
    scheduleTargetId: TARGET,
    tmuxSession: `${BRAND.slug}-p1-agent-x`,
    ...over,
  };
}
const tabNow = () => useTabsStore.getState().tabsByScope[SCOPE]?.[0];
const tmuxKills = () => vi.mocked(invoke).mock.calls.filter(([c]) => c === "local_tmux_kill").map(([, a]) => (a as { session: string }).session);

function setTab(tab: TabEntry) {
  useTabsStore.setState({
    scope: SCOPE,
    tabsByScope: { [SCOPE]: [tab] },
    layoutByScope: { [SCOPE]: { type: "group", id: "g1", tabKeys: [tab.key], activeKey: tab.key } },
    focusedGroupByScope: {},
  });
}

beforeEach(() => {
  vi.mocked(invoke).mockClear();
  _resetAgentTabStopForTest();
  _resetAgentTabStopMarksForTest();
  useProjectsStore.setState({
    projects: [{ id: SCOPE, name: "P", path: "/p", status: "active" } as unknown as ProjectEntry],
    activeId: SCOPE,
  });
  useActivityStore.setState({ busyByTab: {}, attentionByTab: {} });
  useAgentSchedulesStore.setState({ byTarget: { [scheduleCacheKey(SCOPE, TARGET)]: [] } });
  usePrintRequestsStore.setState({ requests: [] });
  setTab(agent());
});

describe("stopAgentTab", () => {
  it("stops a quiet tab and ends its own minted tmux session", async () => {
    expect(stopAgentTab(SCOPE, "agent-1", PINNED, "cap")).toEqual([]);
    expect(tabNow()?.stopped).toBe(true);
    await Promise.resolve();
    expect(tmuxKills()).toEqual([`${BRAND.slug}-p1-agent-x`]);
  });

  it("never ends a session the tab only attached to", () => {
    setTab(agent({ tmuxAttach: "work" }));
    expect(stopAgentTab(SCOPE, "agent-1", PINNED)).toContain("attach");
    expect(tmuxKills()).toEqual([]);
  });

  it("refuses while a guard holds at the call", () => {
    useActivityStore.setState({ attentionByTab: { [`${SCOPE}:agent-1`]: "decision" } });
    expect(stopAgentTab(SCOPE, "agent-1", PINNED)).toContain("decision");
    expect(tabNow()?.stopped).toBeUndefined();

    useActivityStore.setState({ attentionByTab: {} });
    noteAgentPaneShown(`${SCOPE}:agent-1`, true);
    expect(stopAgentTab(SCOPE, "agent-1", PINNED)).toContain("shown");

    noteAgentPaneShown(`${SCOPE}:agent-1`, false);
    noteAgentTabStarted(`${SCOPE}:agent-1`);
    expect(stopAgentTab(SCOPE, "agent-1", PINNED)).toContain("fresh");
    expect(tmuxKills()).toEqual([]);
  });

  it("refuses without the backend's word that a respawn resumes the tab's conversation", () => {
    expect(stopAgentTab(SCOPE, "agent-1", { resumePinned: false })).toContain("no_conversation");
    expect(stopAgentTab(SCOPE, "agent-1", {})).toContain("no_conversation");
    expect(tabNow()?.stopped).toBeUndefined();
  });

  it("refuses for a pending print card and a schedule list not loaded yet", () => {
    usePrintRequestsStore.setState({ requests: [{ tab: `${SCOPE}:agent-1` } as never] });
    expect(stopAgentTab(SCOPE, "agent-1", PINNED)).toContain("print");
    usePrintRequestsStore.setState({ requests: [] });
    useAgentSchedulesStore.setState({ byTarget: {} });
    expect(stopAgentTab(SCOPE, "agent-1", PINNED)).toContain("queued");
  });

  it("never stops a container project's tab", () => {
    useProjectsStore.setState({
      projects: [{ id: SCOPE, name: "P", path: "/p", status: "active", sandbox: { enabled: true } } as unknown as ProjectEntry],
    });
    expect(stopAgentTab(SCOPE, "agent-1", PINNED)).toContain("container");
  });
});

describe("wakeAgentTab", () => {
  it("respawns on the resume args with the first prompt cleared", () => {
    setTab(agent({ stopped: true, initialInput: "go\r", args: ["--session-id", SESSION] }));
    expect(wakeAgentTab(SCOPE, "agent-1")).toBe(true);
    expect(tabNow()?.stopped).toBeUndefined();
    expect(tabNow()?.initialInput).toBeUndefined();
    expect(tabNow()?.args).toEqual(["--resume", SESSION]);
    expect(wakeAgentTab(SCOPE, "agent-1")).toBe(false);
  });

  it("waits for the tab's session kill before it respawns", async () => {
    let finish: () => void = () => {};
    vi.mocked(invoke).mockImplementationOnce(() => new Promise<undefined>((resolve) => (finish = () => resolve(undefined))));
    stopAgentTab(SCOPE, "agent-1", PINNED);
    expect(wakeAgentTab(SCOPE, "agent-1")).toBe(false);
    expect(tabNow()?.stopped).toBe(true);
    finish();
    await vi.waitFor(() => expect(tabNow()?.stopped).toBeUndefined());
    expect(tabNow()?.relaunchSeq).toBe(1);
  });
});

describe("ensureAgentTabAwake", () => {
  it("wakes a stopped tab and gives up at the timeout while no input registers", async () => {
    setTab(agent({ stopped: true }));
    expect(await ensureAgentTabAwake(TARGET, 10)).toBe(false);
    expect(tabNow()?.stopped).toBeUndefined();
    expect(await ensureAgentTabAwake("nobody", 10)).toBe(false);
  });
});

describe("noteAgentTabUsed", () => {
  it("moves the mark only in coarse steps", () => {
    noteAgentTabUsed(SCOPE, "agent-1", 1_000_000);
    expect(tabNow()?.lastUsedAt).toBe(1_000_000);
    noteAgentTabUsed(SCOPE, "agent-1", 1_000_000 + LAST_USED_STEP_MS - 1);
    expect(tabNow()?.lastUsedAt).toBe(1_000_000);
    noteAgentTabUsed(SCOPE, "agent-1", 1_000_000 + LAST_USED_STEP_MS);
    expect(tabNow()?.lastUsedAt).toBe(1_000_000 + LAST_USED_STEP_MS);
  });
});

describe("promptQueued", () => {
  const now = new Date(2026, 10, 18, 12, 0, 0);
  const at = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const once = (when: Date, over: Partial<ScheduledAgentPrompt> = {}): ScheduledAgentPrompt =>
    ({ id: "s", enabled: true, message: "m", rule: { type: "once", at: at(when) }, ...over }) as ScheduledAgentPrompt;

  it("holds for a due rule, one due soon, and an agent's proposal", () => {
    expect(promptQueued([once(now)], now)).toBe(true);
    expect(promptQueued([once(new Date(now.getTime() + 10 * 60_000))], now)).toBe(true);
    expect(promptQueued([once(now, { enabled: false, origin: { by: "agent" } } as Partial<ScheduledAgentPrompt>)], now)).toBe(true);
  });

  it("lets a rule far off and none at all pass", () => {
    expect(promptQueued([once(new Date(now.getTime() + 3 * 3_600_000))], now)).toBe(false);
    expect(promptQueued([], now)).toBe(false);
  });
});
