import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn(() => Promise.resolve()) }));

import { alreadyRecorded, foldPrompt, promptsToAdopt } from "../../lib/agents/prompt/adopt";
import { isSessionCommand } from "../../lib/agents/prompt/chart";
import { useActivityStore } from "../../stores/activity";
import { useAgentModelsStore } from "../../stores/agents/agentModels";
import { useAgentPromptsStore, type SentAgentPrompt } from "../../stores/agents/agentPrompts";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { BRAND } from "../../lib/brand";

const tab: TabEntry = { key: "agent-1", label: "Claude", cmd: "claude", cwd: "/p", kind: "agent", sessionId: "session-abc", scheduleTargetId: "target-1" };
const row = (message: string, sent_at: string, extra: Partial<SentAgentPrompt> = {}): SentAgentPrompt =>
  ({ id: sent_at, message, created_at: sent_at, sent_at, tab_label: "Claude", session_id: "session-abc", ...extra });

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("adopting a prompt typed into the terminal", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.mocked(invoke).mockReset();
    useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [tab] } }));
    useActivityStore.setState({ busyByTab: {}, lastDoneByTab: {} });
    useAgentModelsStore.setState({ byTab: {}, promptByTab: {} });
    useAgentPromptsStore.setState({ byProject: {}, historyByProject: {}, linksByProject: {}, loading: {} });
  });

  it(`a prompt ${BRAND.display} sent is the tab's newest history row and is not recorded again`, () => {
    const history = [row("fix the tests", "2026-09-07T10:00:00Z"), row("write\n  docs", "2026-09-07T11:00:00Z")];
    expect(alreadyRecorded(history, "write docs", tab)).toBe(true);
    expect(alreadyRecorded(history, "fix the tests", tab)).toBe(false);
    // A long prompt reaches here cut, and still matches its own opening.
    expect(alreadyRecorded([row("a".repeat(400), "2026-09-07T12:00:00Z")], `${"a".repeat(300)}…`, tab)).toBe(true);
    // Another tab's rows say nothing about this one, and neither does a row
    // with no id at all: every "Claude" tab carries that label.
    expect(alreadyRecorded([row("write docs", "2026-09-07T13:00:00Z", { tab_label: "Codex", session_id: "other" })], "write docs", tab)).toBe(false);
    expect(alreadyRecorded([row("write docs", "2026-09-07T13:00:00Z", { session_id: undefined })], "write docs", tab)).toBe(false);
    // A row filed under the live session the tab rolled onto (`/clear`) is
    // still this tab's: its tab id is the launch id.
    expect(alreadyRecorded([row("write docs", "2026-09-07T13:00:00Z", { tab_label: "Renamed", session_id: "cleared", tab_id: "session-abc" })], "write docs", tab)).toBe(true);
    expect(foldPrompt("  a \n\n b\tc ")).toBe("a b c");
  });

  it(`records a prompt that changed at a turn's start, and neither the first read nor one ${BRAND.display} sent`, async () => {
    let lastPrompt = "fix the tests";
    const recorded: unknown[] = [];
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "agent_tab_model") return "claude-opus-4-1";
      // A backend predating the timed read: the last prompt is adopted as before.
      if (command === "agent_tab_recent_prompts") throw new Error("command agent_tab_recent_prompts not found");
      if (command === "agent_tab_last_prompt") return lastPrompt;
      if (command === "agent_prompt_history_list") return [row("fix the tests", "2026-09-07T10:00:00Z")];
      if (command === "agent_prompt_record") { recorded.push(args); return []; }
      return [];
    });
    // First read: a baseline for a tab this store had never seen.
    useActivityStore.setState({ busyByTab: { "p:agent-1": true } });
    await flush(); await flush();
    expect(useAgentModelsStore.getState().promptByTab["p:agent-1"]).toBe("fix the tests");
    expect(recorded).toHaveLength(0);
    // The user types a new prompt into the terminal: the transcript changes
    // and the tab turns busy again.
    lastPrompt = "now the\n  docs";
    useActivityStore.setState({ busyByTab: {} });
    useActivityStore.setState({ busyByTab: { "p:agent-1": true } });
    await flush(); await flush(); await flush();
    expect(useAgentModelsStore.getState().promptByTab["p:agent-1"]).toBe("now the\n  docs");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ projectId: "p", entry: { message: "now the\n  docs", sent: { tab_label: "Claude", session_id: "session-abc", agent: "claude", result: "delivered" } } });
    // A prompt the composer sent is on the history before the turn starts.
    useAgentPromptsStore.setState({ historyByProject: { p: [row("now the docs", "2026-09-07T11:00:00Z"), row("from the composer", "2026-09-07T12:00:00Z")] } });
    lastPrompt = "from the composer";
    useActivityStore.setState({ busyByTab: {} });
    useActivityStore.setState({ busyByTab: { "p:agent-1": true } });
    await flush(); await flush(); await flush();
    expect(recorded).toHaveLength(1);
    // The auto-`/rename`, a model switch, a clear and a login steer the session; none is stored.
    for (const command of ["/rename p1 (feature)", "/model opus", "/clear", "/login"]) {
      lastPrompt = command;
      useActivityStore.setState({ busyByTab: {} });
      useActivityStore.setState({ busyByTab: { "p:agent-1": true } });
      await flush(); await flush(); await flush();
    }
    expect(recorded).toHaveLength(1);
  });

  it("tells a session command from a prompt that mentions one", () => {
    expect(isSessionCommand(`/rename ${BRAND.slug}`)).toBe(true);
    expect(isSessionCommand("  /MODEL sonnet")).toBe(true);
    expect(isSessionCommand("/clear")).toBe(true);
    expect(isSessionCommand("/login")).toBe(true);
    expect(isSessionCommand("/compact")).toBe(true);
    expect(isSessionCommand("/goal ship the release")).toBe(false);
    expect(isSessionCommand("/renamed-thing is broken")).toBe(false);
    expect(isSessionCommand("run /clear before the tests")).toBe(false);
    expect(isSessionCommand("/")).toBe(false);
    expect(isSessionCommand("! git status")).toBe(false);
  });
});

describe("adopting the transcript's timed prompts", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.mocked(invoke).mockReset();
    useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [tab] } }));
    useActivityStore.setState({ busyByTab: {}, lastDoneByTab: {} });
    useAgentModelsStore.setState({ byTab: {}, promptByTab: {} });
    useAgentPromptsStore.setState({ byProject: {}, historyByProject: {}, linksByProject: {}, loading: {} });
  });

  it("picks every prompt the history is missing, and nothing it already has", () => {
    const now = Date.parse("2026-09-15T09:00:00Z");
    const history = [row("sent by the scheduler", "2026-09-15T08:10:00Z")];
    const prompts = [
      { text: "from two days ago", at: "2026-09-13T08:00:00Z" },
      { text: "sent by the scheduler", at: "2026-09-15T08:10:03Z" },
      { text: "/clear", at: "2026-09-15T08:11:00Z" },
      { text: "typed", at: "2026-09-15T08:20:44Z" },
      { text: "sent while it worked", at: "2026-09-15T08:21:48Z" },
      { text: "typed", at: "2026-09-15T08:20:44Z" },
    ];
    expect(promptsToAdopt(history, prompts, tab, now).map((prompt) => prompt.text)).toEqual(["typed", "sent while it worked"]);
    const adopted = [...history, row("typed", "2026-09-15T08:20:44Z"), row("sent while it worked", "2026-09-15T08:21:48Z")];
    expect(promptsToAdopt(adopted, prompts, tab, now)).toEqual([]);
  });

  it("records them at the transcript's time, the first read of a tab included", async () => {
    const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    const prompts = [{ text: "first prompt", at: at(10) }, { text: "sent while it worked", at: at(5) }];
    const recorded: { entry: { message: string; sent: { sent_at?: string } } }[] = [];
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "agent_tab_model") return "claude-opus-5";
      if (command === "agent_tab_recent_prompts") return prompts;
      if (command === "agent_prompt_record") { recorded.push(args as (typeof recorded)[number]); return []; }
      return [];
    });
    useActivityStore.setState({ busyByTab: { "p:agent-1": true } });
    await flush(); await flush(); await flush(); await flush();
    expect(recorded.map((call) => call.entry.message)).toEqual(["first prompt", "sent while it worked"]);
    expect(recorded[1].entry.sent.sent_at).toBe(prompts[1].at);
    expect(useAgentModelsStore.getState().promptByTab["p:agent-1"]).toBe("sent while it worked");
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "agent_tab_last_prompt")).toBe(false);
  });
});
