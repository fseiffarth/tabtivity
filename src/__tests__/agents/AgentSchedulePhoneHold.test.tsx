/**
 * A prompt the phone sent while the agent worked (`phoneHolds.ts`) goes into
 * the CLI's own queue at once, while the agent still works, as a prompt typed
 * then would. Every other rule keeps waiting for the agent's idle point.
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
import { _clearPhoneHoldsForTest, holdPhonePrompt } from "../../lib/agents/phoneHolds";
import { _clearPtyActivityForTest, noteAgentTurn, useActivityStore } from "../../stores/activity";
import { useAgentPromptsStore } from "../../stores/agents/agentPrompts";
import { useAgentSchedulesStore } from "../../stores/agents/agentSchedules";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { _grantTimerLeaseForTest } from "../../stores/timerLease";

const invokeMock = vi.mocked(invoke);
const writeMock = vi.mocked(writePtyInput);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);
const PTY = "p:agent-1";

const agent: TabEntry = {
  key: "agent-1", label: "Claude", cmd: "claude", cwd: "/project", kind: "agent",
  sessionId: "session-1", scheduleTargetId: "target-1",
};

function sendNow(id: string, message: string) {
  return { id, enabled: true, message, rule: { type: "once", at: "2026-09-01T09:00" } };
}
function delivered(): string {
  return writeMock.mock.calls.map(([, bytes]) => decode(bytes)).join("");
}
function completions(): unknown[] {
  return invokeMock.mock.calls.filter(([name]) => name === "agent_schedule_complete").map(([, args]) => args);
}
async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

let schedules: unknown[] = [];

beforeEach(() => {
  _grantTimerLeaseForTest();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-01T09:00:10"));
  invokeMock.mockReset();
  writeMock.mockReset();
  writeMock.mockResolvedValue(undefined);
  _clearScheduledAgentInputsForTest();
  _clearPtyActivityForTest();
  _clearPhoneHoldsForTest();
  schedules = [];
  invokeMock.mockImplementation((command) => Promise.resolve(
    command === "agent_schedules_list" ? schedules
    : command === "agent_schedule_claim" ? true
    : [],
  ));
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
  registerScheduledAgentInput("target-1", {
    ptyId: PTY,
    ready: () => true,
    started: () => true,
    bracketedPaste: () => false,
    recordAuthorizedInput: () => noteAgentTurn(PTY, "working"),
  });
});

afterEach(() => {
  _clearPhoneHoldsForTest();
  vi.useRealTimers();
});

describe("a prompt the phone sent mid-turn", () => {
  it("joins the CLI's queue at once, while the agent still works", async () => {
    noteAgentTurn(PTY, "working");
    schedules = [sendNow("held-1", "also fix the tests")];
    holdPhonePrompt("held-1");
    await act(async () => { render(<AgentScheduleHost />); });
    await advance(1_000);
    expect(delivered()).toContain("also fix the tests");
    expect(completions()).toEqual([expect.objectContaining({ scheduleId: "held-1", result: "delivered" })]);
  });

  it("goes in without waiting for the next sweep when it arrives mid-watch", async () => {
    noteAgentTurn(PTY, "working");
    await act(async () => { render(<AgentScheduleHost />); });
    await advance(1_000);
    schedules = [sendNow("held-1", "one more thing")];
    await act(async () => {
      await useAgentSchedulesStore.getState().load("p", "target-1");
    });
    holdPhonePrompt("held-1");
    await advance(1_000);
    expect(delivered()).toContain("one more thing");
  });

  it("goes in as edited once a question it waited behind is answered", async () => {
    noteAgentTurn(PTY, "working");
    noteAgentTurn(PTY, "decision");
    schedules = [sendNow("held-1", "first words")];
    holdPhonePrompt("held-1");
    await act(async () => { render(<AgentScheduleHost />); });
    await advance(1_000);
    expect(delivered()).toBe("");
    schedules = [sendNow("held-1", "second words")];
    useAgentSchedulesStore.setState({ byTarget: {} });
    holdPhonePrompt("held-1");
    noteAgentTurn(PTY, "working");
    await advance(1_000);
    expect(delivered()).toContain("second words");
    expect(delivered()).not.toContain("first words");
  });

  it("never answers a question the agent is asking", async () => {
    noteAgentTurn(PTY, "working");
    noteAgentTurn(PTY, "decision");
    schedules = [sendNow("held-1", "yes and more")];
    holdPhonePrompt("held-1");
    await act(async () => { render(<AgentScheduleHost />); });
    await advance(2 * 60_000);
    expect(delivered()).toBe("");
  });

  it("goes in behind a turn a scheduled delivery started", async () => {
    schedules = [sendNow("first", "first prompt")];
    await act(async () => { render(<AgentScheduleHost />); });
    await advance(2_000);
    expect(delivered()).toContain("first prompt");

    // That turn is still running when the phone's prompt arrives.
    writeMock.mockClear();
    schedules = [sendNow("held-1", "and the docs")];
    useAgentSchedulesStore.setState({ byTarget: {} });
    holdPhonePrompt("held-1");
    await advance(1_000);
    expect(delivered()).toContain("and the docs");
  });

  it("leaves a desktop send-now rule waiting for the idle point", async () => {
    noteAgentTurn(PTY, "working");
    schedules = [sendNow("desk-1", "desktop prompt")];
    await act(async () => { render(<AgentScheduleHost />); });
    await advance(3 * 60_000);
    expect(delivered()).toBe("");
  });
});
