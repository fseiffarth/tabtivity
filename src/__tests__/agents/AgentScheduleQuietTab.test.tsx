/**
 * A prompt sent at an agent tab has to reach it whether or not anyone is
 * looking at that tab.
 *
 * Both regressions here are the same shape — a gate that reads "nothing has
 * happened yet" as "something is happening right now", and so never opens:
 *
 *  - The delivery settle gate treated a PTY with NO recorded output as one that
 *    had produced output this instant, so a tab whose whole TUI arrived as a
 *    restored snapshot (nothing streamed since) was never deliverable at all.
 *  - The completion wait blocks subsequent prompts until an explicit, stable
 *    done event. Its former ten-minute timeout let a slow agent receive the
 *    next prompt while still working; silence must never release that wait.
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
import {
  _clearScheduledAgentInputsForTest,
  registerScheduledAgentInput,
} from "../../lib/agents/scheduledAgentInput";
import { _clearPtyActivityForTest, noteAgentTurn, useActivityStore } from "../../stores/activity";
import { useAgentPromptsStore } from "../../stores/agents/agentPrompts";
import { useAgentSchedulesStore } from "../../stores/agents/agentSchedules";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { _grantTimerLeaseForTest } from "../../stores/timerLease";

const invokeMock = vi.mocked(invoke);
const writeMock = vi.mocked(writePtyInput);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);

const agent: TabEntry = {
  key: "agent-1",
  label: "Claude",
  cmd: "claude",
  cwd: "/project",
  kind: "agent",
  sessionId: "session-1",
  scheduleTargetId: "target-1",
};

/** A "Send to this tab": a one-time rule at a minute that has just passed. */
function sendNow(id: string, message: string) {
  return { id, enabled: true, message, rule: { type: "once", at: "2026-09-01T08:59" } };
}

function delivered(): string[] {
  return writeMock.mock.calls.map(([, bytes]) => decode(bytes));
}

/** Let the host's async delivery run: its writes are chained through short
 *  timers, so one advance is not enough to reach the last of them. */
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

describe("delivering to a tab nobody is watching", () => {
  it("advances a cross-tab chain only after completion plus five idle minutes, preserving edge commands", async () => {
    const review = { id: "review", message: "Review the result", created_at: "x", updated_at: "x" };
    invokeMock.mockImplementation((command, args) => Promise.resolve(
      command === "agent_schedules_list" && (args as { scheduleTargetId: string }).scheduleTargetId === "target-1"
        ? [sendNow("prompt-1", "first prompt")]
        : command === "agent_schedule_claim" ? true
        : command === "agent_prompts_list" ? [review]
        : command === "agent_prompt_links_list" ? [{ id: "edge", from: "prompt-1", to: "review", kind: "after", target: "target-2", preface: ["/clear"] }]
        : [],
    ));
    useTabsStore.setState({ tabsByScope: { p: [agent, { ...agent, key: "agent-2", scheduleTargetId: "target-2" }] } });
    registerScheduledAgentInput("target-1", {
      ptyId: "p:agent-1", ready: () => true, bracketedPaste: () => false,
      recordAuthorizedInput: () => noteAgentTurn("p:agent-1", "working"),
    });
    const queued = () => invokeMock.mock.calls.filter(([name]) => name === "agent_schedule_upsert");
    await act(async () => { render(<AgentScheduleHost />); });
    await act(async () => { await settle(); });
    expect(delivered().join("")).toContain("first prompt");
    expect(queued()).toEqual([]);
    // Stop just before a sweep: not yet stable.
    await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
    act(() => noteAgentTurn("p:agent-1", "done"));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(queued()).toEqual([]);
    // A resumed turn or approval invalidates that Stop.
    act(() => noteAgentTurn("p:agent-1", "working"));
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(queued()).toEqual([]);
    act(() => noteAgentTurn("p:agent-1", "decision"));
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(queued()).toEqual([]);
    act(() => noteAgentTurn("p:agent-1", "done"));
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(queued()).toEqual([]);
    // A finished turn is not enough: the tab must then stay idle for five
    // minutes, and a turn inside that window restarts it.
    await act(async () => { await vi.advanceTimersByTimeAsync(4 * 60_000); });
    expect(queued()).toEqual([]);
    act(() => noteAgentTurn("p:agent-1", "working"));
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    act(() => noteAgentTurn("p:agent-1", "done"));
    await act(async () => { await vi.advanceTimersByTimeAsync(4 * 60_000 + 30_000); });
    expect(queued()).toEqual([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
    expect(queued()).toHaveLength(1);
    expect(queued()[0][1]).toMatchObject({ scheduleTargetId: "target-2", schedule: { id: "review", preface: ["/clear"] } });
  });

  it("sends to a ready tab that has produced no output this session", async () => {
    invokeMock.mockImplementation((command) =>
      Promise.resolve(command === "agent_schedules_list"
        ? [sendNow("prompt-1", "check the build")]
        : command === "agent_schedule_claim"
          ? true
          : []),
    );
    registerScheduledAgentInput("target-1", {
      ptyId: "p:agent-1",
      ready: () => true,
      bracketedPaste: () => false,
      recordAuthorizedInput: () => {},
    });

    await act(async () => {
      render(<AgentScheduleHost />);
    });
    await act(async () => { await settle(); });

    expect(delivered().join("")).toContain("check the build");
  });

  it("never releases the next prompt on silence or a timeout; waits for stable explicit completion", async () => {
    let schedules = [sendNow("prompt-1", "first prompt")];
    invokeMock.mockImplementation((command) =>
      Promise.resolve(command === "agent_schedules_list"
        ? schedules
        : command === "agent_schedule_claim"
          ? true
          : []),
    );
    registerScheduledAgentInput("target-1", {
      ptyId: "p:agent-1",
      ready: () => true,
      bracketedPaste: () => false,
      recordAuthorizedInput: () => {},
    });

    await act(async () => {
      render(<AgentScheduleHost />);
    });
    await act(async () => { await settle(); });
    expect(delivered().join("")).toContain("first prompt");

    // Silence, even beyond the old ten-minute bypass, is not completion.
    writeMock.mockClear();
    schedules = [sendNow("prompt-2", "second prompt")];
    useAgentSchedulesStore.setState({ byTarget: {} });
    await act(async () => { await vi.advanceTimersByTimeAsync(11 * 60_000); });
    await act(async () => { await settle(); });

    expect(delivered()).toEqual([]);
    act(() => noteAgentTurn("p:agent-1", "working"));
    act(() => noteAgentTurn("p:agent-1", "decision"));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(delivered()).toEqual([]);
    act(() => noteAgentTurn("p:agent-1", "working"));
    act(() => noteAgentTurn("p:agent-1", "done"));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(delivered().join("")).toContain("second prompt");
  });
});
