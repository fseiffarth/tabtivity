/**
 * The wake paths into a stopped agent tab (`docs/done/agent_tab_stop_plan.md` §4):
 * a due scheduled prompt wakes it and is delivered on a later tick once its
 * input registers — never before — and the phone opening it wakes it.
 */
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../lib/terminal/terminalInput", () => ({
  writePtyInput: vi.fn(() => Promise.resolve()),
}));

import { AgentScheduleHost } from "../../components/layout/AgentScheduleHost";
import { writePtyInput } from "../../lib/terminal/terminalInput";
import { _clearScheduledAgentInputsForTest, registerScheduledAgentInput } from "../../lib/agents/scheduledAgentInput";
import { _clearPtyActivityForTest, useActivityStore } from "../../stores/activity";
import { useAgentPromptsStore } from "../../stores/agents/agentPrompts";
import { useAgentSchedulesStore } from "../../stores/agents/agentSchedules";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { _grantTimerLeaseForTest } from "../../stores/timerLease";
import { _resetAgentTabStopForTest, wakeStoppedForInput } from "../../stores/agents/agentTabStop";

const invokeMock = vi.mocked(invoke);
const writeMock = vi.mocked(writePtyInput);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);

const SESSION = "00000000-0000-4000-8000-0000000000cc";
const agent: TabEntry = {
  key: "agent-1",
  label: "Claude",
  cmd: "claude",
  cwd: "/project",
  kind: "agent",
  sessionId: SESSION,
  scheduleTargetId: "target-1",
  stopped: true,
  initialInput: "old first prompt\r",
};
const tabNow = () => useTabsStore.getState().tabsByScope.p?.[0];
const delivered = () => writeMock.mock.calls.map(([, bytes]) => decode(bytes)).join("");

async function settle(): Promise<void> {
  for (let step = 0; step < 20; step += 1) await vi.advanceTimersByTimeAsync(100);
}

beforeEach(() => {
  _grantTimerLeaseForTest();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-01T09:00:30"));
  invokeMock.mockReset();
  writeMock.mockReset();
  writeMock.mockResolvedValue(undefined);
  _clearScheduledAgentInputsForTest();
  _clearPtyActivityForTest();
  _resetAgentTabStopForTest();
  useAgentSchedulesStore.setState({ byTarget: {}, loading: {} });
  useAgentPromptsStore.setState({ byProject: {}, historyByProject: {}, loading: {} });
  useActivityStore.setState({ busyByTab: {}, attentionByTab: {} });
  useTabsStore.setState({
    scope: "p",
    tabsByScope: { p: [agent] },
    layoutByScope: { p: null },
    focusedGroupByScope: { p: null },
    detachedGroupsByScope: {},
    hiddenGroupsByScope: {},
    pendingRespawnByScope: {},
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a due prompt for a stopped tab", () => {
  it("wakes the tab, and goes in on a later tick once its input is up", async () => {
    invokeMock.mockImplementation((command) =>
      Promise.resolve(
        command === "agent_schedules_list"
          ? [{ id: "s1", enabled: true, message: "wake and work", rule: { type: "once", at: "2026-09-01T08:59" } }]
          : command === "agent_schedule_claim"
            ? true
            : [],
      ),
    );
    await act(async () => {
      render(<AgentScheduleHost />);
    });
    await act(async () => {
      await settle();
    });
    // Woken on its resume args, the old first prompt not typed again…
    expect(tabNow()?.stopped).toBeUndefined();
    expect(tabNow()?.args).toEqual(["--resume", SESSION]);
    expect(tabNow()?.initialInput).toBeUndefined();
    // …and nothing delivered while no input is registered.
    expect(delivered()).toBe("");
    expect(invokeMock.mock.calls.some(([c]) => c === "agent_schedule_claim")).toBe(false);

    // The respawned pane registers its input; the next sweep delivers.
    registerScheduledAgentInput("target-1", { ptyId: "p:agent-1", ready: () => true, bracketedPaste: () => false, recordAuthorizedInput: () => {} });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
      await settle();
    });
    expect(delivered()).toContain("wake and work");
  });
});

describe("typing into a stopped tab off screen", () => {
  it("wakes it first and waits for its input", async () => {
    let done = false;
    void wakeStoppedForInput("target-1").then(() => (done = true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(tabNow()?.stopped).toBeUndefined();
    expect(done).toBe(false);
    registerScheduledAgentInput("target-1", { ptyId: "p:agent-1", ready: () => true, bracketedPaste: () => false, recordAuthorizedInput: () => {} });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(done).toBe(true);
  });

  it("does nothing for a tab that is not stopped", async () => {
    useTabsStore.setState({ tabsByScope: { p: [{ ...agent, stopped: undefined }] } });
    await wakeStoppedForInput("target-1");
    expect(tabNow()?.relaunchSeq).toBeUndefined();
  });
});
