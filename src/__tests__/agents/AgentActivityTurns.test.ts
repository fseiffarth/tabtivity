/**
 * The two readings the Agents views sort by: when a tab was last seen working
 * (published on the busy→idle edge — while it is busy, `busyByTab` already
 * says "now") and when it last finished a turn (its last output before the
 * done-quiet silence, marked whether or not the tab is being looked at).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _clearPtyActivityForTest, agentTurnStartedAt, notePtyOutput, notePtyResize, noteUserInput, useActivityStore } from "../../stores/activity";
import { useTabsStore } from "../../stores/tabs";

const PTY = "proj-a:agent-1";

function seedAgentTab() {
  useTabsStore.setState({
    tabsByScope: { "proj-a": [{ key: "agent-1", label: "Claude", cmd: "claude", cwd: "/proj", kind: "agent" }] },
    scope: "proj-a",
    layoutByScope: { "proj-a": { type: "group", id: "g-a", tabKeys: ["agent-1"], activeKey: "agent-1" } },
    detachedGroupsByScope: {},
  });
}

function sustain(id: string, totalMs = 1600) {
  noteUserInput(id);
  vi.advanceTimersByTime(200); // past ECHO_MS: the agent's frames, not the keystroke's echo
  notePtyOutput(id, "thinking…\n");
  for (let elapsed = 0; elapsed < totalMs; elapsed += 400) {
    vi.advanceTimersByTime(400);
    notePtyOutput(id, "thinking…\n");
  }
}

describe("activity store — last working and last done", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _clearPtyActivityForTest();
    seedAgentTab();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stamps last working when the burst ends and last done once the silence is long enough", () => {
    sustain(PTY);
    const lastOutput = Date.now();
    useActivityStore.getState().recompute();
    // Busy right now: nothing published yet, `busyByTab` speaks for it.
    expect(useActivityStore.getState().busyByTab[PTY]).toBe(true);
    expect(useActivityStore.getState().lastWorkingByTab[PTY]).toBeUndefined();
    expect(useActivityStore.getState().lastDoneByTab[PTY]).toBeUndefined();

    // Past the busy window, short of the done quiet: worked, not yet finished.
    vi.advanceTimersByTime(1000);
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().lastWorkingByTab[PTY]).toBe(lastOutput);
    expect(useActivityStore.getState().lastDoneByTab[PTY]).toBeUndefined();

    // Past the done quiet (2500 ms): the turn finished at its last output.
    vi.advanceTimersByTime(2000);
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().lastDoneByTab[PTY]).toBe(lastOutput);

    // More silence marks nothing new — a turn finishes once.
    const done = useActivityStore.getState().lastDoneByTab;
    vi.advanceTimersByTime(5000);
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().lastDoneByTab).toBe(done);
  });

  it("marks the finished turn even while the tab is the one on screen", () => {
    // The `done` attention flag never rises on a watched tab (its screen says
    // it); the finished-turn reading must, or a watched agent could never be
    // sorted by it.
    sustain(PTY);
    const lastOutput = Date.now();
    vi.advanceTimersByTime(3000);
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().attentionByTab[PTY]).toBeUndefined();
    expect(useActivityStore.getState().lastDoneByTab[PTY]).toBe(lastOutput);
  });

  it("never books a finished turn for a blip that was not work, and forgets a closed tab", () => {
    noteUserInput(PTY);
    notePtyOutput(PTY, "$ \n");
    vi.advanceTimersByTime(3000);
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().lastDoneByTab[PTY]).toBeUndefined();

    sustain(PTY);
    vi.advanceTimersByTime(3000);
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().lastDoneByTab[PTY]).toBeDefined();
    useTabsStore.setState({ tabsByScope: {}, layoutByScope: {} });
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().lastDoneByTab[PTY]).toBeUndefined();
    expect(useActivityStore.getState().lastWorkingByTab[PTY]).toBeUndefined();
  });
});

describe("activity store — the repaint of an opened or resized tab", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _clearPtyActivityForTest();
    seedAgentTab();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A full-screen TUI (OpenCode) settling after its pane changed size: text
   *  for two seconds, past the work onset. */
  function repaint(id: string) {
    for (let elapsed = 0; elapsed <= 2000; elapsed += 200) {
      notePtyOutput(id, "│ Write it to docs first │\n");
      vi.advanceTimersByTime(200);
    }
  }

  it("books no turn for the repaint of a tab put on a screen", () => {
    sustain(PTY); // yesterday's turn
    vi.advanceTimersByTime(3000);
    useActivityStore.getState().recompute();
    const done = useActivityStore.getState().lastDoneByTab[PTY];
    const started = agentTurnStartedAt(PTY);
    vi.advanceTimersByTime(600_000);

    useActivityStore.getState().clearAttention(PTY); // opened on the phone
    repaint(PTY);
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().busyByTab[PTY]).toBeUndefined();
    vi.advanceTimersByTime(3000);
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().lastDoneByTab[PTY]).toBe(done);
    expect(agentTurnStartedAt(PTY)).toBe(started);
  });

  it("books no turn for the repaint after a pane resize", () => {
    sustain(PTY);
    vi.advanceTimersByTime(3000);
    useActivityStore.getState().recompute();
    const done = useActivityStore.getState().lastDoneByTab[PTY];
    vi.advanceTimersByTime(600_000);

    notePtyResize(PTY);
    repaint(PTY);
    vi.advanceTimersByTime(3000);
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().lastDoneByTab[PTY]).toBe(done);
  });

  it("keeps counting a turn already running when the tab is opened", () => {
    sustain(PTY);
    useActivityStore.getState().clearAttention(PTY);
    repaint(PTY);
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().busyByTab[PTY]).toBe(true);
  });

  it("counts the answer to a prompt typed right after opening the tab", () => {
    useActivityStore.getState().clearAttention(PTY);
    sustain(PTY);
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().busyByTab[PTY]).toBe(true);
  });
});
