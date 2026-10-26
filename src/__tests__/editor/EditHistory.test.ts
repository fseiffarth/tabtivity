/**
 * Tests for the editor undo/redo history (#46): the pure reducer that backs the
 * in-app text/TeX/markdown editors.
 */
import { describe, it, expect } from "vitest";
import { editHistoryReducer, type EditHistory } from "../../components/embed/FileViewerPane";

const seed = (present: string): EditHistory => ({ past: [], present, future: [] });

describe("editHistoryReducer", () => {
  it("pushes the prior value onto the past on a non-coalesced set", () => {
    let s = seed("a");
    s = editHistoryReducer(s, { type: "set", value: "ab" });
    expect(s.present).toBe("ab");
    expect(s.past).toEqual(["a"]);
    expect(s.future).toEqual([]);
  });

  it("coalesces rapid keystrokes into one undo step", () => {
    // The first keystroke of a burst is NOT coalesced (it commits "a" to history,
    // mirroring the timing in the React wrapper); the rest of the burst coalesces
    // in place, so a single undo jumps back over the whole burst to "a".
    let s = seed("a");
    s = editHistoryReducer(s, { type: "set", value: "ab" });
    s = editHistoryReducer(s, { type: "set", value: "abc", coalesce: true });
    s = editHistoryReducer(s, { type: "set", value: "abcd", coalesce: true });
    expect(s.present).toBe("abcd");
    expect(s.past).toEqual(["a"]);
    s = editHistoryReducer(s, { type: "undo" });
    expect(s.present).toBe("a");
  });

  it("undo restores the previous value and pushes onto future", () => {
    let s = seed("a");
    s = editHistoryReducer(s, { type: "set", value: "b" });
    s = editHistoryReducer(s, { type: "undo" });
    expect(s.present).toBe("a");
    expect(s.future).toEqual(["b"]);
  });

  it("redo re-applies an undone value", () => {
    let s = seed("a");
    s = editHistoryReducer(s, { type: "set", value: "b" });
    s = editHistoryReducer(s, { type: "undo" });
    s = editHistoryReducer(s, { type: "redo" });
    expect(s.present).toBe("b");
    expect(s.future).toEqual([]);
  });

  it("a new edit after undo clears the redo stack", () => {
    let s = seed("a");
    s = editHistoryReducer(s, { type: "set", value: "b" });
    s = editHistoryReducer(s, { type: "undo" }); // present "a", future ["b"]
    s = editHistoryReducer(s, { type: "set", value: "c" });
    expect(s.present).toBe("c");
    expect(s.future).toEqual([]);
  });

  it("undo/redo at the ends are no-ops", () => {
    const s = seed("a");
    expect(editHistoryReducer(s, { type: "undo" })).toBe(s);
    expect(editHistoryReducer(s, { type: "redo" })).toBe(s);
  });

  it("reset seeds a fresh baseline with empty stacks", () => {
    let s = seed("a");
    s = editHistoryReducer(s, { type: "set", value: "b" });
    s = editHistoryReducer(s, { type: "reset", value: "fresh" });
    expect(s).toEqual({ past: [], present: "fresh", future: [] });
  });

  it("setting the same value is a no-op (no spurious history entry)", () => {
    const s = seed("a");
    expect(editHistoryReducer(s, { type: "set", value: "a" })).toBe(s);
  });
});
