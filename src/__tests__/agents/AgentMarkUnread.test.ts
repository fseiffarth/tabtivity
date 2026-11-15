/**
 * "Mark as unread" on an agent tab (`markTabUnread`): it reads as a finished
 * turn until the tab is next opened or typed into, stays dark while it is the
 * visible tab, and the cross-project roster honours it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _clearPtyActivityForTest,
  markTabUnread,
  noteUserInput,
  tabMarkedUnreadAt,
  useActivityStore,
} from "../../stores/activity";
import { deriveAgentRosterState } from "../../lib/agents/agentRoster";
import { useTabsStore } from "../../stores/tabs";

const SHOWN = "proj-a:agent-1";
const HIDDEN = "proj-a:agent-2";

function seedTabs(activeKey: string) {
  useTabsStore.setState({
    tabsByScope: {
      "proj-a": [
        { key: "agent-1", label: "Claude", cmd: "claude", cwd: "/proj", kind: "agent" },
        { key: "agent-2", label: "Codex", cmd: "codex", cwd: "/proj", kind: "agent" },
        { key: "shell-1", label: "bash", cmd: "bash", cwd: "/proj", kind: "shell" },
      ],
    },
    scope: "proj-a",
    layoutByScope: {
      "proj-a": { type: "group", id: "g-a", tabKeys: ["agent-1", "agent-2", "shell-1"], activeKey },
    },
    detachedGroupsByScope: {},
  });
}

const attention = (id: string) => useActivityStore.getState().attentionByTab[id];

describe("activity store — mark as unread", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _clearPtyActivityForTest();
    seedTabs("agent-1");
    useActivityStore.getState().recompute();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lights a hidden agent tab as done until it is opened again", () => {
    expect(attention(HIDDEN)).toBeUndefined();
    vi.advanceTimersByTime(10);
    markTabUnread(HIDDEN);
    expect(attention(HIDDEN)).toBe("done");
    expect(tabMarkedUnreadAt(HIDDEN)).toBeDefined();

    vi.advanceTimersByTime(10);
    useActivityStore.getState().clearAttention(HIDDEN);
    seedTabs("agent-2");
    useActivityStore.getState().recompute();
    expect(attention(HIDDEN)).toBeUndefined();
    expect(tabMarkedUnreadAt(HIDDEN)).toBeUndefined();

    // Looking away again does not bring the mark back.
    seedTabs("agent-1");
    useActivityStore.getState().recompute();
    expect(attention(HIDDEN)).toBeUndefined();
  });

  it("stays dark on the visible tab and lights once the user looks away", () => {
    useActivityStore.getState().clearAttention(SHOWN);
    vi.advanceTimersByTime(10);
    markTabUnread(SHOWN);
    expect(attention(SHOWN)).toBeUndefined();

    seedTabs("agent-2");
    useActivityStore.getState().recompute();
    expect(attention(SHOWN)).toBe("done");
  });

  it("is retired by typing into the tab", () => {
    vi.advanceTimersByTime(10);
    markTabUnread(HIDDEN);
    expect(attention(HIDDEN)).toBe("done");
    noteUserInput(HIDDEN);
    useActivityStore.getState().recompute();
    expect(attention(HIDDEN)).toBeUndefined();
    expect(tabMarkedUnreadAt(HIDDEN)).toBeUndefined();
  });

  it("never lights a shell tab", () => {
    markTabUnread("proj-a:shell-1");
    expect(attention("proj-a:shell-1")).toBeUndefined();
  });
});

describe("agent roster — mark as unread", () => {
  it("reads a marked idle tab as done, and a working one as working", () => {
    const base = { busy: false, attention: undefined, lastDoneAt: undefined, lastReadAt: 100 };
    expect(deriveAgentRosterState(base)).toBe("idle");
    expect(deriveAgentRosterState({ ...base, markedUnreadAt: 200 })).toBe("done");
    expect(deriveAgentRosterState({ ...base, busy: true, markedUnreadAt: 200 })).toBe("working");
  });
});
