import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { PromptChart } from "../../components/agents/PromptChart";
import { localOccurrenceKey } from "../../lib/agents/agentSchedule";
import { useAgentPromptsStore } from "../../stores/agents/agentPrompts";
import { scheduleCacheKey, useAgentSchedulesStore } from "../../stores/agents/agentSchedules";
import { useSettingsStore } from "../../stores/settings";
import type { TabEntry } from "../../stores/tabs";
import { storageKey } from "../../lib/brand";

const tab: TabEntry = { key: "a", label: "Claude", cmd: "claude", cwd: "/p", kind: "agent", scheduleTargetId: "t", sessionId: "s" };
const NOW = new Date(2026, 8, 4, 12, 2, 0);
const DRAFTS_KEY = storageKey("promptChart.drafts.p");

type Call = [string, Record<string, unknown> | undefined];
const calls = (name: string) => (vi.mocked(invoke).mock.calls as Call[]).filter(([command]) => command === name).map(([, args]) => args);

function domRect(rect: { left: number; top: number; width: number; height: number }): DOMRect {
  return { ...rect, x: rect.left, y: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height, toJSON: () => rect } as DOMRect;
}

/** A 1000px-wide day in client space, as `PromptChart.test.tsx` lays it out. */
function layout() {
  vi.spyOn(screen.getByTestId("prompt-chart-strip"), "getBoundingClientRect").mockReturnValue(domRect({ left: 0, top: 0, width: 1000, height: 60 }));
  vi.spyOn(screen.getByTestId("prompt-timeline-body"), "getBoundingClientRect").mockReturnValue(domRect({ left: 0, top: 100, width: 1000, height: 300 }));
  vi.spyOn(screen.getByTestId("prompt-timeline-now-band"), "getBoundingClientRect").mockReturnValue(domRect({ left: 491, top: 100, width: 20, height: 300 }));
}

async function drag(from: Element, to: { x: number; y: number }, press: { shiftKey?: boolean } = {}, move: { shiftKey?: boolean } = {}) {
  fireEvent.pointerDown(from, { button: 0, pointerId: 1, clientX: 10, clientY: 10, ...press });
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 10, clientY: 20, ...move });
  fireEvent.pointerMove(window, { pointerId: 1, clientX: to.x, clientY: to.y, ...move });
  await act(async () => { fireEvent.pointerUp(window, { pointerId: 1, clientX: to.x, clientY: to.y }); });
}

const cardOf = (text: string) => screen.getByText(text).closest("article")!;
const itemOf = (card: Element) => card.closest<HTMLElement>(".agent-prompt-timeline-item")!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const schedules = [
    { id: "early", enabled: true, message: "Early task", rule: { type: "once" as const, at: localOccurrenceKey(new Date(NOW.getTime() + 30 * 60_000)) } },
    { id: "later", enabled: true, message: "Later task", rule: { type: "once" as const, at: localOccurrenceKey(new Date(NOW.getTime() + 60 * 60_000)) } },
  ];
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "agent_schedules_list" || command === "agent_schedule_upsert") return schedules;
    return [];
  });
  useAgentPromptsStore.setState({ byProject: {}, historyByProject: {}, linksByProject: {}, loading: {} });
  useSettingsStore.setState({ settings: null, loaded: true });
  useAgentSchedulesStore.setState({ byTarget: { [scheduleCacheKey("p", "t")]: schedules }, loading: {} });
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.removeItem(DRAFTS_KEY);
});

describe("PromptChart drafts board", () => {
  it("opens a composer on a double click into the empty drafts area and writes the draft", async () => {
    await act(async () => { render(<PromptChart scope="p" active tabs={[tab]} />); });
    fireEvent.doubleClick(screen.getByTestId("prompt-draft-board"));
    const composer = screen.getByTestId("prompt-draft-composer");
    fireEvent.change(within(composer).getByRole("textbox", { name: "Write a prompt to keep for later…" }), { target: { value: "Fresh idea" } });
    await act(async () => { fireEvent.click(within(composer).getByRole("button", { name: "Add prompt" })); });
    expect(calls("agent_prompt_upsert")[0]).toMatchObject({ projectId: "p", prompt: { message: "Fresh idea" } });
    expect(screen.queryByTestId("prompt-draft-composer")).toBeNull();
  });

  it("puts the new draft where the double click was on the free canvas, and Escape writes nothing", async () => {
    await act(async () => { render(<PromptChart scope="p" active tabs={[tab]} />); });
    fireEvent.click(screen.getByRole("button", { name: "Free layout" }));
    const board = screen.getByTestId("prompt-draft-board");
    vi.spyOn(board, "getBoundingClientRect").mockReturnValue(domRect({ left: 0, top: 0, width: 1000, height: 320 }));

    fireEvent.doubleClick(board, { clientX: 300, clientY: 200 });
    fireEvent.keyDown(within(screen.getByTestId("prompt-draft-composer")).getByRole("textbox", { name: "Write a prompt to keep for later…" }), { key: "Escape" });
    expect(screen.queryByTestId("prompt-draft-composer")).toBeNull();
    expect(calls("agent_prompt_upsert")).toHaveLength(0);

    fireEvent.doubleClick(board, { clientX: 300, clientY: 200 });
    const composer = screen.getByTestId("prompt-draft-composer");
    expect([composer.style.left, composer.style.top]).toEqual(["300px", "200px"]);
    fireEvent.change(within(composer).getByRole("textbox", { name: "Write a prompt to keep for later…" }), { target: { value: "Placed idea" } });
    await act(async () => { fireEvent.click(within(composer).getByRole("button", { name: "Add prompt" })); });
    const id = (calls("agent_prompt_upsert")[0] as { prompt: { id: string } }).prompt.id;
    expect(JSON.parse(localStorage.getItem(DRAFTS_KEY)!).positions[id]).toEqual({ x: 300, y: 200 });
  });
});

describe("PromptChart timeline selection", () => {
  it("lifts a scheduled card with Shift instead of retiming it", async () => {
    await act(async () => { render(<PromptChart scope="p" active tabs={[tab]} />); });
    layout();
    const early = cardOf("Early task");
    const top = parseFloat(itemOf(early).style.top);
    const left = itemOf(early).style.left;
    await drag(early, { x: 750, y: 70 }, { shiftKey: true });
    expect(parseFloat(itemOf(early).style.top)).toBe(top + 60);
    expect(itemOf(early).style.left).toBe(left);

    // Shift pressed once the pointer is already moving counts too.
    const later = cardOf("Later task");
    const laterTop = parseFloat(itemOf(later).style.top);
    await drag(later, { x: 750, y: 50 }, {}, { shiftKey: true });
    expect(parseFloat(itemOf(later).style.top)).toBe(laterTop + 40);
    expect(calls("agent_schedule_upsert")).toHaveLength(0);
  });

  it("moves every Ctrl-selected card by the same distance", async () => {
    await act(async () => { render(<PromptChart scope="p" active tabs={[tab]} />); });
    layout();
    fireEvent.click(cardOf("Early task"), { ctrlKey: true });
    fireEvent.click(cardOf("Later task"), { ctrlKey: true });
    expect(screen.getByTestId("prompt-chart-selection").textContent).toContain("2 selected");
    expect(cardOf("Early task").querySelector(".agent-prompt-card-expanded")).toBeNull();

    await drag(cardOf("Early task"), { x: 750, y: 180 });
    // Each move edits a rule that must still be where it was drawn from.
    expect(calls("agent_schedule_upsert")).toEqual([
      expect.objectContaining({ expectExistingOn: "t", schedule: expect.objectContaining({ id: "early", rule: { type: "once", at: "2026-09-04T18:00" } }) }),
      expect.objectContaining({ expectExistingOn: "t", schedule: expect.objectContaining({ id: "later", rule: { type: "once", at: "2026-09-04T18:30" } }) }),
    ]);
  });

  it("refuses a selection dropped on the past body, and sends it from the now band", async () => {
    await act(async () => { render(<PromptChart scope="p" active tabs={[tab]} />); });
    layout();
    fireEvent.click(cardOf("Early task"), { ctrlKey: true });
    fireEvent.click(cardOf("Later task"), { ctrlKey: true });

    fireEvent.pointerDown(cardOf("Early task"), { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 10, clientY: 20 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 120, clientY: 250 });
    const badge = document.querySelector(".agent-prompt-timeline-ghost .agent-prompt-timeline-badge")!;
    expect(badge.textContent).toBe("A selection is sent only from the now band");
    expect(badge.classList.contains("is-blocked")).toBe(true);
    // A refused selection does not light the band it is told to use.
    expect(screen.getByTestId("prompt-timeline-now-band").classList.contains("is-drop-over")).toBe(false);
    await act(async () => { fireEvent.pointerUp(window, { pointerId: 1, clientX: 120, clientY: 250 }); });
    for (const write of ["agent_schedule_upsert", "agent_schedule_delete", "agent_prompt_archive"]) expect(calls(write)).toHaveLength(0);
    expect(screen.getByTestId("prompt-chart-error").textContent).toContain("A selection is sent only from the now band");

    await drag(cardOf("Early task"), { x: 500, y: 200 });
    expect(calls("agent_schedule_delete")).toEqual([
      expect.objectContaining({ scheduleId: "early", expectUndelivered: true }),
      expect.objectContaining({ scheduleId: "later", expectUndelivered: true }),
    ]);
    expect(calls("agent_schedule_upsert").map((args) => (args as { schedule: { id: string } }).schedule.id)).toEqual(["early", "later"]);
  });

  it("says which card would land in the past when a selection is dropped on a future minute", async () => {
    await act(async () => { render(<PromptChart scope="p" active tabs={[tab]} />); });
    layout();
    fireEvent.click(cardOf("Early task"), { ctrlKey: true });
    fireEvent.click(cardOf("Later task"), { ctrlKey: true });
    // Later task (13:02) to about 12:20 would put Early task (12:32) before now.
    fireEvent.pointerDown(cardOf("Later task"), { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 10, clientY: 20 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 515, clientY: 250 });
    const badge = document.querySelector(".agent-prompt-timeline-indicator .agent-prompt-timeline-badge")!;
    expect(badge.textContent).toContain("A card in the selection would land in the past");
    expect(badge.textContent).not.toContain("now band");
    await act(async () => { fireEvent.pointerUp(window, { pointerId: 1, clientX: 515, clientY: 250 }); });
    for (const write of ["agent_schedule_upsert", "agent_schedule_delete", "agent_prompt_archive"]) expect(calls(write)).toHaveLength(0);
    expect(screen.getByTestId("prompt-chart-error").textContent).toContain("A card in the selection would land in the past");
  });

  it("writes nothing when the pressed rule is gone from the store by the release", async () => {
    await act(async () => { render(<PromptChart scope="p" active tabs={[tab]} />); });
    layout();
    fireEvent.pointerDown(cardOf("Early task"), { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 10, clientY: 20 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 750, clientY: 180 });
    // The scheduler delivered and retired it while it was in the air.
    const key = scheduleCacheKey("p", "t");
    act(() => useAgentSchedulesStore.setState((state) => ({ byTarget: { [key]: state.byTarget[key].filter((rule) => rule.id !== "early") } })));
    await act(async () => { fireEvent.pointerUp(window, { pointerId: 1, clientX: 750, clientY: 180 }); });
    expect(calls("agent_schedule_upsert")).toHaveLength(0);
    expect(calls("agent_schedule_delete")).toHaveLength(0);
    expect(screen.getByTestId("prompt-chart-error").textContent).toContain("changed while it was being carried");
  });

  it("selects with a rubber band over the lanes, and a click or Escape clears it", async () => {
    await act(async () => { render(<PromptChart scope="p" active tabs={[tab]} />); });
    layout();
    const body = screen.getByTestId("prompt-timeline-body");
    body.querySelectorAll<HTMLElement>("[data-item-key]").forEach((node, index) => {
      vi.spyOn(node, "getBoundingClientRect").mockReturnValue(domRect({ left: 0, top: 110 + index * 120, width: 168, height: 100 }));
    });

    fireEvent.pointerDown(body, { button: 0, pointerId: 1, clientX: 500, clientY: 105 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 480, clientY: 130 });
    expect(screen.getByTestId("prompt-timeline-marquee")).toBeTruthy();
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 5, clientY: 390 });
    await act(async () => { fireEvent.pointerUp(window, { pointerId: 1, clientX: 5, clientY: 390 }); });
    expect(screen.getByTestId("prompt-chart-selection").textContent).toContain("2 selected");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("prompt-chart-selection")).toBeNull();

    fireEvent.click(cardOf("Early task"), { ctrlKey: true });
    fireEvent.pointerDown(body, { button: 0, pointerId: 1, clientX: 900, clientY: 380 });
    await act(async () => { fireEvent.pointerUp(window, { pointerId: 1, clientX: 900, clientY: 380 }); });
    expect(screen.queryByTestId("prompt-chart-selection")).toBeNull();
    expect(calls("agent_schedule_upsert")).toHaveLength(0);
  });
});
