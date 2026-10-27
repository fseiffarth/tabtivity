/**
 * The native editor's aligned Enter (Python + TeX) and the indent guides drawn
 * behind the code.
 *
 * The invariants worth pinning are the ones a typist notices in the first
 * minute: a block never falls out from under the caret, a `:` inside a sentence
 * is not a block opener, a `\begin` is not given a second `\end`, and the guide
 * layer stays glyph-for-glyph aligned with the text it sits behind — which is
 * why it wraps the file's own whitespace rather than a normalised copy of it.
 */
import { describe, expect, it } from "vitest";
import {
  applyAutoIndent,
  decorateIndentGuides,
  detectIndentUnit,
  type IndentUnit,
} from "../../components/embed/fileViewer/indent";

const FOUR: IndentUnit = { text: "    ", width: 4 };
const TWO: IndentUnit = { text: "  ", width: 2 };
const TAB: IndentUnit = { text: "\t", width: 4 };

/** A real jsdom textarea carrying a value + selection, as the key handler sees it. */
function ta(value: string, selStart: number, selEnd = selStart): HTMLTextAreaElement {
  const el = document.createElement("textarea");
  el.value = value;
  el.setSelectionRange(selStart, selEnd);
  return el;
}

/** The text `applyAutoIndent` produces, with the caret marked by `|`. */
function typed(value: string, caret: number, lang: "python" | "tex", unit = FOUR): string | null {
  const r = applyAutoIndent(ta(value, caret), lang, unit);
  if (!r) return null;
  return r.value.slice(0, r.selStart) + "|" + r.value.slice(r.selStart);
}

describe("applyAutoIndent — Python", () => {
  it("carries the current line's indentation to the next", () => {
    expect(typed("    x = 1", 9, "python")).toBe("    x = 1\n    |");
  });

  it("returns null at column 0, leaving the plain newline to the engine", () => {
    // Nothing to add means nothing to intercept — that is what keeps the
    // textarea's own undo entry for an ordinary Enter.
    expect(applyAutoIndent(ta("x = 1", 5), "python", FOUR)).toBeNull();
  });

  it("indents one level after a block opener", () => {
    expect(typed("def f(x):", 9, "python")).toBe("def f(x):\n    |");
    expect(typed("    if x:", 9, "python")).toBe("    if x:\n        |");
  });

  it("indents by the file's own unit, not by the editor's four spaces", () => {
    expect(typed("  if x:", 7, "python", TWO)).toBe("  if x:\n    |");
    expect(typed("\tif x:", 6, "python", TAB)).toBe("\tif x:\n\t\t|");
  });

  it("does not read a colon inside a string or a comment as a block", () => {
    expect(typed('s = "note:"', 11, "python")).toBeNull();
    expect(typed("x = 1  # note:", 14, "python")).toBeNull();
  });

  it("carries the indentation and nothing else inside a docstring", () => {
    const src = '    """Usage:';
    expect(typed(src, src.length, "python")).toBe('    """Usage:\n    |');
  });

  it("steps back out after a statement that ends the block", () => {
    expect(typed("        return x", 16, "python")).toBe("        return x\n    |");
    expect(typed("      raise E", 13, "python", TWO)).toBe("      raise E\n    |");
    // `returns` is not `return`: the line keeps its level.
    expect(typed("    returns = 1", 15, "python")).toBe("    returns = 1\n    |");
  });

  it("never steps back past column 0", () => {
    // One level out of one level is column 0, which is exactly what the engine's
    // own newline gives — so the handler declines and keeps the native undo.
    expect(applyAutoIndent(ta("    pass", 8), "python", FOUR)).toBeNull();
    expect(applyAutoIndent(ta("  break", 7), "python", FOUR)).toBeNull();
  });

  it("aligns a continuation under the first argument", () => {
    expect(typed("foo(a, b,", 9, "python")).toBe("foo(a, b,\n    |");
    expect(typed("    foo(a,", 10, "python")).toBe("    foo(a,\n        |");
  });

  it("indents one level when the bracket ends its line", () => {
    expect(typed("    foo(", 8, "python")).toBe("    foo(\n        |");
    // A trailing comment is not an argument to align under.
    expect(typed("    foo(  # args", 16, "python")).toBe("    foo(  # args\n        |");
  });

  it("aligns under an opener several lines up (implicit continuation)", () => {
    const src = "foo(a,\n    b,";
    expect(typed(src, src.length, "python")).toBe("foo(a,\n    b,\n    |");
  });

  it("opens a block when the caret sits between a pair", () => {
    expect(typed("foo()", 4, "python")).toBe("foo(\n    |\n)");
    expect(typed("    d = {}", 9, "python")).toBe("    d = {\n        |\n    }");
  });

  it("replaces a selection, and reads the line the selection starts on", () => {
    const r = applyAutoIndent(ta("    if x: pass", 9, 14), "python", FOUR)!;
    expect(r.value).toBe("    if x:\n        ");
    expect(r.selStart).toBe(r.value.length);
  });
});

describe("applyAutoIndent — TeX", () => {
  it("opens an environment: one level in, and the matching \\end below", () => {
    const src = "\\begin{itemize}";
    expect(typed(src, src.length, "tex")).toBe(
      "\\begin{itemize}\n    |\n\\end{itemize}",
    );
  });

  it("keeps the block at the \\begin's own indentation", () => {
    const src = "  \\begin{align}";
    expect(typed(src, src.length, "tex")).toBe("  \\begin{align}\n      |\n  \\end{align}");
  });

  it("does not write a second \\end when one is already waiting", () => {
    const src = "\\begin{itemize}\n\\end{itemize}";
    expect(typed(src, 15, "tex")).toBe("\\begin{itemize}\n    |\n\\end{itemize}");
  });

  it("counts nesting when looking for that \\end", () => {
    // The outer \begin's own \end is the second one; both are already there.
    const src = "\\begin{itemize}\n\\begin{itemize}\n\\end{itemize}\n\\end{itemize}";
    expect(typed(src, 15, "tex")).toBe(src.slice(0, 15) + "\n    |" + src.slice(15));
  });

  it("ignores a \\begin inside a comment", () => {
    expect(typed("% \\begin{itemize}", 17, "tex")).toBeNull();
    // …but not one after an escaped percent sign, which is a character.
    const src = "50\\% \\begin{itemize}";
    expect(typed(src, src.length, "tex")).toBe(
      "50\\% \\begin{itemize}\n    |\n\\end{itemize}",
    );
  });

  it("carries the indentation of an ordinary line", () => {
    expect(typed("  \\item one", 11, "tex")).toBe("  \\item one\n  |");
  });
});

describe("applyAutoIndent — other languages", () => {
  it("leaves every other language's Enter alone", () => {
    for (const lang of ["js", "rust", "markdown", "yaml", "plain"] as const) {
      expect(applyAutoIndent(ta("    x", 5), lang, FOUR)).toBeNull();
    }
  });
});

describe("detectIndentUnit", () => {
  it("reads the step between successive lines", () => {
    expect(detectIndentUnit("def f():\n    if x:\n        pass\n")).toEqual(FOUR);
    expect(detectIndentUnit("def f():\n  if x:\n    pass\n")).toEqual(TWO);
  });

  it("calls a file that leads with tabs a tab file", () => {
    expect(detectIndentUnit("def f():\n\tif x:\n\t\tpass\n")).toEqual(TAB);
  });

  it("falls back to the editor's own indent when the text says nothing", () => {
    expect(detectIndentUnit("a\nb\nc\n")).toEqual(FOUR);
    expect(detectIndentUnit("")).toEqual(FOUR);
  });

  it("is not thrown off by blank lines inside a block", () => {
    expect(detectIndentUnit("def f():\n\n  if x:\n\n    pass\n")).toEqual(TWO);
  });
});

describe("decorateIndentGuides", () => {
  it("marks the first column of every level a line occupies", () => {
    const html = decorateIndentGuides("        pass", FOUR)!;
    expect(html).toBe(
      '<span class="file-viewer-indent-guide">    </span>' +
        '<span class="file-viewer-indent-guide">    </span>pass',
    );
  });

  it("wraps the file's own characters, never a normalised copy", () => {
    // A tab rewritten as spaces would slide every guide after it off its column.
    const html = decorateIndentGuides("\t\tpass", TAB)!;
    expect(html).toBe(
      '<span class="file-viewer-indent-guide">\t</span>' +
        '<span class="file-viewer-indent-guide">\t</span>pass',
    );
  });

  it("marks where a partial level starts and leaves its remainder bare", () => {
    expect(decorateIndentGuides("      pass", FOUR)!).toBe(
      '<span class="file-viewer-indent-guide">    </span>' +
        '<span class="file-viewer-indent-guide">  </span>pass',
    );
  });

  it("keeps every line, so the layer stays row-for-row with the text", () => {
    const html = decorateIndentGuides("a\n  b\n\nc", TWO)!;
    expect(html.split("\n")).toHaveLength(4);
    expect(html.split("\n")[0]).toBe("a");
    expect(html.split("\n")[2]).toBe("");
  });

  it("is null when nothing in the file is indented", () => {
    expect(decorateIndentGuides("a\nb\n", FOUR)).toBeNull();
  });

  it("escapes the source it emits", () => {
    const html = decorateIndentGuides("  <script>&x</script>", TWO)!;
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;&amp;x&lt;/script&gt;");
  });
});
