import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

import { hookLampHidesCard, lampHidesCardNow, withWaitingEntry, withoutCard } from "../../lib/agents/liveCardGate";
import type { TranscriptEntry } from "../../../mobile-web/src/api";
import { NO_LIVE, readReaderLive } from "../../lib/agents/readerLive";
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

describe("the hook lamp rules a card out", () => {
  it("only for a Claude tab whose hooks have spoken and who is not asking", () => {
    // No hook yet: a restored session, a first-run screen. The screen is all there is.
    expect(hookLampHidesCard(PTY, "Claude", false)).toBe(false);
    noteAgentTurn(PTY, "done");
    expect(hookLampHidesCard(PTY, "Claude", false)).toBe(true);
    noteAgentTurn(PTY, "working");
    expect(hookLampHidesCard(PTY, "Claude", false)).toBe(true);
    // Asking: the lamp announces it.
    expect(hookLampHidesCard(PTY, "Claude", true)).toBe(false);
    // Other CLIs keep the screen's reading.
    expect(hookLampHidesCard(PTY, "Codex", false)).toBe(false);
    expect(hookLampHidesCard(PTY, "OpenCode", false)).toBe(false);
  });

  it("reads the store's lamp for the steering digits", () => {
    expect(lampHidesCardNow(PTY, "Claude")).toBe(false);
    noteAgentTurn(PTY, "working");
    expect(lampHidesCardNow(PTY, "Claude")).toBe(true);
    useActivityStore.setState({ attentionByTab: { [PTY]: "decision" } });
    expect(lampHidesCardNow(PTY, "Claude")).toBe(false);
  });
});

describe("a card taken off the live reading", () => {
  const dialog = readReaderLive(plainBuffer([
    "❯ remove the old file", "", "Do you want to proceed?", "❯ 1. Yes", "  2. No", "", "  Esc to cancel",
  ]), "Claude", 76);

  it("leaves no card and no way to answer, and points at the terminal instead", () => {
    expect(dialog.question).not.toBeNull();
    const hidden = withoutCard(dialog);
    expect(hidden.question).toBeNull();
    expect(hidden.signature).toBe("");
    expect(hidden.ask).toEqual([]);
    expect(hidden.stray).toBe(true);
    expect(hidden.screen).toEqual(expect.arrayContaining(["Yes", "No"]));
  });

  it("is the reading itself when there was no dialog", () => {
    expect(withoutCard(NO_LIVE)).toBe(NO_LIVE);
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
    const hidden = withoutCard(screen);
    expect(withWaitingEntry(hidden, entry, false)).toBe(hidden);
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
