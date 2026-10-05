import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn(() => Promise.resolve()) }));

import { AgentSchedulesView } from "../../components/agents/AgentSchedulesView";
import { PromptChartTab } from "../../components/agents/PromptChartTab";
import { localOccurrenceKey } from "../../lib/agents/agentSchedule";
import { useActivityStore } from "../../stores/activity";
import { useAgentPromptsStore } from "../../stores/agents/agentPrompts";
import { useAgentSchedulesStore } from "../../stores/agents/agentSchedules";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { registerTerminal, unregisterTerminal } from "../../lib/terminal/terminalRegistry";
import type { ReadableBufferLike } from "../../../mobile-web/src/terminal/readableScreen";
import type { Terminal } from "@xterm/xterm";
import { storageKey } from "../../lib/brand";

const agent: TabEntry = { key: "agent-1", label: "Claude", cmd: "claude", cwd: "/project", kind: "agent", sessionId: "session-abc", scheduleTargetId: "target-1" };
const shell: TabEntry = { key: "shell", label: "Shell", cmd: "bash", cwd: "/project", kind: "shell" };

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "agent_prompts_list") return [{ id: "draft", message: "Run the tests", tags: ["tests"], created_at: "x", updated_at: "x" }];
    if (command === "agent_prompt_history_list" || command === "agent_prompt_links_list" || command === "agent_schedules_list") return [];
    return [];
  });
  useActivityStore.setState({ busyByTab: {}, attentionByTab: {} });
  useAgentSchedulesStore.setState({ byTarget: {}, loading: {} });
  useAgentPromptsStore.setState({ byProject: {}, historyByProject: {}, linksByProject: {}, loading: {} });
  useTabsStore.setState((state) => ({ ...state, scope: "p", tabsByScope: { p: [agent, shell] } }));
});

describe("AgentSchedulesView order and model tag", () => {
  const second: TabEntry = { key: "agent-2", label: "Codex", cmd: "codex", cwd: "/project", kind: "agent", sessionId: "session-def", scheduleTargetId: "target-2" };
  const names = () => screen.getAllByTestId("agent-prompts-tab").map((row) => row.querySelector(".agent-prompts-tab-name")?.textContent);

  beforeEach(() => {
    localStorage.removeItem(storageKey("agentsSort"));
    useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [agent, second, shell] } }));
  });

  it("lists the most recently finished tab first by default, and tags each with the model it last answered with and the last prompt it was given", async () => {
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "agent_tab_model") return (args as { agent: string }).agent === "claude" ? "claude-opus-4-1-20250805" : null;
      // The prompt comes from the transcript, so one typed straight into the
      // terminal — never through Tabtivity's composer — is shown all the same.
      if (command === "agent_tab_last_prompt") return (args as { agent: string }).agent === "claude" ? "fix the failing tests" : null;
      return [];
    });
    // Neither is asking or working, so the bottom tier decides: the newest
    // finished turn is the one to read, whatever worked most recently.
    useActivityStore.setState({ lastWorkingByTab: { "p:agent-1": 1_000, "p:agent-2": 2_000 }, lastDoneByTab: { "p:agent-1": 3_000, "p:agent-2": 500 } });
    await act(async () => { render(<AgentSchedulesView scope="p" active />); });
    expect(names()).toEqual(["Claude", "Codex"]);
    expect((await screen.findByTestId("agent-model")).textContent).toBe("Opus 4.1");
    expect(screen.getAllByTestId("agent-model")).toHaveLength(1);
    expect((await screen.findByTestId("agent-last-prompt")).textContent).toBe("last prompt: fix the failing tests");
    expect(screen.getAllByTestId("agent-last-prompt")).toHaveLength(1);
    const promptCall = vi.mocked(invoke).mock.calls.find(([name]) => name === "agent_tab_last_prompt");
    expect(promptCall?.[1]).toMatchObject({ agent: "claude", projectId: "p", sessionId: "session-abc" });
    const modelCall = vi.mocked(invoke).mock.calls.find(([name, args]) => name === "agent_tab_model" && (args as { agent: string }).agent === "claude");
    expect(modelCall?.[1]).toMatchObject({ agent: "claude", projectId: "p", sessionId: "session-abc" });
  });

  it("a working tab outranks every timestamp, and the choice of order is remembered", async () => {
    useActivityStore.setState({ busyByTab: { "p:agent-1": true }, lastWorkingByTab: { "p:agent-2": 2_000 }, lastDoneByTab: { "p:agent-1": 100, "p:agent-2": 900 } });
    await act(async () => { render(<AgentSchedulesView scope="p" active />); });
    expect(names()).toEqual(["Claude", "Codex"]);
    fireEvent.click(screen.getByRole("button", { name: /Last working/ }));
    fireEvent.click(screen.getByRole("option", { name: "Last done" }));
    expect(names()).toEqual(["Codex", "Claude"]);
    expect(localStorage.getItem(storageKey("agentsSort"))).toBe("lastDone");
    fireEvent.click(screen.getByRole("button", { name: /Last done/ }));
    fireEvent.click(screen.getByRole("option", { name: "Tab order" }));
    expect(names()).toEqual(["Claude", "Codex"]);
    const [claudeTimes, codexTimes] = screen.getAllByTestId("agent-tab-times").map((node) => node.textContent ?? "");
    expect(claudeTimes.startsWith("working now · finished ")).toBe(true);
    expect(codexTimes.startsWith("worked ")).toBe(true);
    expect(codexTimes).toContain(" · finished ");
  });

  it("prefers the model the session is showing to the one its transcript names", async () => {
    // The tab has been switched to Sonnet since its last answer: the status
    // line under its input box says so, the transcript still names the model
    // that answered. The tag is what the session shows — the same words, off
    // the same screen, as the phone's Focus chip.
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "agent_tab_model") return (args as { agent: string }).agent === "claude" ? "claude-opus-4-1-20250805" : null;
      return [];
    });
    const rows = ["● Done.", "", ">", "~/project (develop) · Sonnet 4.5 · 85% context left"];
    const buffer: ReadableBufferLike = {
      length: rows.length,
      getLine: (row) => (rows[row] === undefined ? undefined : { translateToString: () => rows[row] }),
    };
    const term = { buffer: { active: buffer } } as unknown as Terminal;
    registerTerminal("p:agent-1", term);
    try {
      await act(async () => { render(<AgentSchedulesView scope="p" active />); });
      expect((await screen.findByTestId("agent-model")).textContent).toBe("Sonnet 4.5");
    } finally {
      unregisterTerminal("p:agent-1", term);
    }
  });

  it("puts a tab that stopped to ask above one that is merely working", async () => {
    useActivityStore.setState({
      busyByTab: { "p:agent-1": true, "p:agent-2": true },
      attentionByTab: { "p:agent-2": "decision" },
      lastWorkingByTab: { "p:agent-1": 5_000 },
      lastDoneByTab: { "p:agent-1": 9_000, "p:agent-2": 10 },
    });
    await act(async () => { render(<AgentSchedulesView scope="p" active />); });
    expect(names()).toEqual(["Codex", "Claude"]);
  });
});

describe("AgentSchedulesView prompt chart", () => {
  it("keeps only the scope's agent tabs and no prompt list of its own", async () => {
    await act(async () => { render(<AgentSchedulesView scope="p" active />); });
    expect(screen.getAllByTestId("agent-prompts-tab")).toHaveLength(1);
    expect(screen.queryByText("Prompt chart")).toBeNull();
    expect(screen.queryByText("Collected prompts")).toBeNull();
    expect(screen.queryByText("Scheduled prompts")).toBeNull();
    expect(screen.queryByText("Sent prompts")).toBeNull();
    expect(screen.queryByTestId("prompt-chart-card-draft")).toBeNull();
  });

  it("opens the chart as one tab of the scope and focuses it the second time", async () => {
    await act(async () => { render(<AgentSchedulesView scope="p" active />); });
    await act(async () => { fireEvent.click(screen.getByTestId("open-prompt-chart")); });
    const opened = () => useTabsStore.getState().tabsByScope.p.filter((tab) => tab.kind === "promptchart");
    expect(opened()).toHaveLength(1);
    expect(opened()[0].label).toBe("Prompt chart");
    await act(async () => { fireEvent.click(screen.getByTestId("open-prompt-chart")); });
    expect(opened()).toHaveLength(1);
  });

  it("charts the scope's agent tabs in its own tab", async () => {
    await act(async () => { render(<PromptChartTab scope="p" />); });
    expect(await screen.findByText("Prompt chart")).toBeTruthy();
    expect(screen.getByTestId("prompt-timeline")).toBeTruthy();
    expect((await screen.findByTestId("prompt-chart-card-draft")).textContent).toContain("Run the tests");
  });

  it("keeps the per-tab composer and its prefix send path", async () => {
    await act(async () => { render(<AgentSchedulesView scope="p" active />); });
    fireEvent.click(screen.getByRole("button", { name: "Prompt" }));
    fireEvent.click(screen.getByRole("button", { name: "/clear" }));
    fireEvent.change(screen.getByLabelText("Ask Claude…"), { target: { value: "Check it" } });
    await act(async () => { fireEvent.click(screen.getByText("Send to this tab")); });
    const call = vi.mocked(invoke).mock.calls.find(([name]) => name === "agent_schedule_upsert");
    expect((call?.[1] as { schedule: { message: string; preface: string[] } }).schedule).toMatchObject({ message: "Check it", preface: ["/clear"] });
  });

  it("collects a new draft through the chart toolbar", async () => {
    await act(async () => { render(<PromptChartTab scope="p" />); });
    fireEvent.click(screen.getByRole("button", { name: "New draft" }));
    fireEvent.change(screen.getByLabelText("Write a prompt to keep for later…"), { target: { value: "Summarise the diff" } });
    await act(async () => { fireEvent.click(screen.getByText("Add prompt")); });
    const call = vi.mocked(invoke).mock.calls.find(([name]) => name === "agent_prompt_upsert");
    expect((call?.[1] as { prompt: { message: string } }).prompt.message).toBe("Summarise the diff");
  });

  it("filters the drafts and the timeline apart, each dimming and hiding only its own cards", async () => {
    const queued = { id: "q", enabled: true, message: "Wait for idle", rule: { type: "once", at: localOccurrenceKey(new Date(Date.now() - 60_000)) } };
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "agent_prompts_list") return [{ id: "draft", message: "Run the tests", tags: ["tests"], created_at: "x", updated_at: "x" }];
      if (command === "agent_schedules_list") return [queued];
      return [];
    });
    await act(async () => { render(<PromptChartTab scope="p" />); });
    const draftBar = within(screen.getByTestId("prompt-chart-draft-filter"));
    const timelineBar = within(screen.getByTestId("prompt-chart-timeline-filter"));
    const draft = await screen.findByTestId("prompt-chart-card-draft");
    const waiting = await screen.findByTestId("prompt-chart-card-queued");

    fireEvent.change(screen.getByLabelText("Search drafts or #tag…"), { target: { value: "nothing" } });
    expect(draft.className).toContain("is-dimmed");
    expect(waiting.className).not.toContain("is-dimmed");
    fireEvent.click(draftBar.getByRole("button", { name: "Hide others" }));
    expect(screen.queryByTestId("prompt-chart-card-draft")).toBeNull();
    expect(screen.getByTestId("prompt-chart-card-queued")).toBeTruthy();

    // The timeline's When window: a queued card waits at now, so it is upcoming.
    fireEvent.click(timelineBar.getByRole("button", { name: /Any time/ }));
    fireEvent.click(screen.getByRole("option", { name: "Past" }));
    expect(screen.getByTestId("prompt-chart-card-queued").className).toContain("is-dimmed");
    fireEvent.click(timelineBar.getByRole("button", { name: "Hide others" }));
    expect(screen.queryByTestId("prompt-chart-card-queued")).toBeNull();
  });

  it("hides the timeline to leave the drafts alone, and remembers it", async () => {
    localStorage.removeItem(storageKey("promptChart.timeline"));
    const { unmount } = await act(async () => render(<PromptChartTab scope="p" />));
    expect(screen.getByTestId("prompt-timeline")).toBeTruthy();
    // The toggle lives in the timeline's own head, beside its name and count.
    const head = within(screen.getByTestId("prompt-chart-timeline-bar"));
    expect(head.getByText("Timeline")).toBeTruthy();
    fireEvent.click(head.getByRole("button", { name: "Hide" }));
    expect(screen.queryByTestId("prompt-timeline")).toBeNull();
    expect(screen.queryByTestId("prompt-chart-timeline-filter")).toBeNull();
    // The head stays, or there would be nothing to bring the axis back with.
    expect(head.getByRole("button", { name: "Show" })).toBeTruthy();
    expect(await screen.findByTestId("prompt-chart-card-draft")).toBeTruthy();
    unmount();
    await act(async () => { render(<PromptChartTab scope="p" />); });
    expect(screen.queryByTestId("prompt-timeline")).toBeNull();
    fireEvent.click(within(screen.getByTestId("prompt-chart-timeline-bar")).getByRole("button", { name: "Show" }));
    expect(screen.getByTestId("prompt-timeline")).toBeTruthy();
    localStorage.removeItem(storageKey("promptChart.timeline"));
  });

  it("opens a draft's Markdown editor on double click and saves the edit", async () => {
    await act(async () => { render(<PromptChartTab scope="p" />); });
    const card = await screen.findByTestId("prompt-chart-card-draft");
    fireEvent.doubleClick(within(card).getByText("Run the tests"));
    const field = within(card).getByLabelText("Write a prompt to keep for later…");
    expect(card.querySelector(".md-prompt")).toBeTruthy();
    fireEvent.change(field, { target: { value: "Run the unit tests" } });
    await act(async () => { fireEvent.keyDown(field, { key: "Enter", ctrlKey: true }); });
    const call = vi.mocked(invoke).mock.calls.find(([name]) => name === "agent_prompt_upsert");
    expect((call?.[1] as { prompt: { message: string } }).prompt.message).toBe("Run the unit tests");
  });

  it("shows queued prompts at the now line rather than in the tab row", async () => {
    // Due a minute ago: inside the catch-up window, so it waits at the now line.
    const queued = { id: "q", enabled: true, message: "Wait for idle", rule: { type: "once", at: localOccurrenceKey(new Date(Date.now() - 60_000)) } };
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "agent_schedules_list") return [queued];
      if (command === "agent_prompts_list" || command === "agent_prompt_history_list" || command === "agent_prompt_links_list") return [];
      return [];
    });
    await act(async () => { render(<PromptChartTab scope="p" />); });
    const queue = await screen.findByTestId("prompt-timeline-queue");
    expect(within(queue).getByText("Wait for idle")).toBeTruthy();
  });
});
