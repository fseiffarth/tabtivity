/**
 * How long an agent tab has been at work on its turn, or was on its last one:
 * the desktop stamps when a turn begins (`agentTurnStartedAt`) and the phone's
 * tab card measures it against the desktop's own working / done readings.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _clearPtyActivityForTest,
  agentTurnStartedAt,
  noteAgentTurn,
  noteBackgroundWork,
  noteUserInput,
  useActivityStore,
} from "../../stores/activity";
import { useTabsStore } from "../../stores/tabs";
import { formatTurnDuration, turnDuration } from "../../../mobile-web/src/components/AgentModeMarks";
import { translate } from "../../lib/i18n";

const PTY = "proj-a:agent-1";

describe("agentTurnStartedAt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _clearPtyActivityForTest();
    useTabsStore.setState({
      tabsByScope: { "proj-a": [{ key: "agent-1", label: "Claude", cmd: "claude", cwd: "/proj", kind: "agent" }] },
      scope: "proj-a",
      layoutByScope: {},
      detachedGroupsByScope: {},
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("dates a turn from its prompt, not from the tool calls inside it", () => {
    expect(agentTurnStartedAt(PTY)).toBeUndefined();
    noteAgentTurn(PTY, "working");
    const start = Date.now();
    vi.advanceTimersByTime(30_000);
    noteAgentTurn(PTY, "working"); // PostToolUse
    expect(agentTurnStartedAt(PTY)).toBe(start);
    noteAgentTurn(PTY, "done");
    expect(agentTurnStartedAt(PTY)).toBe(start);
    expect(useActivityStore.getState().lastDoneByTab[PTY]).toBe(start + 30_000);

    vi.advanceTimersByTime(60_000);
    noteAgentTurn(PTY, "working"); // the next prompt
    expect(agentTurnStartedAt(PTY)).toBe(start + 90_000);
  });

  it("keeps the start across an approval, and restarts after an interrupt", () => {
    noteAgentTurn(PTY, "working");
    const start = Date.now();
    vi.advanceTimersByTime(5_000);
    noteAgentTurn(PTY, "decision");
    vi.advanceTimersByTime(5_000);
    noteUserInput(PTY); // answering the prompt retires the verdict…
    noteAgentTurn(PTY, "working"); // …and the turn carries on
    expect(agentTurnStartedAt(PTY)).toBe(start);

    vi.advanceTimersByTime(5_000);
    noteUserInput(PTY, true); // Escape mid-turn
    vi.advanceTimersByTime(5_000);
    noteAgentTurn(PTY, "working");
    expect(agentTurnStartedAt(PTY)).toBe(start + 20_000);
  });

  it("carries the turn on when the agent wakes on a background shell it left running", () => {
    noteAgentTurn(PTY, "working");
    const start = Date.now();
    vi.advanceTimersByTime(10_000);
    noteAgentTurn(PTY, "done", true); // Stop with a shell still running
    vi.advanceTimersByTime(60_000);
    noteAgentTurn(PTY, "done", false); // the shell exits
    vi.advanceTimersByTime(1_000);
    noteAgentTurn(PTY, "working"); // Claude wakes on its result
    expect(agentTurnStartedAt(PTY)).toBe(start);
  });

  it("carries the turn on when a subagent seen after the Stop wakes the agent", () => {
    noteAgentTurn(PTY, "working");
    const start = Date.now();
    vi.advanceTimersByTime(10_000);
    noteAgentTurn(PTY, "done");
    vi.advanceTimersByTime(5_000);
    noteBackgroundWork(PTY); // the phone bridge counted a subagent at work
    vi.advanceTimersByTime(60_000);
    noteAgentTurn(PTY, "working");
    expect(agentTurnStartedAt(PTY)).toBe(start);
  });

  it("starts a new turn for a prompt typed after the Stop, background work or not", () => {
    noteAgentTurn(PTY, "working");
    vi.advanceTimersByTime(10_000);
    noteAgentTurn(PTY, "done", true);
    vi.advanceTimersByTime(5_000);
    noteUserInput(PTY);
    noteAgentTurn(PTY, "working");
    expect(agentTurnStartedAt(PTY)).toBe(Date.now());
  });

  it("starts a new turn when nothing was left running at the Stop", () => {
    noteAgentTurn(PTY, "working");
    const start = Date.now();
    noteBackgroundWork(PTY); // a subagent inside the turn, done before the Stop
    vi.advanceTimersByTime(10_000);
    noteAgentTurn(PTY, "done");
    vi.advanceTimersByTime(600_000);
    noteAgentTurn(PTY, "working"); // a scheduled wakeup
    expect(agentTurnStartedAt(PTY)).toBe(start + 610_000);
  });
});

describe("turnDuration", () => {
  it("measures a running turn up to the desktop's now", () => {
    expect(turnDuration({ agent_status: "working", turn_started_at: 1_000, working_at: 241_000 })).toEqual({ ms: 240_000, running: true, end: 241_000 });
  });

  it("measures a finished turn up to its finish", () => {
    expect(turnDuration({ agent_status: "done", turn_started_at: 1_000, working_at: 60_000, done_at: 61_000 })).toEqual({ ms: 60_000, running: false, end: 61_000 });
    // Stopped with subagents still at work: the turn runs on to the desktop's now.
    expect(turnDuration({ agent_status: "done", agent_subagents: 2, turn_started_at: 1_000, working_at: 300_000, done_at: 61_000 })).toEqual({ ms: 299_000, running: true, end: 300_000 });
    expect(turnDuration({ turn_started_at: 1_000, done_at: 721_000 })).toEqual({ ms: 720_000, running: false, end: 721_000 });
  });

  it("says nothing when the turn's end is unknown", () => {
    // Interrupted after an earlier turn finished: the finish predates the start.
    expect(turnDuration({ agent_status: "interrupted", turn_started_at: 100_000, done_at: 50_000 })).toBeUndefined();
    expect(turnDuration({ agent_status: "done", done_at: 50_000 })).toBeUndefined();
  });

  it("formats seconds, minutes and hours", () => {
    const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate("en", key, params);
    expect(formatTurnDuration(42_000, t)).toBe("42s");
    expect(formatTurnDuration(4 * 60_000 + 59_000, t)).toBe("4m");
    expect(formatTurnDuration(72 * 60_000, t)).toBe("1h 12m");
  });
});
