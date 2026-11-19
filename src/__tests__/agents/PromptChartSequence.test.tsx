import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { PromptChart } from "../../components/agents/PromptChart";
import { useAgentPromptsStore, type PromptLink } from "../../stores/agents/agentPrompts";
import { useAgentSchedulesStore } from "../../stores/agents/agentSchedules";
import { useSettingsStore } from "../../stores/settings";
import type { TabEntry } from "../../stores/tabs";

const tab: TabEntry = { key: "a", label: "Claude", cmd: "claude", cwd: "/p", kind: "agent", scheduleTargetId: "t", sessionId: "s" };
const NOW = new Date(2026, 8, 4, 12, 2, 0);
const at = (hour: number, minute = 0) => new Date(2026, 8, 4, hour, minute).toISOString();

type Call = [string, Record<string, any> | undefined];
const calls = (name: string) => (vi.mocked(invoke).mock.calls as Call[]).filter(([command]) => command === name).map(([, args]) => args!);

const prompts = ["b", "c", "d", "loose"].map((id) => ({ id, message: `Prompt ${id}`, created_at: "x", updated_at: "x" }));
const history = [{ id: "a", message: "Prompt a", created_at: "x", sent_at: at(9), files_at: at(9, 11), tab_label: "Claude", session_id: "s", result: "delivered" as const }];
let links: PromptLink[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  links = [
    { id: "ab", from: "a", to: "b", kind: "after", target: "t" },
    { id: "bc", from: "b", to: "c", kind: "after", target: "t", preface: ["/clear"] },
    { id: "cd", from: "c", to: "d", kind: "after", target: "t" },
  ];
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const body = args as Record<string, any> | undefined;
    if (command === "agent_prompts_list") return prompts;
    if (command === "agent_prompt_history_list") return history;
    if (command === "agent_prompt_links_list") return links;
    if (command === "agent_prompt_link_upsert") {
      links = [...links.filter((link) => link.id !== body!.link.id), body!.link];
      return links;
    }
    if (command === "agent_prompt_link_delete") {
      links = links.filter((link) => link.id !== body!.linkId);
      return links;
    }
    return [];
  });
  useAgentPromptsStore.setState({ byProject: {}, historyByProject: {}, linksByProject: {}, loading: {} });
  useSettingsStore.setState({ settings: null, loaded: true });
  useAgentSchedulesStore.setState({ byTarget: { ["p\u0000t"]: [] }, loading: {} });
});

afterEach(() => {
  vi.useRealTimers();
});

const renderChart = async () => {
  await act(async () => { render(<PromptChart scope="p" active tabs={[tab]} />); });
  await screen.findByText("Prompt b");
};
const openSequence = () => fireEvent.click(screen.getByTitle("Show the sequence in the inspector"));
const inspector = () => within(screen.getByTestId("prompt-sequence-inspector"));

describe("sequences in the Drafts column", () => {
  it("groups an After chain: a heading, the sent step as a row, the chained steps as cards numbered n of m", async () => {
    await renderChart();
    const group = within(screen.getByTestId("prompt-sequence"));
    expect(group.getByText("Sequence · 4 steps")).toBeTruthy();
    expect(group.getByTestId("prompt-sequence-standing").textContent).toBe("step 2 of 4");
    expect(group.getByTestId("prompt-sequence-row").textContent).toContain("Prompt a");
    const times = group.getAllByTestId("prompt-chart-card-chained").map((card) => card.querySelector(".agent-prompt-card-time")?.textContent);
    expect(times).toEqual(["Step 2 of 4", "Step 3 of 4", "Step 4 of 4"]);
    // A prompt outside the chain stays loose, after the group.
    expect(group.queryByText("Prompt loose")).toBeNull();
    expect(within(screen.getByTestId("prompt-chart-strip")).getByText("Prompt loose")).toBeTruthy();
  });

  it("says step n of m on the timeline card of a member", async () => {
    await renderChart();
    const timeline = within(screen.getByTestId("prompt-timeline"));
    expect(timeline.getByText("Prompt a").closest("article")!.querySelector("[data-testid=prompt-card-step]")?.textContent).toBe("step 1 of 4");
  });

  it("opens the sequence in the inspector: progress, one line a step, the commands between two", async () => {
    await renderChart();
    openSequence();
    expect(inspector().getByTestId("prompt-sequence-summary").textContent).toContain("1 done · 0 running · 3 waiting");
    expect(inspector().getByRole("img", { name: "1 of 4 steps done, 0 running" })).toBeTruthy();
    const steps = inspector().getAllByTestId("prompt-sequence-step").map((step) => step.querySelector("small")?.textContent);
    expect(steps[0]).toMatch(/^Finished .* · 11 min/u);
    expect(steps[1]).toContain("Next · goes out when step 1 has finished");
    expect(steps[2]).toContain("Waiting · goes to");
    expect(inspector().getByText("/clear")).toBeTruthy();
    // Escape closes it.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("prompt-sequence-inspector")).toBeNull();
  });
});

describe("pause, skip and stop", () => {
  it("Pause flags the edge into the next step, and the group says Paused", async () => {
    await renderChart();
    openSequence();
    await act(async () => { fireEvent.click(inspector().getByRole("button", { name: "Pause" })); });
    expect(calls("agent_prompt_link_upsert")[0].link).toMatchObject({ id: "ab", from: "a", to: "b", paused: true });
    expect(await screen.findByText("Paused", { selector: "[data-testid=prompt-sequence-standing]" })).toBeTruthy();
    // The held card wears the word, not its place.
    const held = screen.getAllByTestId("prompt-chart-card-chained")[0];
    expect(held.querySelector(".agent-prompt-chip")?.textContent).toBe("Paused");
  });

  it("Resume clears the flag, and sends the held step at once when its predecessor had finished", async () => {
    links = links.map((link) => (link.id === "ab" ? { ...link, paused: true } : link));
    await renderChart();
    openSequence();
    await act(async () => { fireEvent.click(inspector().getByRole("button", { name: "Resume" })); });
    // Not paused any more: the key is absent, not false.
    expect(Object.keys(calls("agent_prompt_link_upsert")[0].link)).not.toContain("paused");
    expect(calls("agent_prompt_link_upsert")[0].link).toMatchObject({ id: "ab" });
    expect(calls("agent_schedule_upsert")[0]).toMatchObject({ scheduleTargetId: "t", schedule: { id: "b", message: "Prompt b" } });
    expect(calls("agent_prompt_archive")).toHaveLength(1);
  });

  it("sends the key paused only when it is true", async () => {
    await renderChart();
    await act(async () => {
      await useAgentPromptsStore.getState().link("p", { id: "x", from: "b", to: "d", kind: "related" });
    });
    expect(Object.keys(calls("agent_prompt_link_upsert")[0].link).sort()).toEqual(["from", "id", "kind", "to"]);
  });

  it("Skip next step links its neighbours, carrying the removed edge's commands", async () => {
    await renderChart();
    openSequence();
    await act(async () => { fireEvent.click(inspector().getByRole("button", { name: "Skip next step" })); });
    expect(calls("agent_prompt_link_delete").map((call) => call.linkId)).toEqual(["ab", "bc"]);
    expect(calls("agent_prompt_link_upsert")[0].link).toMatchObject({ from: "a", to: "c", kind: "after", target: "t", preface: ["/clear"] });
    // The skipped prompt is a loose draft again: out of the group.
    const group = within(screen.getByTestId("prompt-sequence"));
    expect(group.getByText("Sequence · 3 steps")).toBeTruthy();
    expect(group.queryByText("Prompt b")).toBeNull();
  });

  it("Stop removes the edge into the next step and leaves the rest linked", async () => {
    await renderChart();
    openSequence();
    await act(async () => { fireEvent.click(inspector().getByRole("button", { name: "Stop" })); });
    expect(calls("agent_prompt_link_delete").map((call) => call.linkId)).toEqual(["ab"]);
    expect(links.map((link) => link.id)).toEqual(["bc", "cd"]);
    // What is left is a sequence of three drafts, b -> c -> d.
    expect(within(screen.getByTestId("prompt-sequence")).getByText("Sequence · 3 steps")).toBeTruthy();
  });

  it("Edit on the commands between two prompts opens the link editor", async () => {
    await renderChart();
    openSequence();
    const row = inspector().getByText("/clear").closest("div")!;
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
    expect(await screen.findByRole("group", { name: "New links" })).toBeTruthy();
  });
});

describe("sequences on the free canvas", () => {
  it("draws an outline around the chained cards, with the same heading", async () => {
    await renderChart();
    fireEvent.click(screen.getByRole("button", { name: "Free layout" }));
    const outline = screen.getByTestId("prompt-sequence-outline");
    expect(within(outline).getByText("Sequence · 4 steps")).toBeTruthy();
    localStorage.removeItem("promptChart.drafts.p");
  });
});
