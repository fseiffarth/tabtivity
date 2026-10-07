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
  notePtyOutput,
  noteUserInput,
  startActivityTicks,
  useActivityStore,
} from "../../stores/activity";
import { useTabsStore } from "../../stores/tabs";

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
