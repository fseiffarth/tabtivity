import { describe, expect, it } from "vitest";
import { ProvisionalDraft, shiftOffset } from "../../lib/voice/provisionalDraft";

// Dictation writes what is heard into the draft while it is still said: each
// segment's newest partial replaces its last, the final replaces it for good.

/** `show` applied, as the composer does. */
function show(p: ProvisionalDraft, draft: string, segment: number, text: string): string {
  const shown = p.show(draft, segment, text);
  if (!shown) throw new Error("the segment was taken over");
  return shown.draft;
}

describe("a segment's partials", () => {
  it("go in at the end, spaced like a typed piece, and each replaces the last", () => {
    const p = new ProvisionalDraft();
    let draft = show(p, "please", 1, "fix the");
    expect(draft).toBe("please fix the");
    draft = show(p, draft, 1, "fix the login");
    expect(draft).toBe("please fix the login");
    // Whole-segment or last-seconds transcripts alike: never duplicated.
    draft = show(p, draft, 1, "the login page");
    expect(draft).toBe("please the login page");
    expect(p.settled(draft)).toBe("please");
  });

  it("start the draft without a space when it is empty or ends in one", () => {
    expect(show(new ProvisionalDraft(), "", 1, "hello")).toBe("hello");
    expect(show(new ProvisionalDraft(), "one\n", 1, "two")).toBe("one\ntwo");
  });

  it("are replaced in place by the final, which may differ", () => {
    const p = new ProvisionalDraft();
    const draft = show(p, "please", 1, "fix the lock in");
    const settled = p.settle(draft, 1);
    expect(settled).toMatchObject({ draft: "please", at: 6, taken: false });
    expect(settled.splice).toEqual({ at: 6, removed: 16, inserted: 0 });
    expect(p.pending).toBe(false);
  });

  it("leave the draft as it was when the segment settles with nothing", () => {
    const p = new ProvisionalDraft();
    const draft = show(p, "", 1, "uh");
    expect(p.settle(draft, 1).draft).toBe("");
  });
});

describe("the user's own typing meanwhile", () => {
  it("after the provisional text leaves it alone and the next partial still replaces only itself", () => {
    const p = new ProvisionalDraft();
    let draft = show(p, "a", 1, "b c");
    draft += " (typed)";
    draft = show(p, draft, 1, "b c d");
    expect(draft).toBe("a b c d (typed)");
    const settled = p.settle(draft, 1);
    expect(settled.draft).toBe("a (typed)");
    expect(settled.at).toBe(1);
  });

  it("before the provisional text shifts it", () => {
    const p = new ProvisionalDraft();
    let draft = show(p, "world", 1, "there");
    draft = `Hello ${draft}`;
    draft = show(p, draft, 1, "out there");
    expect(draft).toBe("Hello world out there");
    expect(p.settled(draft)).toBe("Hello world");
  });

  it("inside the provisional text makes it theirs: no tracking, the final's words stay out", () => {
    const p = new ProvisionalDraft();
    let draft = show(p, "a", 1, "fix the bug");
    draft = draft.replace("fix", "fixx");
    expect(p.settled(draft)).toBe("a fixx the bug");
    expect(p.pending).toBe(false);
    expect(p.show(draft, 1, "fix the bug now")).toBeNull();
    const settled = p.settle(draft, 1);
    expect(settled).toMatchObject({ draft: "a fixx the bug", taken: true });
    // Taken once: the next segment of the same number starts afresh.
    expect(p.settle(draft, 1).taken).toBe(false);
  });

  it("deleting the whole draft ends the tracking", () => {
    const p = new ProvisionalDraft();
    show(p, "", 1, "hello");
    expect(p.settled("")).toBe("");
    expect(p.pending).toBe(false);
    expect(p.settle("", 1).taken).toBe(true);
  });

  it("is not told apart from text equal to its neighbour when the splice is told", () => {
    const p = new ProvisionalDraft();
    let draft = show(p, "", 1, "go go");
    // The settled piece of an earlier segment goes in right before it.
    const settled = p.settle(draft, 0);
    expect(settled.at).toBe(0);
    const before = draft;
    draft = `go go ${draft}`;
    p.spliced(before, draft, { at: 0, removed: 0, inserted: 6 });
    expect(p.settled(draft)).toBe("go go ");
  });
});

describe("several segments at once", () => {
  it("keeps one span each, in speaking order", () => {
    const p = new ProvisionalDraft();
    let draft = show(p, "", 1, "first part");
    draft = show(p, draft, 2, "second");
    draft = show(p, draft, 1, "first part longer");
    expect(draft).toBe("first part longer second");
    expect(p.settle(draft, 1).draft).toBe(" second");
  });

  it("puts the final of a segment that never had a partial before the later segments' text", () => {
    const p = new ProvisionalDraft();
    const draft = show(p, "start", 3, "later words");
    const settled = p.settle(draft, 2);
    expect(settled).toMatchObject({ draft, at: 5, taken: false });
    expect(settled.splice).toBeNull();
  });

  it("puts the final of the newest segment at the end (null)", () => {
    const p = new ProvisionalDraft();
    expect(p.settle("abc", 4).at).toBeNull();
  });
});

describe("clearing", () => {
  it("takes every provisional span out and forgets them", () => {
    const p = new ProvisionalDraft();
    let draft = show(p, "keep", 1, "one");
    draft = show(p, draft, 2, "two");
    const cleared = p.clear(draft);
    expect(cleared.draft).toBe("keep");
    expect(cleared.splices).toHaveLength(2);
    expect(p.pending).toBe(false);
  });

  it("reports the draft without provisional text as the settled one", () => {
    const p = new ProvisionalDraft();
    const draft = show(p, "", 1, "stop");
    expect(draft.trim()).not.toBe("");
    expect(p.settled(draft).trim()).toBe("");
  });
});

describe("a caret across a splice", () => {
  it("stays before it, moves after it, and ends up after new text it was in or at", () => {
    const splice = { at: 5, removed: 4, inserted: 7 };
    expect(shiftOffset(2, splice)).toBe(2);
    expect(shiftOffset(5, splice)).toBe(5);
    expect(shiftOffset(7, splice)).toBe(12);
    expect(shiftOffset(9, splice)).toBe(12);
    expect(shiftOffset(11, splice)).toBe(14);
    // A pure insertion at the caret: the caret follows it, as typing does.
    expect(shiftOffset(5, { at: 5, removed: 0, inserted: 3 })).toBe(8);
  });
});
