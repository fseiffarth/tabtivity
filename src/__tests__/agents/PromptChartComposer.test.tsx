import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { PromptChart } from "../../components/agents/PromptChart";
import { localOccurrenceKey } from "../../lib/agents/agentSchedule";
import { useAgentPromptsStore, type ProjectAgentPrompt } from "../../stores/agents/agentPrompts";
import { useAgentSchedulesStore } from "../../stores/agents/agentSchedules";
import { useSettingsStore } from "../../stores/settings";
import type { TabEntry } from "../../stores/tabs";

const tab: TabEntry = { key: "a", label: "Claude", cmd: "claude", cwd: "/p", kind: "agent", scheduleTargetId: "t", sessionId: "s" };
const tab2: TabEntry = { key: "b", label: "Codex", cmd: "codex", cwd: "/p", kind: "agent", scheduleTargetId: "t2", sessionId: "s2" };
const NOW = new Date(2026, 8, 4, 12, 2, 0);
const PANEL = "Current session: 94% used · resets 2:20pm\nCurrent week (all models): 38% used · resets Mon 9am";

type Call = [string, Record<string, unknown> | undefined];
const calls = (name: string) => (vi.mocked(invoke).mock.calls as Call[]).filter(([command]) => command === name).map(([, args]) => args);

let stored: ProjectAgentPrompt[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  stored = [{ id: "src", message: "Source prompt", created_at: "x", updated_at: "x" }];
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const body = args as Record<string, any> | undefined;
    if (command === "agent_prompts_list") return stored;
    if (command === "agent_prompt_upsert") {
      stored = [...stored, { id: body!.prompt.id, message: body!.prompt.message, created_at: "x", updated_at: "x", target: body!.prompt.target ?? undefined }];
      return stored;
    }
    if (command === "agent_usage") return { agent: body!.agent, label: "Claude", supported: body!.agent === "claude", raw: PANEL, cached: false };
    return [];
  });
  useAgentPromptsStore.setState({ byProject: {}, historyByProject: {}, linksByProject: {}, loading: {} });
  useSettingsStore.setState({ settings: null, loaded: true });
  useAgentSchedulesStore.setState({ byTarget: { ["p\u0000t"]: [], ["p\u0000t2"]: [] }, loading: {} });
});

afterEach(() => {
  vi.useRealTimers();
});

const composer = () => within(screen.getByTestId("prompt-composer"));
const type = (value: string) => fireEvent.change(composer().getByRole("textbox", { name: "Write a prompt" }), { target: { value } });
const press = (init: Partial<KeyboardEventInit>) => fireEvent.keyDown(composer().getByRole("textbox", { name: "Write a prompt" }), { key: "Enter", ...init });
const chooseWhen = (label: string | RegExp) => {
  fireEvent.click(screen.getByTestId("prompt-composer-when"));
  fireEvent.click(within(screen.getByRole("menu", { name: "When to send" })).getByRole("menuitemradio", { name: label }));
};
const chooseTab = (label: string) => {
  fireEvent.click(composer().getByTitle("Agent tab"));
  fireEvent.click(composer().getByRole("option", { name: label }));
};
const renderChart = async (tabs: TabEntry[] = [tab, tab2]) => {
  await act(async () => { render(<PromptChart scope="p" active tabs={tabs} />); });
  await screen.findByText("Source prompt");
  // The usage panel is read on mount: let the marks land.
  await act(async () => { await Promise.resolve(); });
};

describe("quick composer", () => {
  it("keeps a prompt as a draft on Enter, and Shift+Enter only adds a line", async () => {
    await renderChart();
    type("write the report");
    press({ shiftKey: true });
    expect(calls("agent_prompt_upsert")).toHaveLength(0);
    await act(async () => { press({}); });
    expect(calls("agent_prompt_upsert")).toHaveLength(1);
    expect(calls("agent_prompt_upsert")[0]).toMatchObject({ prompt: { message: "write the report", target: null } });
    expect(calls("agent_schedule_upsert")).toHaveLength(0);
    // The field empties and the When choice goes back to a draft.
    expect((composer().getByRole("textbox", { name: "Write a prompt" }) as HTMLTextAreaElement).value).toBe("");
    expect(composer().getByTestId("prompt-composer-submit").textContent).toBe("Add");
  });

  it("writes nothing for an empty field", async () => {
    await renderChart();
    type("   ");
    await act(async () => { press({}); });
    expect(calls("agent_prompt_upsert")).toHaveLength(0);
    expect((composer().getByTestId("prompt-composer-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("names the submit after the choice and says what Enter does", async () => {
    await renderChart();
    type("x");
    expect(composer().getByTestId("prompt-composer-submit").textContent).toBe("Add");
    chooseWhen(/^Send now/);
    expect(composer().getByTestId("prompt-composer-submit").textContent).toBe("Send");
    expect(composer().getByTestId("prompt-composer-hint").textContent).toContain("sends it to New Claude tab now");
    chooseWhen(/^At a time/);
    expect(composer().getByTestId("prompt-composer-submit").textContent).toBe("Schedule");
    chooseWhen(/^After another prompt/);
    expect(composer().getByTestId("prompt-composer-submit").textContent).toBe("Add");
  });

  it("sends now to the picked tab: the draft first, then the send", async () => {
    await renderChart();
    chooseTab("Codex");
    type("ship it");
    chooseWhen(/^Send now/);
    await act(async () => { press({}); });
    expect(calls("agent_prompt_upsert")[0]).toMatchObject({ prompt: { message: "ship it", target: "t2" } });
    expect(calls("agent_schedule_upsert")[0]).toMatchObject({ projectId: "p", scheduleTargetId: "t2", schedule: { message: "ship it" } });
    expect(calls("agent_prompt_archive")).toHaveLength(1);
  });

  it("opens the schedule dialog on the tab for At a time…, with the draft behind it", async () => {
    await renderChart();
    chooseTab("Claude");
    type("tonight's run");
    chooseWhen(/^At a time/);
    await act(async () => { press({}); });
    expect(calls("agent_prompt_upsert")).toHaveLength(1);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByDisplayValue("tonight's run")).toBeTruthy();
  });

  it("offers the reset choices only for an agent with a reset ahead, and lists when each lands", async () => {
    await renderChart();
    chooseTab("Claude");
    fireEvent.click(screen.getByTestId("prompt-composer-when"));
    const menu = within(screen.getByRole("menu", { name: "When to send" }));
    expect(menu.getByRole("menuitemradio", { name: /After the 5h reset/ }).textContent).toContain("2:20 PM");
    expect(menu.getByRole("menuitemradio", { name: /After the weekly reset/ }).textContent).toContain("9:00 AM");
    fireEvent.keyDown(document, { key: "Escape" });
    // Codex has no usage panel: no reset choice, and a stale pick falls back.
    chooseTab("Codex");
    fireEvent.click(screen.getByTestId("prompt-composer-when"));
    const codexMenu = within(screen.getByRole("menu", { name: "When to send" }));
    expect(codexMenu.queryByRole("menuitemradio", { name: /reset/ })).toBeNull();
  });

  it("schedules after the 5h reset as a one-time rule at the first snap minute, with a dashed preview", async () => {
    await renderChart();
    chooseTab("Claude");
    type("after the limit");
    chooseWhen(/After the 5h reset/);
    expect(await screen.findByTestId("prompt-timeline-preview")).toBeTruthy();
    expect(within(screen.getByTestId("prompt-timeline-preview")).getByText("Lands here")).toBeTruthy();
    expect(composer().getByTestId("prompt-composer-hint").textContent).toContain("schedules it on Claude for");
    await act(async () => { press({}); });
    const draft = calls("agent_prompt_upsert")[0] as { prompt: { id: string } };
    expect(calls("agent_schedule_upsert")[0]).toMatchObject({
      scheduleTargetId: "t",
      schedule: { id: draft.prompt.id, message: "after the limit", rule: { type: "once", at: localOccurrenceKey(new Date(2026, 8, 4, 14, 20)) } },
    });
    // Written: the preview is gone with the text.
    expect(screen.queryByTestId("prompt-timeline-preview")).toBeNull();
  });

  it("does not offer a tab that already holds a rule", async () => {
    useAgentSchedulesStore.setState({
      byTarget: { ["p\u0000t"]: [{ id: "held", enabled: true, message: "Held", rule: { type: "once", at: localOccurrenceKey(new Date(NOW.getTime() + 3_600_000)) } }], ["p\u0000t2"]: [] },
    });
    await renderChart();
    // The occupied tab is not offered; the picker lists the free one and the new tab (a rule needs a free tab, as a draft does).
    fireEvent.click(composer().getByTitle("Agent tab"));
    expect(composer().queryByRole("option", { name: "Claude" })).toBeNull();
    expect(composer().getByRole("option", { name: "Codex" })).toBeTruthy();
  });

  it("After another prompt… keeps a draft, then the next card clicked becomes the source of an After link", async () => {
    await renderChart();
    type("follow-up");
    chooseWhen(/^After another prompt/);
    await act(async () => { press({}); });
    const draft = calls("agent_prompt_upsert")[0] as { prompt: { id: string } };
    expect(await screen.findByTestId("prompt-chart-link-armed")).toBeTruthy();
    expect(screen.getByTestId("prompt-chart-link-armed").textContent).toContain("Pick the prompt it follows");
    await act(async () => { fireEvent.click(screen.getByText("Source prompt").closest("article")!); });
    expect(calls("agent_prompt_link_upsert")[0]).toMatchObject({ link: { from: "src", to: draft.prompt.id, kind: "after" } });
    expect(screen.queryByTestId("prompt-chart-link-armed")).toBeNull();
  });

  it("Escape leaves the draft unlinked", async () => {
    await renderChart();
    type("follow-up");
    chooseWhen(/^After another prompt/);
    await act(async () => { press({}); });
    expect(await screen.findByTestId("prompt-chart-link-armed")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("prompt-chart-link-armed")).toBeNull();
    expect(calls("agent_prompt_link_upsert")).toHaveLength(0);
    expect(calls("agent_prompt_upsert")).toHaveLength(1);
  });

  it("Escape typed in the composer's own field (where Enter left the focus) ends the pick too", async () => {
    await renderChart();
    type("follow-up");
    chooseWhen(/^After another prompt/);
    await act(async () => { press({}); });
    expect(await screen.findByTestId("prompt-chart-link-armed")).toBeTruthy();
    fireEvent.keyDown(composer().getByRole("textbox", { name: "Write a prompt" }), { key: "Escape" });
    expect(screen.queryByTestId("prompt-chart-link-armed")).toBeNull();
    expect(calls("agent_prompt_link_upsert")).toHaveLength(0);
  });

  it("Escape in the composer with nothing armed leaves the selection alone", async () => {
    await renderChart();
    await act(async () => { fireEvent.click(screen.getByText("Source prompt").closest("article")!); });
    expect(screen.getByTestId("prompt-chart-inspector")).toBeTruthy();
    type("half a thought");
    fireEvent.keyDown(composer().getByRole("textbox", { name: "Write a prompt" }), { key: "Escape" });
    expect(screen.getByTestId("prompt-chart-inspector")).toBeTruthy();
  });

  it("keeps the text when the draft's own write fails", async () => {
    await renderChart();
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "agent_prompt_upsert") throw new Error("disk full");
      return [];
    });
    type("keep me");
    await act(async () => { press({}); });
    expect((composer().getByRole("textbox", { name: "Write a prompt" }) as HTMLTextAreaElement).value).toBe("keep me");
    expect(screen.getByTestId("prompt-chart-error").textContent).toContain("disk full");
  });
});
