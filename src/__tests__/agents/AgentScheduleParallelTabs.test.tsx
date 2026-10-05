/**
 * Scheduled prompts queue PER TAB: a prompt due on one agent tab must not wait
 * for another tab's turn to finish.
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
import { _clearPtyActivityForTest, noteAgentTurn, notePtyOutput, noteUserInput, useActivityStore } from "../../stores/activity";
import { useAgentPromptsStore } from "../../stores/agents/agentPrompts";
import { useAgentSchedulesStore } from "../../stores/agents/agentSchedules";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { _grantTimerLeaseForTest } from "../../stores/timerLease";

const invokeMock = vi.mocked(invoke);
const writeMock = vi.mocked(writePtyInput);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);

const tabA: TabEntry = {
  key: "agent-1", label: "Claude A", cmd: "claude", cwd: "/project", kind: "agent",
  sessionId: "session-1", scheduleTargetId: "target-1",
};
const tabB: TabEntry = { ...tabA, key: "agent-2", label: "Claude B", sessionId: "session-2", scheduleTargetId: "target-2" };

function sendNow(id: string, message: string) {
  return { id, enabled: true, message, rule: { type: "once", at: "2026-09-01T08:59" } };
}
function delivered(): string[] {
  return writeMock.mock.calls.map(([, bytes]) => decode(bytes));
}
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
    tabsByScope: { p: [tabA, tabB] },
    layoutByScope: { p: null },
    focusedGroupByScope: { p: null },
    detachedGroupsByScope: {},
    hiddenGroupsByScope: {},
    pendingRespawnByScope: {},
  });
});
afterEach(() => { vi.useRealTimers(); });

describe("two agent tabs", () => {
  it("delivers to the second tab while the first is still working", async () => {
    let byTarget: Record<string, unknown[]> = { "target-1": [sendNow("prompt-1", "first prompt")], "target-2": [] };
    invokeMock.mockImplementation((command, args) => Promise.resolve(
      command === "agent_schedules_list" ? (byTarget[(args as { scheduleTargetId: string }).scheduleTargetId] ?? [])
      : command === "agent_schedule_claim" ? true
      : [],
    ));
    for (const [target, pty] of [["target-1", "p:agent-1"], ["target-2", "p:agent-2"]] as const) {
      registerScheduledAgentInput(target, {
        ptyId: pty, ready: () => true, bracketedPaste: () => false,
        recordAuthorizedInput: () => noteAgentTurn(pty, "working"),
      });
    }
    await act(async () => { render(<AgentScheduleHost />); });
    await act(async () => { await settle(); });
    expect(delivered().join("")).toContain("first prompt");

    // Tab A is mid-turn. A prompt aimed at tab B arrives.
    writeMock.mockClear();
    byTarget = { "target-1": [], "target-2": [sendNow("prompt-2", "second prompt")] };
    useAgentSchedulesStore.setState({ byTarget: {} });
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    await act(async () => { await settle(); });
    expect(delivered().join("")).toContain("second prompt");
  });

  it("delivers to a finished tab that was merely typed into, or clicked, since its Stop", async () => {
    // Tab B finished a turn a while ago. Then a keystroke landed that never
    // became a prompt — the case a focus report or a stray arrow key used to
    // produce — and tab A is mid-turn. B's prompt must not wait on either.
    invokeMock.mockImplementation((command, args) => Promise.resolve(
      command === "agent_schedules_list"
        ? ((args as { scheduleTargetId: string }).scheduleTargetId === "target-2" ? [sendNow("prompt-2", "second prompt")] : [])
      : command === "agent_schedule_claim" ? true
      : [],
    ));
    for (const [target, pty] of [["target-1", "p:agent-1"], ["target-2", "p:agent-2"]] as const) {
      registerScheduledAgentInput(target, {
        ptyId: pty, ready: () => true, bracketedPaste: () => false,
        recordAuthorizedInput: () => { noteUserInput(pty); noteAgentTurn(pty, "working"); },
      });
    }
    noteAgentTurn("p:agent-1", "working");
    noteAgentTurn("p:agent-2", "working");
    noteAgentTurn("p:agent-2", "done");
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    noteUserInput("p:agent-2");
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });

    await act(async () => { render(<AgentScheduleHost />); });
    await act(async () => { await settle(); });
    expect(delivered().join("")).toContain("second prompt");
  });

  it("delivers a second prompt to a hook-free tab once its output has gone quiet", async () => {
    // Gemini, Qwen, a custom command: no Stop will ever arrive, so the wait
    // after the first delivery reads the bytes instead of holding forever.
    let byTarget: Record<string, unknown[]> = { "target-1": [sendNow("prompt-1", "first prompt")], "target-2": [] };
    invokeMock.mockImplementation((command, args) => Promise.resolve(
      command === "agent_schedules_list" ? (byTarget[(args as { scheduleTargetId: string }).scheduleTargetId] ?? [])
      : command === "agent_schedule_claim" ? true
      : [],
    ));
    registerScheduledAgentInput("target-1", {
      ptyId: "p:agent-1", ready: () => true, bracketedPaste: () => false,
      recordAuthorizedInput: () => noteUserInput("p:agent-1"),
    });
    await act(async () => { render(<AgentScheduleHost />); });
    await act(async () => { await settle(); });
    expect(delivered().join("")).toContain("first prompt");

    writeMock.mockClear();
    byTarget = { "target-1": [sendNow("prompt-2", "second prompt")], "target-2": [] };
    useAgentSchedulesStore.setState({ byTarget: {} });
    // The agent answers, then falls silent — but not for long enough yet.
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    notePtyOutput("p:agent-1", "Here is the answer.\r\n");
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(delivered()).toEqual([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    await act(async () => { await settle(); });
    expect(delivered().join("")).toContain("second prompt");
  });
});
