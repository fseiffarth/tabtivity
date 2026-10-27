/**
 * The native editor's linewise comment toggle (Ctrl+Shift+C) and the per-language
 * marker it writes.
 *
 * The invariants worth pinning are the ones a user notices immediately: pressing
 * twice must round-trip the text exactly, a partially-commented block must go
 * fully commented before it uncomments (not flip line by line), and the marker
 * must land at the block's shallowest indent so nested code keeps its shape.
 */
import { describe, expect, it } from "vitest";
import { applyLineComment } from "../../components/embed/fileViewer/indent";
import { lineCommentMarker } from "../../lib/viewers/highlight";

/** A real jsdom textarea carrying a value + selection, as the key handler sees it. */
function ta(value: string, selStart: number, selEnd = selStart): HTMLTextAreaElement {
  const el = document.createElement("textarea");
  el.value = value;
  el.setSelectionRange(selStart, selEnd);
  return el;
}

describe("lineCommentMarker", () => {
  it("is % for TeX and the language's own marker elsewhere", () => {
    expect(lineCommentMarker("tex")).toBe("%");
    expect(lineCommentMarker("js")).toBe("//");
    expect(lineCommentMarker("python")).toBe("#");
    expect(lineCommentMarker("sql")).toBe("--");
  });

  it("is null where a linewise comment does not exist", () => {
    expect(lineCommentMarker("json")).toBeNull();
    expect(lineCommentMarker("markdown")).toBeNull();
    expect(lineCommentMarker("markup")).toBeNull(); // block comments only
    expect(lineCommentMarker("plain")).toBeNull();
  });
});

describe("applyLineComment", () => {
  it("comments the caret's own line when nothing is selected", () => {
    const r = applyLineComment(ta("\\section{Intro}", 5), "%")!;
    expect(r.value).toBe("% \\section{Intro}");
    // The caret keeps its place in the text, pushed right by the marker.
    expect(r.selStart).toBe(5 + 2);
  });

  it("comments every line a selection touches and keeps the selection over them", () => {
    const src = "a\nb\nc";
    const r = applyLineComment(ta(src, 0, 3), "%")!;
    expect(r.value).toBe("% a\n% b\nc");
    expect(r.value.slice(r.selStart, r.selEnd)).toBe("a\n% b");
  });

  it("round-trips: a second toggle restores the original text exactly", () => {
    const src = "\\begin{itemize}\n  \\item one\n\\end{itemize}";
    const first = applyLineComment(ta(src, 0, src.length), "%")!;
    const second = applyLineComment(ta(first.value, first.selStart, first.selEnd), "%")!;
    expect(second.value).toBe(src);
  });

  it("commutes a partially-commented block to fully commented before it uncomments", () => {
    const src = "% a\nb";
    const once = applyLineComment(ta(src, 0, src.length), "%")!;
    expect(once.value).toBe("% % a\n% b");
    const twice = applyLineComment(ta(once.value, 0, once.value.length), "%")!;
    expect(twice.value).toBe(src);
  });

  it("inserts at the block's shallowest indent, preserving relative indentation", () => {
    const src = "  a\n    b";
    const r = applyLineComment(ta(src, 0, src.length), "%")!;
    expect(r.value).toBe("  % a\n  %   b");
  });

  it("uncomments markers sitting at their own indent, dropping one following space", () => {
    const r = applyLineComment(ta("  % a\n  %b", 0, 10), "%")!;
    expect(r.value).toBe("  a\n  b");
  });

  it("leaves a deliberate double marker as a single one", () => {
    const r = applyLineComment(ta("%% a", 0, 4), "%")!;
    expect(r.value).toBe("% a");
  });

  it("skips blank lines inside a multi-line block rather than stranding markers", () => {
    const src = "a\n\nb";
    const r = applyLineComment(ta(src, 0, src.length), "%")!;
    expect(r.value).toBe("% a\n\n% b");
    // …and the blank line does not block the uncomment either.
    const back = applyLineComment(ta(r.value, 0, r.value.length), "%")!;
    expect(back.value).toBe(src);
  });

  it("comments a selection that is nothing but a blank line", () => {
    const r = applyLineComment(ta("", 0), "%")!;
    expect(r.value).toBe("% ");
  });

  it("does not reach into the line a selection merely ends at", () => {
    const r = applyLineComment(ta("a\nb", 0, 2), "%")!;
    expect(r.value).toBe("% a\nb");
  });

  it("uses the language's marker, not TeX's", () => {
    expect(applyLineComment(ta("const x = 1;", 0), "//")!.value).toBe("// const x = 1;");
    expect(applyLineComment(ta("x = 1", 0), "#")!.value).toBe("# x = 1");
  });
});
