/**
 * Auto-continue: the loop that keeps an agent tab going across its own CLI's
 * rate-limit windows. It reads the usage panel, places the soonest rollover in
 * time, waits out the settling minute, submits one `continue` at a safe idle
 * point, and then reads the panel again for the next window.
 *
 * The cases worth pinning are the ones that fire (or refuse to) unattended: a
 * switch that is off must read nothing at all, an agent with no usage panel
 * must say so rather than sit silent, a due continue must respect the same
 * idle/decision gate a scheduled prompt does, and the send must leave a record.
 */
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));

import { AgentContinueHost } from "../../components/layout/AgentContinueHost";
import {
  _clearScheduledAgentInputsForTest,
  registerScheduledAgentInput,
} from "../../lib/agents/scheduledAgentInput";
import { useActivityStore } from "../../stores/activity";
import { _resetAgentContinueForTest, continueKey, useAgentContinueStore } from "../../stores/agents/agentContinue";
import { useAgentPromptsStore } from "../../stores/agents/agentPrompts";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { _grantTimerLeaseForTest } from "../../stores/timerLease";

const invokeMock = vi.mocked(invoke);

/** A Tuesday at 14:00 local, matching the reset-parser fixtures. */
const NOW = new Date(2026, 8, 1, 14, 0, 0, 0);
const KEY = continueKey("p", "target-1");

const PANEL = [
  "Current session: 100% used · resets 6:20pm",
  "Current week (all models): 38% used · resets Mon 9am",
].join("\n");

function tab(overrides: Partial<TabEntry> = {}): TabEntry {
  return {
    key: "agent-1",
    label: "Claude",
    cmd: "claude",
    cwd: "/project",
    kind: "agent",
    sessionId: "session-1",
    scheduleTargetId: "target-1",
    autoContinue: true,
    ...overrides,
  };
}

function seedTabs(entry: TabEntry): void {
  useTabsStore.setState({
    scope: "p",
    tabsByScope: { p: [entry] },
    layoutByScope: { p: null },
    focusedGroupByScope: { p: null },
    detachedGroupsByScope: {},
    hiddenGroupsByScope: {},
    pendingRespawnByScope: {},
  });
}

/** A terminal that is mounted, quiet and taking input. */
function seedReadyTerminal(): { writes: string[] } {
  const writes: string[] = [];
  registerScheduledAgentInput("target-1", {
    ptyId: "p:agent-1",
    ready: () => true,
    bracketedPaste: () => false,
    recordAuthorizedInput: () => {},
  });
  invokeMock.mockImplementation((command, args) => {
    if (command === "agent_usage") return Promise.resolve(usageAnswer);
    if (command === "pty_write") {
      writes.push(new TextDecoder().decode(Uint8Array.from((args as { data: number[] }).data)));
      return Promise.resolve(null);
    }
    return Promise.resolve(null);
  });
  return { writes };
}

let usageAnswer: unknown = { agent: "claude", label: "Claude Code", supported: true, raw: PANEL, cached: false };

beforeEach(() => {
  _grantTimerLeaseForTest();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve(null));
  usageAnswer = { agent: "claude", label: "Claude Code", supported: true, raw: PANEL, cached: false };
  _clearScheduledAgentInputsForTest();
  _resetAgentContinueForTest();
  useActivityStore.setState({ busyByTab: {}, attentionByTab: {} });
  useAgentPromptsStore.setState({ byProject: {}, historyByProject: {}, loading: {} });
  seedTabs(tab());
});

afterEach(() => {
  vi.useRealTimers();
});

describe("auto-continue", () => {
  it("reads nothing at all while the switch is off", async () => {
    seedTabs(tab({ autoContinue: undefined }));
    invokeMock.mockImplementation(() => Promise.resolve(usageAnswer));

    await act(async () => {
      render(<AgentContinueHost />);
    });

    expect(invokeMock.mock.calls.some(([name]) => name === "agent_usage")).toBe(false);
    expect(useAgentContinueStore.getState().byTarget[KEY]).toBeUndefined();
  });

  it("arms the soonest rollover, plus the settling minute", async () => {
    invokeMock.mockImplementation(() => Promise.resolve(usageAnswer));

    await act(async () => {
      render(<AgentContinueHost />);
    });

    const status = useAgentContinueStore.getState().byTarget[KEY];
    expect(status?.phase).toBe("armed");
    expect(status?.window).toBe("Current session");
    // 18:20 plus one minute.
    expect(status?.armedAt).toBe(new Date(2026, 8, 1, 18, 21).getTime());
  });

  it("says so when the agent's CLI publishes no usage panel", async () => {
    usageAnswer = {
      agent: "gemini",
      label: "Gemini",
      supported: false,
      error: "Gemini has no usage readout that can be read without a tab",
      cached: false,
    };
    invokeMock.mockImplementation(() => Promise.resolve(usageAnswer));

    await act(async () => {
      render(<AgentContinueHost />);
    });

    const status = useAgentContinueStore.getState().byTarget[KEY];
    expect(status?.phase).toBe("unsupported");
    expect(status?.armedAt).toBeUndefined();
  });

  it("reports a panel that named no time it could place", async () => {
    usageAnswer = { agent: "claude", label: "Claude Code", supported: true, raw: "Current session: 71% used", cached: false };
    invokeMock.mockImplementation(() => Promise.resolve(usageAnswer));

    await act(async () => {
      render(<AgentContinueHost />);
    });

    expect(useAgentContinueStore.getState().byTarget[KEY]?.phase).toBe("unreadable");
  });

  it("submits one continue once the rollover has passed, and records it", async () => {
    const { writes } = seedReadyTerminal();

    await act(async () => {
      render(<AgentContinueHost />);
    });
    expect(useAgentContinueStore.getState().byTarget[KEY]?.phase).toBe("armed");

    // Past the rollover and its settling minute, with the PTY long quiet.
    vi.setSystemTime(new Date(2026, 8, 1, 18, 22));
    await act(async () => {
      // The tick that fires the send, then the composer's own inter-write gaps
      // (`lib/agents/scheduledAgentInput`), which are scheduled during that tick.
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(writes.join("")).toContain("continue");
    const status = useAgentContinueStore.getState().byTarget[KEY];
    expect(status?.sent).toBe(1);
    expect(status?.armedAt).toBeUndefined();
    const record = invokeMock.mock.calls.find(([name]) => name === "agent_prompt_record");
    expect(record).toBeTruthy();
    expect((record![1] as { entry: { message: string } }).entry.message).toBe("continue");
  });

  it("waits rather than typing into a tab that is mid-turn", async () => {
    const { writes } = seedReadyTerminal();
    useActivityStore.setState({ busyByTab: { "p:agent-1": true }, attentionByTab: {} });

    await act(async () => {
      render(<AgentContinueHost />);
    });
    vi.setSystemTime(new Date(2026, 8, 1, 18, 22));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(writes.join("")).not.toContain("continue");
    // Still armed: the occurrence is kept for the next tick, not abandoned.
    expect(useAgentContinueStore.getState().byTarget[KEY]?.armedAt).toBeDefined();
  });

  it("waits rather than answering an approval prompt with a continue", async () => {
    const { writes } = seedReadyTerminal();
    useActivityStore.setState({ busyByTab: {}, attentionByTab: { "p:agent-1": "decision" } });

    await act(async () => {
      render(<AgentContinueHost />);
    });
    vi.setSystemTime(new Date(2026, 8, 1, 18, 22));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(writes.join("")).not.toContain("continue");
  });

  it("forgets a target whose switch went off", async () => {
    invokeMock.mockImplementation(() => Promise.resolve(usageAnswer));
    await act(async () => {
      render(<AgentContinueHost />);
    });
    expect(useAgentContinueStore.getState().byTarget[KEY]).toBeDefined();

    await act(async () => {
      useTabsStore.getState().setAutoContinueInScope("p", "agent-1", false);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(useAgentContinueStore.getState().byTarget[KEY]).toBeUndefined();
  });
});
