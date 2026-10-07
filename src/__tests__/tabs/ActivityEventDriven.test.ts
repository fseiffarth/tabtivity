/**
 * The activity store recomputes on demand, not on a clock (performance plan
 * §3.2): a chunk asks for one trailing recompute, and each recompute arms one
 * timer for the earliest window still to run out — so the "working" ring goes
 * out when output simply stops, with nobody calling `recompute` and no
 * interval ticking over every tab.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _clearPtyActivityForTest,
  noteAgentTurn,
  notePtyOutput,
  noteUserInput,
  startActivityTicks,
  useActivityStore,
} from "../../stores/activity";
import { useTabsStore } from "../../stores/tabs";
import { _pendingUsageForTest, _resetUsageForTest } from "../../stores/usage";
import { METRIC } from "../../lib/usageMetrics";

const AGENT = "proj-a:agent-1";
const SHELL = "proj-a:shell-1";

function seedTabs() {
  useTabsStore.setState({
    tabsByScope: {
      "proj-a": [
        { key: "agent-1", label: "a", cmd: "claude", cwd: "/a", kind: "agent" },
        { key: "shell-1", label: "s", cmd: "", cwd: "/a", kind: "shell" },
      ],
    },
    scope: "proj-b",
    layoutByScope: {
      "proj-a": { type: "group", id: "g-a", tabKeys: ["agent-1", "shell-1"], activeKey: "agent-1" },
    },
    detachedGroupsByScope: {},
  });
}

/** Commanded, sustained output past the onset debounce — never calling
 *  `recompute` by hand: the store's own scheduling has to do it. */
function stream(id: string, totalMs = 1600) {
  noteUserInput(id);
  vi.advanceTimersByTime(200);
  notePtyOutput(id, "working…\n");
  for (let elapsed = 0; elapsed < totalMs; elapsed += 400) {
    vi.advanceTimersByTime(400);
    notePtyOutput(id, "working…\n");
  }
}

describe("activity store — event-driven recompute", () => {
  let stop: () => void = () => {};
  beforeEach(() => {
    vi.useFakeTimers();
    seedTabs();
    _clearPtyActivityForTest();
    // What AppShell does once per window; a store that was never armed
    // (a popout, every other test) recomputes only when asked by hand.
    stop = startActivityTicks();
  });
  afterEach(() => {
    stop();
    _clearPtyActivityForTest();
    vi.useRealTimers();
  });

  it("never schedules anything before AppShell arms it", () => {
    stop();
    stream(AGENT);
    expect(vi.getTimerCount()).toBe(0);
    expect(useActivityStore.getState().busyByTab[AGENT]).toBeUndefined();
  });

  it("lights a streaming agent tab from its own trailing recompute", () => {
    stream(AGENT);
    vi.advanceTimersByTime(300);
    expect(useActivityStore.getState().busyByTab[AGENT]).toBe(true);
    expect(useActivityStore.getState().busyByScope["proj-a"]).toBe(true);
  });

  it("puts the ring out when output stops, off the window-expiry timer", () => {
    stream(AGENT);
    vi.advanceTimersByTime(300);
    expect(useActivityStore.getState().busyByTab[AGENT]).toBe(true);
    // Nothing else is noted: only the armed expiry can clear it.
    vi.advanceTimersByTime(900);
    expect(useActivityStore.getState().busyByTab[AGENT]).toBeUndefined();
    expect(useActivityStore.getState().busyByScope["proj-a"]).toBeUndefined();
    // …and the silence after it still books the finished turn.
    vi.advanceTimersByTime(3000);
    expect(useActivityStore.getState().attentionByTab[AGENT]).toBe("done");
  });

  it("classifies a shell tab off the lean path (no tail) the same way", () => {
    stream(SHELL);
    vi.advanceTimersByTime(300);
    expect(useActivityStore.getState().busyByTab[SHELL]).toBe(true);
    expect(useActivityStore.getState().busyKindByTab[SHELL]).toBe("shell");
    vi.advanceTimersByTime(900);
    expect(useActivityStore.getState().busyByTab[SHELL]).toBeUndefined();
    // A shell never raises attention, tail or no tail.
    vi.advanceTimersByTime(3000);
    expect(useActivityStore.getState().attentionByTab[SHELL]).toBeUndefined();
  });

  it("drops a closed tab without anybody calling recompute", () => {
    stream(AGENT);
    vi.advanceTimersByTime(300);
    expect(useActivityStore.getState().busyByTab[AGENT]).toBe(true);
    useTabsStore.setState({ tabsByScope: { "proj-a": [] } });
    vi.advanceTimersByTime(300);
    expect(useActivityStore.getState().busyByTab[AGENT]).toBeUndefined();
  });

  it("goes quiet once every window has run out", () => {
    stream(AGENT);
    vi.advanceTimersByTime(10_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});

/**
 * Every transition the old 300 ms clock caught by accident has to be caught by
 * an event or the one-shot expiry timer now — each one below is driven with
 * nothing but the store's own scheduling (S4 review).
 */
describe("activity store — every clocked transition is still caught", () => {
  let stop: () => void = () => {};
  beforeEach(() => {
    vi.useFakeTimers();
    seedTabs();
    _clearPtyActivityForTest();
    _resetUsageForTest();
    stop = startActivityTicks();
  });
  afterEach(() => {
    stop();
    _clearPtyActivityForTest();
    _resetUsageForTest();
    vi.useRealTimers();
  });

  it("reads a decision prompt off a quiet tail once the decision window runs out", () => {
    stream(AGENT);
    notePtyOutput(AGENT, "Do you want to make this edit?\n\x1b[32m❯ 1. Yes\x1b[0m\n  2. No, tell Claude what to do\n");
    // The trail recompute still sees a busy, undecided tab (quiet < 600 ms).
    vi.advanceTimersByTime(300);
    expect(useActivityStore.getState().busyByTab[AGENT]).toBe(true);
    expect(useActivityStore.getState().attentionByTab[AGENT]).toBeUndefined();
    // Nothing else arrives: the expiry timer lights the lamp.
    vi.advanceTimersByTime(700);
    expect(useActivityStore.getState().attentionByTab[AGENT]).toBe("decision");
  });

  it("retires a hook's working verdict after its silence window with no event", () => {
    noteAgentTurn(AGENT, "working");
    expect(useActivityStore.getState().busyByTab[AGENT]).toBe(true);
    vi.advanceTimersByTime(19_000);
    expect(useActivityStore.getState().busyByTab[AGENT]).toBe(true);
    vi.advanceTimersByTime(1_500);
    expect(useActivityStore.getState().busyByTab[AGENT]).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bills a silent busy tab under the recap's clamp while it stays busy", () => {
    noteAgentTurn(AGENT, "working");
    // 20 s of hook silence with no output: ten 2 s ticks, each inside the
    // 5 s clamp, add up to the whole stretch instead of nothing.
    vi.advanceTimersByTime(19_000);
    const worked = _pendingUsageForTest()["proj-a"]?.[METRIC.AGENT_WORKED_S] ?? 0;
    expect(worked).toBeGreaterThanOrEqual(18);
    expect(worked).toBeLessThanOrEqual(19.5);
  });

  it("raises done on a tab the user switched away from mid-turn", () => {
    useTabsStore.setState({ scope: "proj-a" });
    stream(AGENT);
    vi.advanceTimersByTime(300);
    expect(useActivityStore.getState().busyByTab[AGENT]).toBe(true);
    useTabsStore.setState({ scope: "proj-b" });
    stream(AGENT, 800);
    // Output stops; only the expiry timers run from here.
    vi.advanceTimersByTime(4_000);
    expect(useActivityStore.getState().busyByTab[AGENT]).toBeUndefined();
    expect(useActivityStore.getState().attentionByTab[AGENT]).toBe("done");
  });

  it("never raises done on a turn that finished while the tab was on screen", () => {
    useTabsStore.setState({ scope: "proj-a" });
    stream(AGENT);
    vi.advanceTimersByTime(4_000);
    expect(useActivityStore.getState().attentionByTab[AGENT]).toBeUndefined();
    useTabsStore.setState({ scope: "proj-b" });
    vi.advanceTimersByTime(4_000);
    expect(useActivityStore.getState().attentionByTab[AGENT]).toBeUndefined();
  });

  it("marks the finished turn on the output's own silence when a bell came later", () => {
    stream(AGENT);
    vi.advanceTimersByTime(1_300);
    expect(useActivityStore.getState().busyByTab[AGENT]).toBeUndefined();
    // A lone bell a second after the last text: the lamp lights at once, and
    // the turn-end mark still lands 2.5 s after the TEXT, not after the bell.
    useActivityStore.getState().noteBell(AGENT);
    expect(useActivityStore.getState().attentionByTab[AGENT]).toBe("done");
    expect(useActivityStore.getState().lastDoneByTab[AGENT]).toBeUndefined();
    vi.advanceTimersByTime(1_300);
    expect(useActivityStore.getState().lastDoneByTab[AGENT]).toBeDefined();
  });

  it("lets a bell shortcut the done silence", () => {
    stream(AGENT);
    vi.advanceTimersByTime(300);
    useActivityStore.getState().noteBell(AGENT);
    expect(useActivityStore.getState().attentionByTab[AGENT]).toBe("done");
  });

  it("keeps the pending windows across a quiesce re-arm, and clears them on stop", () => {
    stream(AGENT);
    vi.advanceTimersByTime(300);
    expect(useActivityStore.getState().busyByTab[AGENT]).toBe(true);
    // AppShell re-arms with the longer trail when the window blurs.
    stop();
    expect(vi.getTimerCount()).toBe(0);
    stop = startActivityTicks(900);
    vi.advanceTimersByTime(1_000);
    expect(useActivityStore.getState().busyByTab[AGENT]).toBeUndefined();
    vi.advanceTimersByTime(3_000);
    expect(useActivityStore.getState().attentionByTab[AGENT]).toBe("done");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("holds at most one trail and one expiry timer however many chunks arrive", () => {
    noteUserInput(AGENT);
    vi.advanceTimersByTime(200);
    for (let i = 0; i < 40; i += 1) {
      notePtyOutput(AGENT, "working…\n");
      vi.advanceTimersByTime(50);
      expect(vi.getTimerCount()).toBeLessThanOrEqual(2);
    }
  });

  it("recomputes when a popout group opens or closes", () => {
    stream(AGENT);
    vi.advanceTimersByTime(4_000);
    expect(useActivityStore.getState().attentionByTab[AGENT]).toBe("done");
    // The tab pops out: on its own screen now, so it is looked at.
    useTabsStore.setState({
      layoutByScope: { "proj-a": { type: "group", id: "g-a", tabKeys: ["shell-1"], activeKey: "shell-1" } },
      detachedGroupsByScope: {
        "proj-a": [{ id: "d-1", label: "w", subtree: { type: "group", id: "g-d", tabKeys: ["agent-1"], activeKey: "agent-1" } }],
      },
    });
    vi.advanceTimersByTime(300);
    expect(useActivityStore.getState().attentionByTab[AGENT]).toBeUndefined();
  });
});
