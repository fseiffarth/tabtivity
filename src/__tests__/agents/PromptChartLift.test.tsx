import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { PromptChart } from "../../components/agents/PromptChart";
import { useAgentPromptsStore } from "../../stores/agents/agentPrompts";
import { useAgentSchedulesStore } from "../../stores/agents/agentSchedules";
import { useSettingsStore } from "../../stores/settings";
import type { TabEntry } from "../../stores/tabs";

const tab: TabEntry = { key: "a", label: "Claude", cmd: "claude", cwd: "/p", kind: "agent", scheduleTargetId: "t", sessionId: "s" };
const NOW = new Date(2026, 8, 4, 12, 2, 0);
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const WRITES = ["agent_prompt_upsert", "agent_schedule_upsert", "agent_schedule_delete", "agent_prompt_history_clear", "agent_prompt_archive"];

let history: Record<string, unknown>[] = [];

/** Press at y 10, cross the threshold, end at `toY`. */
async function lift(card: Element, toY: number) {
  fireEvent.pointerDown(card, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 10, clientY: 20 });
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 400, clientY: toY });
  await act(async () => { fireEvent.pointerUp(window, { pointerId: 1, clientX: 400, clientY: toY }); });
}

const itemOf = (card: Element) => card.closest<HTMLElement>(".agent-prompt-timeline-item")!;
const frame = () => act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });

function domRect(rect: { left: number; top: number; width: number; height: number }): DOMRect {
  return { ...rect, x: rect.left, y: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height, toJSON: () => rect } as DOMRect;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  history = [{ id: "sent", message: "Already sent", created_at: "x", sent_at: ago(1), tab_label: "Claude", session_id: "s", result: "delivered" }];
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command) => (command === "agent_prompt_history_list" ? history : []));
  useAgentPromptsStore.setState({ byProject: {}, historyByProject: {}, linksByProject: {}, loading: {} });
  useSettingsStore.setState({ settings: null, loaded: true });
  useAgentSchedulesStore.setState({ byTarget: {}, loading: {} });
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PromptChart sent-card lift", () => {
  it("moves a sent card down its lane only, writes nothing, and does not toggle it open", async () => {
    await act(async () => { render(<PromptChart scope="p" active tabs={[tab]} />); });
    const card = await screen.findByTestId("prompt-chart-card-sent");
    const item = itemOf(card);
    const left = item.style.left;
    expect(item.style.top).toBe("8px");

    await lift(card, 70);
    expect(itemOf(card).style.top).toBe("68px");
    // The pointer went sideways too; the instant stays put.
    expect(itemOf(card).style.left).toBe(left);
    // The click the release produces is the drag's, not a toggle.
    fireEvent.click(card);
    expect(card.querySelector(".agent-prompt-card-expanded")).toBeNull();
    // The body grows to hold a card lifted below the lanes.
    await lift(card, 400);
    expect(parseFloat((screen.getByTestId("prompt-timeline-body").querySelector(".agent-prompt-timeline-sizer") as HTMLElement).style.height)).toBeGreaterThanOrEqual(458 + 120);

    const commands = vi.mocked(invoke).mock.calls.map(([command]) => command);
    for (const write of WRITES) expect(commands).not.toContain(write);
  });

  it("stops a session card at the body's top, and brings it back down without a dead zone", async () => {
    history = [
      { id: "h1", message: "First ask", created_at: "x", sent_at: ago(120), tab_label: "Claude", session_id: "s", result: "delivered" },
      { id: "h2", message: "Second ask", created_at: "x", sent_at: ago(60), tab_label: "Claude", session_id: "s", result: "delivered" },
    ];
    await act(async () => { render(<PromptChart scope="p" active tabs={[tab]} />); });
    const session = await screen.findByTestId("prompt-chart-session");

    await lift(session, -500);
    expect(itemOf(session).style.top).toBe("0px");
    await lift(session, 30);
    expect(itemOf(session).style.top).toBe("20px");
  });

  it("a lifted card's link follows it, and the link overlay keeps its observer", async () => {
    const Base = globalThis.ResizeObserver;
    let built = 0;
    globalThis.ResizeObserver = class extends Base {
      constructor(callback: ResizeObserverCallback) { super(callback); built += 1; }
    } as typeof ResizeObserver;
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "agent_prompt_history_list") return history;
      if (command === "agent_prompts_list") return [{ id: "note", message: "Note", created_at: "x", updated_at: "x" }];
      if (command === "agent_prompt_links_list") return [{ id: "k", from: "sent", to: "note", kind: "related" }];
      return [];
    });
    try {
      await act(async () => { render(<PromptChart scope="p" active tabs={[tab]} />); });
      const card = await screen.findByTestId("prompt-chart-card-sent");
      vi.spyOn(card, "getBoundingClientRect").mockImplementation(() =>
        domRect({ left: 100, top: 200 + (parseFloat(itemOf(card).style.top) || 0), width: 168, height: 80 }));
      const path = () => document.querySelector("svg.agent-prompt-links > path")?.getAttribute("d");

      fireEvent.pointerDown(card, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 10, clientY: 20 });
      await frame();
      const before = path();
      const observers = built;
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 400, clientY: 70 });
      await frame();
      expect(path()).toBeTruthy();
      expect(path()).not.toBe(before);
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 400, clientY: 90 });
      await frame();
      expect(built).toBe(observers);
      await act(async () => { fireEvent.pointerUp(window, { pointerId: 1, clientX: 400, clientY: 90 }); });
    } finally {
      globalThis.ResizeObserver = Base;
    }
  });

  it("puts lifted cards back from Reset positions, writing nothing", async () => {
    await act(async () => { render(<PromptChart scope="p" active tabs={[tab]} />); });
    const card = await screen.findByTestId("prompt-chart-card-sent");
    expect(screen.queryByRole("button", { name: "Reset positions" })).toBeNull();
    await lift(card, 70);
    expect(itemOf(card).style.top).toBe("68px");
    // The click a release produces is swallowed for one task; let it pass.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    fireEvent.click(screen.getByRole("button", { name: "Reset positions" }));
    expect(itemOf(card).style.top).toBe("8px");
    expect(screen.queryByRole("button", { name: "Reset positions" })).toBeNull();
    const commands = vi.mocked(invoke).mock.calls.map(([command]) => command);
    for (const write of WRITES) expect(commands).not.toContain(write);
  });
});
