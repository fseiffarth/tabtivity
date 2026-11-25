/**
 * An Antigravity tab's step checklist (`agy` 1.5.16) in the cockpit detail
 * pane: read off the tab's live terminal while it is on screen, shown as its
 * own section marked as read from the screen - beside the agent's own
 * `tab_set_progress` note, never in place of it - and gone with the checklist.
 */
import { act, cleanup, render } from "@testing-library/react";
import type { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn() }));
vi.mock("../../components/tabs/TabPane", () => ({ TabPane: () => <div /> }));
vi.mock("../../lib/shortcuts/tabJump", () => ({ jumpToTab: vi.fn(), openPromptChartTab: vi.fn() }));

import { CockpitDetail } from "../../components/cockpit/CockpitDetail";
import { PaneVisibleContext } from "../../lib/files/fileAccess";
import { buildRoster, type RosterOptions, type RosterRow } from "../../lib/cockpit/roster";
import { registerTerminal, unregisterTerminal } from "../../lib/terminal/terminalRegistry";
import { useAgentModelsStore } from "../../stores/agents/agentModels";
import type { TabEntry } from "../../stores/tabs";
import type { CockpitMeta } from "../../stores/tabs/types";

const NOW = 1_800_000_000_000;
const OPTS: RosterOptions = { stateFilter: "all", sort: "lastWorking", mode: "flat", query: "", boxFilter: null, scopeFilter: null };
const scope = { id: "p1", name: "P1", kind: "project" as const, boxIds: [] };
const RULE = "─".repeat(100);
const FOOTER = "esc to cancel                                                                   Gemini 3.1 Pro · low";
const WORKING = [
  "> do the thing",
  "⣟  1/3 steps · Generating...",
  "  ⎿  ✓ Read the config",
  "     ● Patch the reader",
  "     ○ Run the tests",
  RULE, ">", RULE, FOOTER,
];
const IDLE = ["> do the thing", "", "  all done", "", RULE, ">", RULE, "? for shortcuts                                                                 Gemini 3.1 Pro · low"];

/** A terminal that is only the rows the readers ask for, and its write event. */
function fakeTerminal(initial: string[]) {
  let rows = initial;
  const listeners = new Set<() => void>();
  const term = {
    buffer: { active: { get length() { return rows.length; }, getLine: (row: number) => (rows[row] === undefined ? undefined : { translateToString: () => rows[row] }) } },
    cols: 100,
    onWriteParsed: (cb: () => void) => { listeners.add(cb); return { dispose: () => listeners.delete(cb) }; },
  } as unknown as Terminal;
  return {
    term,
    listeners,
    draw: (next: string[]) => { rows = next; listeners.forEach((cb) => cb()); },
  };
}

function rowOf(cmd: string, label: string, cockpitMeta?: CockpitMeta, hostDown = false): RosterRow {
  const tab: TabEntry = { key: "a", label, cmd, cwd: "/p", kind: "agent", cockpitMeta };
  return buildRoster([{ scope, tab, facts: { ptyId: "p1:a", state: "working" }, hostDown }], OPTS).rows[0];
}

describe("the detail pane's checklist read from an Antigravity screen", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    useAgentModelsStore.setState({ refresh: vi.fn(() => Promise.resolve()), refreshScreen: vi.fn(() => Promise.resolve()) });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const draw = (row: RosterRow, visible = true) => render(
    <PaneVisibleContext.Provider value={visible}>
      <CockpitDetail row={row} focused={false} now={NOW} />
    </PaneVisibleContext.Provider>,
  );
  const settle = () => act(() => { vi.advanceTimersByTime(300); });

  it("shows the steps as words, marked as read from the screen, and drops them when the checklist goes", () => {
    const fake = fakeTerminal(WORKING);
    registerTerminal("p1:a", fake.term);
    const { container } = draw(rowOf("agy", "Google Antigravity"));
    const block = container.querySelector(".cockpit-screen-steps")!;
    expect(block.querySelector("summary")?.textContent).toContain("Steps on the screen");
    expect(block.textContent).toContain("1 of 3 steps done");
    expect(block.textContent).toContain("not reported by the agent");
    expect(Array.from(block.querySelectorAll(".cockpit-step")).map((li) => li.textContent)).toEqual([
      "doneRead the config",
      "in progressPatch the reader",
      "pendingRun the tests",
    ]);

    act(() => fake.draw(IDLE));
    settle();
    expect(container.querySelector(".cockpit-screen-steps")).toBeNull();

    act(() => fake.draw(WORKING));
    settle();
    expect(container.querySelector(".cockpit-screen-steps")).not.toBeNull();
    unregisterTerminal("p1:a", fake.term);
  });

  it("sits beside the agent's own progress note and leaves it as it was", () => {
    const fake = fakeTerminal(WORKING);
    registerTerminal("p1:a", fake.term);
    const note: CockpitMeta = { v: 1, revision: 2, progress: { steps: [{ id: "x", label: "Agent's own plan", state: "active" }], setAt: NOW - 60_000 } };
    const { container } = draw(rowOf("agy", "Google Antigravity", note));
    const own = container.querySelector(".cockpit-agent-progress")!;
    expect(own.textContent).toContain("Agent's own plan");
    expect(own.textContent).not.toContain("Read the config");
    expect(container.querySelector(".cockpit-screen-steps")?.textContent).toContain("Read the config");
    unregisterTerminal("p1:a", fake.term);
  });

  it("reads nothing for another CLI, a hidden pane or a machine that is down", () => {
    for (const [row, visible] of [
      [rowOf("claude", "Claude Code"), true],
      [rowOf("agy", "Google Antigravity"), false],
      [rowOf("agy", "Google Antigravity", undefined, true), true],
    ] as const) {
      const fake = fakeTerminal(WORKING);
      registerTerminal("p1:a", fake.term);
      const { container, unmount } = draw(row, visible);
      expect(container.querySelector(".cockpit-screen-steps")).toBeNull();
      expect(fake.listeners.size).toBe(0);
      unmount();
      unregisterTerminal("p1:a", fake.term);
    }
  });

  it("stops listening to the terminal when the pane goes away", () => {
    const fake = fakeTerminal(WORKING);
    registerTerminal("p1:a", fake.term);
    const { unmount } = draw(rowOf("agy", "Google Antigravity"));
    expect(fake.listeners.size).toBe(1);
    unmount();
    expect(fake.listeners.size).toBe(0);
    unregisterTerminal("p1:a", fake.term);
  });
});
