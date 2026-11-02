import { describe, expect, it } from "vitest";
import { sentTurnOver, turnEndKey, turnWorking, type TurnReading } from "../../lib/voice/agentTurn";

const hook = (state: "working" | "decision" | "done" | "idle", at: number, startedAt?: number): TurnReading =>
  ({ hook: { state, at, startedAt }, busy: false });

describe("when an agent's turn ends, for read-aloud and hands-free", () => {
  it("takes the hook's verdict over the busy lamp", () => {
    expect(turnWorking({ hook: { state: "working", at: 1 }, busy: false })).toBe(true);
    expect(turnWorking({ hook: { state: "done", at: 1 }, busy: true })).toBe(false);
    expect(turnWorking({ hook: undefined, busy: true })).toBe(true);
  });

  it("keys each ended turn", () => {
    expect(turnEndKey(hook("working", 5), null)).toBeNull();
    expect(turnEndKey(hook("done", 5), null)).toBe("done@5");
    expect(turnEndKey(hook("decision", 6), null)).toBe("decision@6");
    // Without hooks: the lamp went out after it was lit.
    expect(turnEndKey({ hook: undefined, busy: false }, null)).toBeNull();
    expect(turnEndKey({ hook: undefined, busy: true }, 7)).toBeNull();
    expect(turnEndKey({ hook: undefined, busy: false }, 7)).toBe("idle@7");
  });

  it("waits for the turn a hands-free send started, not the one it was queued behind", () => {
    const sent = 100;
    // The turn running at the send ends: its `done` is older than the send.
    expect(sentTurnOver(hook("done", 90, 50), sent, null, false)).toBe(false);
    // …or newer, but of a turn begun before the send, with no new answer.
    expect(sentTurnOver(hook("done", 110, 50), sent, null, false)).toBe(false);
    // The prompt's own turn ends.
    expect(sentTurnOver(hook("done", 130, 105), sent, null, false)).toBe(true);
    // A queued prompt taken in mid-turn: the new answer says it was answered.
    expect(sentTurnOver(hook("done", 130, 50), sent, null, true)).toBe(true);
    // A permission prompt waits on the user.
    expect(sentTurnOver(hook("decision", 120), sent, null, false)).toBe(true);
    expect(sentTurnOver(hook("working", 120, 105), sent, null, true)).toBe(false);
  });

  it("falls back to the busy lamp without hooks", () => {
    const sent = 100;
    expect(sentTurnOver({ hook: undefined, busy: false }, sent, null, false)).toBe(false);
    expect(sentTurnOver({ hook: undefined, busy: true }, sent, 120, false)).toBe(false);
    expect(sentTurnOver({ hook: undefined, busy: false }, sent, 90, false)).toBe(false);
    expect(sentTurnOver({ hook: undefined, busy: false }, sent, 120, false)).toBe(true);
  });
});
