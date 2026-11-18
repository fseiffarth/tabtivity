/**
 * The shared roster reading (`lib/agents/agentRoster`): what one agent tab is
 * doing and the facts a cross-project list shows for it — the phone's bridge
 * and the desktop cockpit both read it, so one tab never gets two answers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn() }));
vi.mock("../../lib/mobileSubagents", () => ({ mobileSubagentCount: vi.fn(() => 0) }));

import { agentRosterFacts, agentRosterState, deriveAgentRosterState, isRosterAgentKind } from "../../lib/agents/agentRoster";
import { mobileSubagentCount } from "../../lib/mobileSubagents";
import { useActivityStore } from "../../stores/activity";
import { useAgentModelsStore } from "../../stores/agents/agentModels";
import type { TabEntry } from "../../stores/tabs";
import { envName } from "../../lib/brand";

const SCOPE = "p-roster";
const tab: TabEntry = { key: "agent-1", label: "Claude", cmd: "claude", cwd: "/p", kind: "agent", sessionId: "s-1" };
const PTY = `${SCOPE}:${tab.key}`;

function idleFacts() {
  return { busy: false, attention: undefined, lastDoneAt: undefined, lastReadAt: undefined };
}

describe("deriveAgentRosterState", () => {
  it("weighs working over a decision over an interruption over unread output", () => {
    expect(deriveAgentRosterState({ ...idleFacts(), busy: true, attention: "decision" })).toBe("working");
    expect(deriveAgentRosterState({ ...idleFacts(), attention: "decision" })).toBe("question");
    expect(deriveAgentRosterState({ ...idleFacts(), attention: "interrupted", lastDoneAt: 5 })).toBe("interrupted");
    expect(deriveAgentRosterState({ ...idleFacts(), attention: "done" })).toBe("done");
    expect(deriveAgentRosterState(idleFacts())).toBe("idle");
  });

  it("calls a finished turn nobody arrived at since done, and a read one idle", () => {
    expect(deriveAgentRosterState({ ...idleFacts(), lastDoneAt: 2_000 })).toBe("done");
    expect(deriveAgentRosterState({ ...idleFacts(), lastDoneAt: 2_000, lastReadAt: 1_000 })).toBe("done");
    expect(deriveAgentRosterState({ ...idleFacts(), lastDoneAt: 2_000, lastReadAt: 3_000 })).toBe("idle");
  });
});

describe("isRosterAgentKind", () => {
  it("counts agent and local-model tabs, nothing else", () => {
    expect(isRosterAgentKind("agent")).toBe(true);
    expect(isRosterAgentKind("local_agent")).toBe(true);
    expect(isRosterAgentKind("shell")).toBe(false);
  });
});

describe("agentRosterFacts", () => {
  beforeEach(() => {
    useActivityStore.setState({ busyByTab: {}, attentionByTab: {}, lastWorkingByTab: {}, lastDoneByTab: {} });
    useAgentModelsStore.setState({
      byTab: {},
      screenByTab: {},
      modeByTab: {},
      goalByTab: {},
      refresh: vi.fn(() => Promise.resolve()),
      refreshScreen: vi.fn(() => Promise.resolve()),
    });
    vi.mocked(mobileSubagentCount).mockReturnValue(0);
  });
  afterEach(() => vi.clearAllMocks());

  it("reads the store's state the way deriveAgentRosterState weighs it", () => {
    useActivityStore.setState({ attentionByTab: { [PTY]: "decision" } });
    expect(agentRosterState(PTY)).toBe("question");
  });

  it("stamps a working tab's last-working time with now", () => {
    useActivityStore.setState({ busyByTab: { [PTY]: true }, lastWorkingByTab: { [PTY]: 10 } });
    const facts = agentRosterFacts(SCOPE, tab, 50_000);
    expect(facts.state).toBe("working");
    expect(facts.workingAt).toBe(50_000);
  });

  it("keeps a finished turn working while its subagents are at work", () => {
    useActivityStore.setState({ lastWorkingByTab: { [PTY]: 10 }, lastDoneByTab: { [PTY]: 20 } });
    vi.mocked(mobileSubagentCount).mockReturnValue(2);
    const facts = agentRosterFacts(SCOPE, tab, 90_000);
    expect(facts.subagents).toBe(2);
    expect(facts.workingAt).toBe(90_000);
    expect(facts.doneAt).toBe(20);
  });

  it("leaves a reading not taken absent rather than zero", () => {
    const facts = agentRosterFacts(SCOPE, tab, 1);
    expect(facts).toEqual({ ptyId: PTY, state: "idle" });
  });

  it("tags the model from the live pane first, then the transcript, then a local tab's own model", () => {
    useAgentModelsStore.setState({ screenByTab: { [PTY]: "Opus 4.7" }, byTab: { [PTY]: "claude-sonnet-4-5" } });
    expect(agentRosterFacts(SCOPE, tab, 1).model).toBe("Opus 4.7");
    useAgentModelsStore.setState({ screenByTab: {} });
    expect(agentRosterFacts(SCOPE, tab, 1).model).toBeTruthy();
    const local: TabEntry = { key: "local-1", label: "Local", cmd: "opencode", cwd: "/p", kind: "local_agent", env: { [envName("LOCAL_MODEL")]: "qwen3:8b" } };
    expect(agentRosterFacts(SCOPE, local, 1).model).toBe("qwen3:8b");
  });

  it("carries only the PLAN / GOAL marks that are on, and asks both model sources to re-read", () => {
    useAgentModelsStore.setState({ modeByTab: { [PTY]: { plan: true, goal: false } } });
    const facts = agentRosterFacts(SCOPE, tab, 1);
    expect(facts.plan).toBe(true);
    expect(facts.goal).toBeUndefined();
    expect(useAgentModelsStore.getState().refresh).toHaveBeenCalledWith(SCOPE, tab);
    expect(useAgentModelsStore.getState().refreshScreen).toHaveBeenCalledWith(SCOPE, tab);
  });
});
