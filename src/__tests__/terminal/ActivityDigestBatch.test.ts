/**
 * `terminal-activity-batch` (performance plan §7.6): every hidden PTY's
 * digest due in a tick arrives in ONE event. Feeding the batch must leave the
 * activity store exactly as the former one-event-per-PTY stream did.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { noteActivityDigests, type ActivityDigest } from "../../lib/terminal/activityDigests";
import {
  _clearPtyActivityForTest,
  lastPtyOutputAt,
  notePtyOutput,
  noteUserInput,
  startActivityTicks,
  useActivityStore,
} from "../../stores/activity";
import { useTabsStore } from "../../stores/tabs";

const PTYS = ["proj-a:agent-1", "proj-a:agent-2", "proj-b:agent-3"];

function seedAgentTabs() {
  useTabsStore.setState({
    tabsByScope: {
      "proj-a": [
        { key: "agent-1", label: "Claude", cmd: "claude", cwd: "/a", kind: "agent" },
        { key: "agent-2", label: "Codex", cmd: "codex", cwd: "/a", kind: "agent" },
      ],
      "proj-b": [{ key: "agent-3", label: "Gemini", cmd: "gemini", cwd: "/b", kind: "agent" }],
    },
    scope: "proj-a",
    layoutByScope: {
      "proj-a": { type: "group", id: "g-a", tabKeys: ["agent-1", "agent-2"], activeKey: "agent-1" },
      "proj-b": { type: "group", id: "g-b", tabKeys: ["agent-3"], activeKey: "agent-3" },
    },
    detachedGroupsByScope: {},
  });
}

/** What the digests leave behind: the raw per-PTY output stamps and the
 *  lamps the next recompute derives from them. */
function snapshot() {
  const s = useActivityStore.getState();
  return {
    lastOutput: PTYS.map((id) => lastPtyOutputAt(id)),
    busy: PTYS.map((id) => s.busyByTab[id] ?? false),
    attention: PTYS.map((id) => s.attentionByTab[id] ?? null),
  };
}

/** One 500 ms-cadence run of digests for three hidden agent tabs — two
 *  working, one landing on a decision prompt and going quiet. */
function tick(): ActivityDigest[][] {
  const busy = (id: string) => ({ id, data: "⠋ Thinking…\n" });
  return [
    [busy(PTYS[0]), busy(PTYS[1]), { id: PTYS[2], data: "Reading files…\n" }],
    [busy(PTYS[0]), busy(PTYS[1]), { id: PTYS[2], data: "Do you want to proceed?\n❯ 1. Yes\n  2. No\n" }],
    [busy(PTYS[0]), busy(PTYS[1])],
    [busy(PTYS[0]), busy(PTYS[1])],
    [busy(PTYS[0]), busy(PTYS[1])],
  ];
}

describe("terminal-activity-batch feed", () => {
  let stop: (() => void) | undefined;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T10:00:00Z"));
    _clearPtyActivityForTest();
    seedAgentTabs();
    stop = startActivityTicks();
  });
  afterEach(() => {
    stop?.();
    _clearPtyActivityForTest();
    vi.useRealTimers();
  });

  function run(feed: (digests: ActivityDigest[]) => void) {
    for (const id of PTYS) noteUserInput(id);
    vi.advanceTimersByTime(200);
    const ticks = tick();
    ticks.forEach((digests, i) => {
      feed(digests);
      // Past the recompute trail after the last tick, still inside the busy window.
      vi.advanceTimersByTime(i === ticks.length - 1 ? 350 : 500);
    });
    return snapshot();
  }

  it("leaves the store as one event per digest did", () => {
    const single = run((digests) => {
      for (const d of digests) notePtyOutput(d.id, d.data);
    });
    stop?.();
    _clearPtyActivityForTest();
    seedAgentTabs();
    vi.setSystemTime(new Date("2026-10-07T10:00:00Z"));
    stop = startActivityTicks();
    const batched = run((digests) => noteActivityDigests(digests));
    expect(batched).toEqual(single);
    // The feed reached every PTY, and the two still streaming read busy.
    for (const at of batched.lastOutput) expect(at).toBeDefined();
    expect(batched.busy.slice(0, 2)).toEqual([true, true]);
  });

  it("notes a PTY's digests in batch order", () => {
    noteActivityDigests([
      { id: PTYS[2], data: "first\n" },
      { id: PTYS[2], data: "Do you want to proceed?\n❯ 1. Yes\n  2. No\n" },
    ]);
    vi.advanceTimersByTime(3_000);
    // Only the last digest's tail is the prompt: noted in order, it is what
    // the decision lamp reads.
    expect(useActivityStore.getState().attentionByTab[PTYS[2]]).toBe("decision");
  });

  it("an empty batch notes nothing", () => {
    noteActivityDigests([]);
    for (const id of PTYS) expect(lastPtyOutputAt(id)).toBeUndefined();
  });
});
