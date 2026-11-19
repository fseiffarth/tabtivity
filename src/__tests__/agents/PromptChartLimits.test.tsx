import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { PromptChart } from "../../components/agents/PromptChart";
import { localOccurrenceKey } from "../../lib/agents/agentSchedule";
import { useAgentPromptsStore } from "../../stores/agents/agentPrompts";
import { useAgentSchedulesStore } from "../../stores/agents/agentSchedules";
import { useSettingsStore } from "../../stores/settings";
import type { TabEntry } from "../../stores/tabs";

const tab: TabEntry = { key: "a", label: "Claude", cmd: "claude", cwd: "/p", kind: "agent", scheduleTargetId: "t", sessionId: "s" };
const tab2: TabEntry = { key: "b", label: "Codex", cmd: "codex", cwd: "/p", kind: "agent", scheduleTargetId: "t2", sessionId: "s2" };
const NOW = new Date(2026, 8, 4, 12, 2, 0);
let panel = "Current session: 94% used · resets 2:20pm\nCurrent week (all models): 38% used · resets Mon 9am";

type Call = [string, Record<string, any> | undefined];
const calls = (name: string) => (vi.mocked(invoke).mock.calls as Call[]).filter(([command]) => command === name).map(([, args]) => args!);

function domRect(rect: { left: number; top: number; width: number; height: number }): DOMRect {
  return { ...rect, x: rect.left, y: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height, toJSON: () => rect } as DOMRect;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  panel = "Current session: 94% used · resets 2:20pm\nCurrent week (all models): 38% used · resets Mon 9am";
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const body = args as Record<string, any> | undefined;
    if (command === "agent_prompts_list") return [{ id: "draft", message: "Plain draft", created_at: "x", updated_at: "x" }];
    if (command === "agent_usage") return { agent: body!.agent, label: "x", supported: body!.agent === "claude", raw: panel, cached: false };
    return [];
  });
  useAgentPromptsStore.setState({ byProject: {}, historyByProject: {}, linksByProject: {}, loading: {} });
  useSettingsStore.setState({ settings: null, loaded: true });
  useAgentSchedulesStore.setState({
    byTarget: {
      ["p\u0000t"]: [{ id: "heavy", enabled: true, message: "Heavy run", rule: { type: "once", at: localOccurrenceKey(new Date(2026, 8, 4, 13, 0)) } }],
      ["p\u0000t2"]: [{ id: "light", enabled: true, message: "Light review", rule: { type: "once", at: localOccurrenceKey(new Date(2026, 8, 4, 12, 40)) } }],
    },
    loading: {},
  });
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
});

const renderChart = async () => {
  await act(async () => { render(<PromptChart scope="p" active tabs={[tab, tab2]} />); });
  await screen.findByText("Heavy run");
  await act(async () => { await Promise.resolve(); });
};
const cardOf = (text: string) => screen.getByText(text).closest("article")!;

describe("the usage band", () => {
  it("draws the 5h window as a bar with the percent in its text, a weekly tick, and no reset label in the hour axis", async () => {
    await renderChart();
    const band = within(await screen.findByTestId("prompt-usage-band"));
    expect(band.getByText("Claude · 5h window · 94% used")).toBeTruthy();
    expect(band.getByText(/^new window from/)).toBeTruthy();
    // Codex has no usage panel: one row.
    expect(band.getAllByTestId("prompt-usage-row")).toHaveLength(1);
    expect(document.querySelector(".agent-prompt-timeline-axis .agent-prompt-timeline-reset-label")).toBeNull();
    // The dashed line stays in the underlay.
    expect(document.querySelector(".agent-prompt-timeline-underlay .agent-prompt-timeline-reset")).toBeTruthy();
    expect(document.querySelector(".agent-prompt-usage-bar")?.classList.contains("is-high")).toBe(true);
  });

  it("tones the bar by percent used", async () => {
    panel = "Current session: 75% used · resets 2:20pm";
    await renderChart();
    await screen.findByTestId("prompt-usage-band");
    expect(document.querySelector(".agent-prompt-usage-bar")?.classList.contains("is-warn")).toBe(true);
  });
});

describe("the limit warning", () => {
  it("warns a scheduled card due before the reset on a 94% agent, and not one on an agent with room", async () => {
    await renderChart();
    await screen.findByTestId("prompt-usage-band");
    const warning = within(cardOf("Heavy run")).getByTestId("prompt-limit-warning");
    expect(warning.textContent).toContain("May hit the limit: 94% used until");
    expect(within(cardOf("Light review")).queryByTestId("prompt-limit-warning")).toBeNull();
  });

  it("is not raised below 90%, or for a card due after the reset", async () => {
    panel = "Current session: 89% used · resets 2:20pm";
    await renderChart();
    await screen.findByTestId("prompt-usage-band");
    expect(within(cardOf("Heavy run")).queryByTestId("prompt-limit-warning")).toBeNull();
  });

  it("Move after reset retimes the rule to the first snap minute after the reset", async () => {
    await renderChart();
    await screen.findByTestId("prompt-usage-band");
    await act(async () => { fireEvent.click(within(cardOf("Heavy run")).getByRole("button", { name: "Move after reset" })); });
    expect(calls("agent_schedule_upsert")[0]).toMatchObject({
      scheduleTargetId: "t",
      schedule: { id: "heavy", rule: { type: "once", at: localOccurrenceKey(new Date(2026, 8, 4, 14, 20)) } },
    });
  });

  it("repeats the warning and the move in the inspector", async () => {
    await renderChart();
    await screen.findByTestId("prompt-usage-band");
    fireEvent.click(cardOf("Heavy run"));
    const inspector = within(screen.getByTestId("prompt-chart-inspector"));
    expect(inspector.getByTestId("prompt-limit-warning")).toBeTruthy();
    expect(inspector.getByRole("button", { name: "Move after reset" })).toBeTruthy();
  });

  it("offers no move for a recurring rule", async () => {
    useAgentSchedulesStore.setState({
      byTarget: {
        ["p\u0000t"]: [{ id: "daily", enabled: true, message: "Heavy run", rule: { type: "daily", time: "13:00" } }],
        ["p\u0000t2"]: [],
      },
    });
    await renderChart();
    await screen.findByTestId("prompt-usage-band");
    expect(within(cardOf("Heavy run")).getByTestId("prompt-limit-warning")).toBeTruthy();
    expect(within(cardOf("Heavy run")).queryByRole("button", { name: "Move after reset" })).toBeNull();
  });
});

describe("snapping a drop to a reset", () => {
  const layout = () => {
    const fold = screen.queryByTestId("prompt-timeline-fold");
    if (fold) fireEvent.click(fold);
    vi.spyOn(screen.getByTestId("prompt-chart-strip"), "getBoundingClientRect").mockReturnValue(domRect({ left: 0, top: 0, width: 1000, height: 60 }));
    vi.spyOn(screen.getByTestId("prompt-timeline-body"), "getBoundingClientRect").mockReturnValue(domRect({ left: 0, top: 100, width: 1000, height: 300 }));
    vi.spyOn(screen.getByTestId("prompt-timeline-now-band"), "getBoundingClientRect").mockReturnValue(domRect({ left: 83, top: 100, width: 20, height: 300 }));
  };
  const drag = async (from: Element, to: { x: number; y: number }) => {
    fireEvent.pointerDown(from, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 10, clientY: 40 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: to.x, clientY: to.y });
    return () => act(async () => { fireEvent.pointerUp(window, { pointerId: 1, clientX: to.x, clientY: to.y }); });
  };
  const free = () => useAgentSchedulesStore.setState({ byTarget: { ["p\u0000t"]: [], ["p\u0000t2"]: [] }, loading: {} });

  it("lands a draft dropped within 10 px of the 5h reset at the first minute after it, and says so in the badge", async () => {
    free();
    await act(async () => { render(<PromptChart scope="p" active tabs={[tab, tab2]} />); });
    await screen.findByText("Plain draft");
    await act(async () => { await Promise.resolve(); });
    await screen.findByTestId("prompt-usage-band");
    layout();
    // 1000px a day: 14:20 is x 597.2; 600 is 14:24, which the 5-minute grid rounds to 14:25 (3.5 px away).
    const release = await drag(cardOf("Plain draft"), { x: 600, y: 180 });
    expect(screen.getByTestId("prompt-timeline").textContent).toContain("after the 5h reset");
    await release();
    expect(calls("agent_schedule_upsert")[0]).toMatchObject({ schedule: { id: "draft", rule: { type: "once", at: localOccurrenceKey(new Date(2026, 8, 4, 14, 20)) } } });
  });

  it("leaves a drop far from the reset on the grid", async () => {
    free();
    await act(async () => { render(<PromptChart scope="p" active tabs={[tab, tab2]} />); });
    await screen.findByText("Plain draft");
    await act(async () => { await Promise.resolve(); });
    await screen.findByTestId("prompt-usage-band");
    layout();
    const release = await drag(cardOf("Plain draft"), { x: 700, y: 180 });
    expect(screen.getByTestId("prompt-timeline").textContent).not.toContain("after the 5h reset");
    await release();
    expect(calls("agent_schedule_upsert")[0].schedule.rule.at).toBe(localOccurrenceKey(new Date(2026, 8, 4, 16, 50)));
  });
});
