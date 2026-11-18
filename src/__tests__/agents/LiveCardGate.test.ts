import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

import { hookLampHidesCard, lampHidesCardNow, withoutCard } from "../../lib/agents/liveCardGate";
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
