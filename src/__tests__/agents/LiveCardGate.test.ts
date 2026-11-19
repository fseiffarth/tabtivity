import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

import { withWaitingEntry } from "../../lib/agents/liveCardGate";
import type { TranscriptEntry } from "../../../mobile-web/src/api";
import { NO_LIVE, answerKeys, readReaderLive } from "../../lib/agents/readerLive";
import { _clearPtyActivityForTest, noteAgentTurn, useActivityStore } from "../../stores/activity";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import type { ReadableBufferLike } from "../../../mobile-web/src/terminal/readableScreen";

const PTY = "p:tab-1";
const agent: TabEntry = { key: "tab-1", label: "Claude", cmd: "claude", cwd: "/project", kind: "agent" };

function plainBuffer(rows: string[]): ReadableBufferLike {
  return { length: rows.length, getLine: (row) => (rows[row] === undefined ? undefined : { translateToString: () => rows[row] }) };
}

beforeEach(() => {
  _clearPtyActivityForTest();
  useActivityStore.setState({ attentionByTab: {}, busyByTab: {} });
  // `recompute` drops the state of a pty that has no tab.
  useTabsStore.setState({
    scope: "p", tabsByScope: { p: [agent] }, layoutByScope: { p: null }, focusedGroupByScope: { p: null },
    detachedGroupsByScope: {}, hiddenGroupsByScope: {}, pendingRespawnByScope: {},
  });
});
afterEach(() => _clearPtyActivityForTest());

describe("the hook lamp does not rule a screen-read card out", () => {
  // A picker the user opened with a slash command, on a tab whose hooks have
  // spoken and whose lamp is not asking: it fires no hook, and is a real dialog.
  const picker = [
    "❯ earlier prompt", "", "Resume Session", "❯ 1. fix the parser", "  2. rename the store", "  3. write the docs", "", "  Enter to select · Esc to cancel",
  ];

  it("reads and answers a /resume-style picker on a hook-driven tab with the lamp not asking", () => {
    noteAgentTurn(PTY, "done");
    const live = readReaderLive(plainBuffer(picker), "Claude", 76);
    expect(live.question?.options.map((option) => option.label)).toEqual(["fix the parser", "rename the store", "write the docs"]);
    const pick = live.question!.options[2];
    expect(answerKeys(live.question!, pick)).toEqual(["\u001b[B", "\u001b[B", "\r"]);
    // Nothing in the gate drops it: no entry, no change.
    expect(withWaitingEntry(live, null, false)).toBe(live);
  });

  it("keeps page 2 of a several-question dialog after the lamp dropped (a phone answer retires the verdict)", () => {
    noteAgentTurn(PTY, "working");
    useActivityStore.setState({ attentionByTab: {} });
    const page2 = readReaderLive(plainBuffer([
      "❯ ask me", "", "←  ☒ Colours  ☐ Layout  ✔ Submit  →", "Which layout should the probe draw?",
      "❯ 1. Grid", "  2. List", "  3. Type something", "     Next", "", "  4. Chat about this", "", "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
    ]), "Claude", 76);
    expect(page2.question?.options.map((option) => option.label).slice(0, 2)).toEqual(["Grid", "List"]);
    expect(page2.tabs.map((tab) => tab.label)).toEqual(["Colours", "Layout"]);
    expect(withWaitingEntry(page2, null, false)).toBe(page2);
  });
});

describe("the transcript's waiting question laid over the live reading", () => {
  const entry: TranscriptEntry = {
    kind: "answer", text: "Which colours?", at: "2026-11-18T09:19:13.591Z", blocking: true,
    questions: [{ header: "Colours", question: "Which colours?", multiSelect: true, options: [{ label: "Red", description: "warm" }, { label: "Blue" }] }],
  };
  const screen = readReaderLive(plainBuffer([
    "❯ ask me", "", "←  ☐ Colours  →", "", "Which colours?", "", "❯ 1. [ ] Red", "  2. [ ] Blue", "  3. [ ] Type something", "     Submit", "",
    "  4. Chat about this", "", "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
  ]), "Claude", 76);

  it("puts the entry's words on the screen's rows and keeps the screen's signature and cursor", () => {
    expect(screen.question).not.toBeNull();
    const merged = withWaitingEntry(screen, entry, true);
    expect(merged.question?.options.slice(0, 2).map((option) => [option.label, option.description, option.ticked])).toEqual([["Red", "warm", false], ["Blue", undefined, false]]);
    expect(merged.question?.multiSelect).toBe(true);
    expect(merged.question?.current).toBe(screen.question?.current);
    expect(merged.signature).toBe(screen.signature);
    expect(merged.tabs).toEqual(screen.tabs);
    // Merged also with the lamp not asking: the screen's card was kept (a tab with no hook verdict).
    expect(withWaitingEntry(screen, entry, false).question?.source).toBe("entry");
  });

  it("is the screen's reading when it is another dialog or nothing waits", () => {
    const permission = readReaderLive(plainBuffer(["❯ remove it", "", "Do you want to proceed?", "❯ 1. Yes", "  2. No", "", "  Esc to cancel"]), "Claude", 76);
    expect(withWaitingEntry(permission, entry, true)).toBe(permission);
    expect(withWaitingEntry(screen, null, true)).toBe(screen);
    expect(withWaitingEntry(screen, { ...entry, blocking: undefined }, true)).toBe(screen);
  });

  it("is a read-only card of the entry while the screen shows no dialog, only under an asking lamp", () => {
    expect(withWaitingEntry(NO_LIVE, entry, false)).toBe(NO_LIVE);
    const card = withWaitingEntry(NO_LIVE, entry, true);
    expect(card.question?.readOnly).toBe(true);
    expect(card.question?.options.map((option) => option.label)).toEqual(["Red", "Blue"]);
    expect(card.ask).toEqual(["Which colours?"]);
    expect(card.tabs).toEqual([{ label: "Colours", answered: false }]);
    expect(card.signature).toBe("entry:2026-11-18T09:19:13.591Z");
    expect(card.stray).toBe(false);
    expect(card.working).toBeNull();
  });
});
