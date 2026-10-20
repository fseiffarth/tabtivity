import { describe, expect, it } from "vitest";
import { DraftUndo, TYPING_GROUP_MS, caretAfterSwap } from "../../lib/agents/draftUndo";

describe("DraftUndo", () => {
  it("folds a run of typing into one step and splits it at a pause", () => {
    const undo = new DraftUndo();
    undo.record("", "h", true, 1000);
    undo.record("h", "hi", true, 1100);
    undo.record("hi", "hi there", true, 1100 + TYPING_GROUP_MS);
    expect(undo.undo("hi there")).toBe("hi");
    expect(undo.undo("hi")).toBe("");
    expect(undo.undo("")).toBeNull();
  });

  it("gives a set value its own step, and redo walks back", () => {
    const undo = new DraftUndo();
    undo.record("", "a", true, 1000);
    undo.record("a", "/compact ", false, 1050);
    expect(undo.undo("/compact ")).toBe("a");
    expect(undo.redo("a")).toBe("/compact ");
    expect(undo.redo("/compact ")).toBeNull();
  });

  it("drops redo once something new is typed, and clear empties both", () => {
    const undo = new DraftUndo();
    undo.record("", "ab", false);
    expect(undo.undo("ab")).toBe("");
    undo.record("", "c", true);
    expect(undo.redo("c")).toBeNull();
    undo.clear();
    expect(undo.canUndo()).toBe(false);
  });

  it("puts the caret after the changed part", () => {
    expect(caretAfterSwap("hello world", "hello")).toBe(5);
    expect(caretAfterSwap("ab", "aXb")).toBe(2);
    expect(caretAfterSwap("", "fix it")).toBe(6);
  });
});
