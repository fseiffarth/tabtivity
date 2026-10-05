/**
 * A one-time schedule that has run is a receipt, not a plan. The scheduler
 * writes it onto the project's Sent prompts — with the prompt, the tab, the
 * agent, the session id, the occurrence it was due at and the moment it went —
 * and only then deletes the rule, so the tab's schedule menu is left holding
 * what still has a future. The record is written FIRST: a rule dropped after a
 * failed write would take the only account of the delivery with it.
 */
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));

import { AgentScheduleHost } from "../../components/layout/AgentScheduleHost";
import { useAgentPromptsStore } from "../../stores/agents/agentPrompts";
import { useAgentSchedulesStore } from "../../stores/agents/agentSchedules";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { _grantTimerLeaseForTest } from "../../stores/timerLease";

const invokeMock = vi.mocked(invoke);

const agent: TabEntry = {
  key: "agent-1",
  label: "Claude",
  cmd: "claude",
  cwd: "/project",
  kind: "agent",
  sessionId: "session-1",
  scheduleTargetId: "target-1",
};

const delivered = {
  id: "prompt-1",
  enabled: true,
  message: "Run the tests",
  preface: ["/clear"],
  rule: { type: "once", at: "2026-09-01T09:00" },
  last: { occurrence: "2026-09-01T09:00", result: "delivered", at: "2026-09-01T09:00:12Z" },
};
const daily = {
  id: "rule-1",
  enabled: true,
  message: "Every morning",
  rule: { type: "daily", time: "09:00" },
  last: { occurrence: "2026-09-01T09:00", result: "delivered", at: "2026-09-01T09:00:12Z" },
};

function call(command: string) {
  return invokeMock.mock.calls.find(([name]) => name === command);
}

beforeEach(() => {
  _grantTimerLeaseForTest();
  invokeMock.mockReset();
  useAgentSchedulesStore.setState({ byTarget: {}, loading: {} });
  useAgentPromptsStore.setState({ byProject: {}, historyByProject: {}, loading: {} });
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

describe("retiring a finished schedule to the sent prompts", () => {
  it("records the delivery with its session, agent and occurrence, then drops the rule", async () => {
    invokeMock.mockImplementation((command) =>
      Promise.resolve(command === "agent_schedules_list" ? [delivered] : []),
    );

    await act(async () => {
      render(<AgentScheduleHost />);
    });

    const record = call("agent_prompt_record");
    expect(record).toBeTruthy();
    const payload = record![1] as {
      projectId: string;
      entry: {
        id: string;
        message: string;
        sent: {
          tab_label: string;
          session_id: string | null;
          agent: string | null;
          result: string | null;
          scheduled_for: string | null;
          preface: string[];
        };
      };
    };
    expect(payload.projectId).toBe("p");
    // A one-time rule is the prompt: the record lands on the row the send-now
    // prompt already wrote, rather than listing the same text twice.
    expect(payload.entry.id).toBe("prompt-1");
    expect(payload.entry.message).toBe("Run the tests");
    expect(payload.entry.sent).toMatchObject({
      tab_label: "Claude",
      session_id: "session-1",
      agent: "claude",
      result: "delivered",
      scheduled_for: "2026-09-01T09:00",
      preface: ["/clear"],
    });

    const dropped = call("agent_schedule_delete");
    expect(dropped![1]).toMatchObject({
      projectId: "p",
      scheduleTargetId: "target-1",
      scheduleId: "prompt-1",
    });
  });

  it("retires the rule's own prompt and leaves a second prompt with the same words collected", async () => {
    invokeMock.mockImplementation((command) => {
      if (command === "agent_schedules_list") return Promise.resolve([delivered]);
      if (command === "agent_prompts_list") return Promise.resolve([
        { id: "prompt-1", message: "Run the tests", created_at: "x", updated_at: "x" },
        { id: "prompt-2", message: "Run the tests", created_at: "y", updated_at: "y" },
      ]);
      return Promise.resolve([]);
    });

    await act(async () => {
      render(<AgentScheduleHost />);
    });

    const removed = invokeMock.mock.calls.filter(([name]) => name === "agent_prompt_delete").map(([, args]) => (args as { promptId: string }).promptId);
    expect(removed).toEqual(["prompt-1"]);
  });

  it("keeps a recurring rule, which still has a next run", async () => {
    invokeMock.mockImplementation((command) =>
      Promise.resolve(command === "agent_schedules_list" ? [daily] : []),
    );

    await act(async () => {
      render(<AgentScheduleHost />);
    });

    expect(call("agent_schedule_delete")).toBeUndefined();
  });

  it("leaves the rule in place when the record cannot be written", async () => {
    invokeMock.mockImplementation((command) => {
      if (command === "agent_schedules_list") return Promise.resolve([delivered]);
      if (command === "agent_prompt_record") return Promise.reject(new Error("disk full"));
      return Promise.resolve([]);
    });

    await act(async () => {
      render(<AgentScheduleHost />);
    });

    expect(call("agent_prompt_record")).toBeTruthy();
    expect(call("agent_schedule_delete")).toBeUndefined();
  });

  it("does not advance a recovered receipt without evidence its turn completed", async () => {
    invokeMock.mockImplementation((command) => {
      if (command === "agent_schedules_list") return Promise.resolve([delivered]);
      if (command === "agent_prompts_list") return Promise.resolve([
        { id: "prompt-1", message: "Run the tests", created_at: "x", updated_at: "x" },
        { id: "review", message: "Review the result", created_at: "x", updated_at: "x" },
      ]);
      if (command === "agent_prompt_links_list") return Promise.resolve([
        { id: "link", from: "prompt-1", to: "review", kind: "after", target: "target-1" },
      ]);
      return Promise.resolve([]);
    });

    await act(async () => { render(<AgentScheduleHost />); });

    const queued = invokeMock.mock.calls.find(([name, args]) =>
      name === "agent_schedule_upsert" && (args as { schedule?: { id?: string } })?.schedule?.id === "review");
    expect(queued).toBeUndefined();
    expect(call("agent_prompt_record")).toBeTruthy();
  });

  it("does not type edge commands merely because the source was submitted", async () => {
    invokeMock.mockImplementation((command) => {
      if (command === "agent_schedules_list") return Promise.resolve([delivered]);
      if (command === "agent_prompts_list") return Promise.resolve([
        { id: "prompt-1", message: "Run the tests", created_at: "x", updated_at: "x" },
        { id: "review", message: "Review the result", created_at: "x", updated_at: "x" },
      ]);
      if (command === "agent_prompt_links_list") return Promise.resolve([
        { id: "link", from: "prompt-1", to: "review", kind: "after", target: "target-1", preface: ["/clear"] },
      ]);
      return Promise.resolve([]);
    });

    await act(async () => { render(<AgentScheduleHost />); });

    const queued = invokeMock.mock.calls.find(([name, args]) =>
      name === "agent_schedule_upsert" && (args as { schedule?: { id?: string } })?.schedule?.id === "review");
    expect(queued).toBeUndefined();
  });

  it("does not fire an after chain for a missed source", async () => {
    invokeMock.mockImplementation((command) => Promise.resolve(command === "agent_schedules_list"
      ? [{ ...delivered, last: { ...delivered.last, result: "missed" } }]
      : []));
    await act(async () => { render(<AgentScheduleHost />); });
    expect(call("agent_prompt_links_list")).toBeUndefined();
  });
});
