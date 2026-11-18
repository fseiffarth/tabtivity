/**
 * Tests for the TeX editor's hover preview (#tex-hover-preview), pure halves:
 * which fragments of a document are previewable at all (`tex.ts`), and the cache
 * key + log reading the preview module is built around (`texPreview.ts`).
 *
 * The compile itself is the backend's (`commands/tex.rs`, tested there) and the
 * gesture is the editor's; what is worth pinning here is the two decisions that
 * would silently make the feature wrong rather than broken — previewing a
 * fragment that means something different on its own, and re-typesetting a
 * formula that was already typeset.
 */
import { describe, it, expect } from "vitest";
import { texSnippetRanges, texPreamble, isPreviewableTexEnv } from "../../lib/viewers/tex/tex";
import { texPreviewKey, firstTexErrorLine } from "../../lib/viewers/tex/texPreview";

/** The source text of every range found, which is what actually gets typeset. */
function bodies(src: string): string[] {
  return texSnippetRanges(src).map((r) => src.slice(r.start, r.end));
}

describe("texSnippetRanges", () => {
  it("covers a fragment WITH its delimiters — `x^2` is not a document, `$x^2$` is", () => {
    const src = "Let $x^2$ be it, and \\[ y = 1 \\] too.";
    expect(bodies(src)).toEqual(["$x^2$", "\\[ y = 1 \\]"]);
    expect(texSnippetRanges(src).map((r) => r.kind)).toEqual(["inline", "display"]);
  });

  it("takes the environment as one snippet and not the math inside it", () => {
    const src = "\\begin{align}\n  a &= $b$ \\\\\n  c &= d\n\\end{align}\n";
    // The outer thing is what should be typeset; two overlapping hit boxes would
    // make which one you get depend on layout order.
    expect(bodies(src)).toEqual([src.trimEnd()]);
  });

  it("previews math, self-contained environments, and the two float kinds", () => {
    expect(isPreviewableTexEnv("equation")).toBe(true);
    expect(isPreviewableTexEnv("align*")).toBe(true);
    expect(isPreviewableTexEnv("tikzpicture")).toBe(true);
    // The four names `preview.sty`'s `floats` option actually fixes up. What a
    // float preview cannot show is its *placement*; what it can show — the
    // graphic's size and where the caption wraps — is what is worth seeing.
    expect(isPreviewableTexEnv("figure")).toBe(true);
    expect(isPreviewableTexEnv("figure*")).toBe(true);
    expect(isPreviewableTexEnv("table")).toBe(true);
    expect(isPreviewableTexEnv("table*")).toBe(true);
    const src = "\\begin{figure}\n\\includegraphics{a}\n\\caption{A}\n\\end{figure}\n";
    expect(bodies(src)).toEqual([src.trimEnd()]);
  });

  it("leaves out the floats a real engine could not typeset, and non-content envs", () => {
    // Each was tried: `wrapfigure` is not a `\@float` and previews to no pages;
    // `algorithm` (a `float`-package float) dies in preview's own float fixup.
    expect(isPreviewableTexEnv("wrapfigure")).toBe(false);
    expect(isPreviewableTexEnv("algorithm")).toBe(false);
    // And a frame's meaning is the deck around it.
    expect(isPreviewableTexEnv("frame")).toBe(false);
    expect(isPreviewableTexEnv("document")).toBe(false);
    expect(bodies("\\begin{frame}\ntitle\n\\end{frame}\n")).toEqual([]);
  });

  it("ignores a commented-out formula", () => {
    // A `%`-ed example must not be a hover target, and its stray `$` must not
    // pair with real math further down the file.
    const src = "% here is $an example$\nreal $x$ math\n";
    expect(bodies(src)).toEqual(["$x$"]);
  });

  it("leaves an escaped dollar and a `\\\\[2mm]` row spacing alone", () => {
    const src = "costs \\$5 today, and a row \\\\[2mm] after it";
    expect(bodies(src)).toEqual([]);
  });
});

describe("texPreamble", () => {
  it("is the text before \\begin{document}", () => {
    const src = "\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\nbody\n\\end{document}\n";
    expect(texPreamble(src)).toBe("\\documentclass{article}\n\\usepackage{amsmath}\n");
  });

  it("is null for a file that has none, so the caller reads the root's instead", () => {
    // An `\input`ed chapter. Answering "" here would preview every macro-using
    // formula in a multi-file paper as an undefined control sequence.
    expect(texPreamble("\\section{Method}\nSome $\\R$ math.\n")).toBeNull();
  });
});

describe("texPreviewKey", () => {
  it("keys on what was compiled, so the same formula under one preamble is one entry", () => {
    expect(texPreviewKey("\\documentclass{article}", "$x$")).toBe(
      texPreviewKey("\\documentclass{article}", "$x$"),
    );
  });

  it("changes when either half does", () => {
    const base = texPreviewKey("\\documentclass{article}", "$x$");
    expect(texPreviewKey("\\documentclass{article}", "$y$")).not.toBe(base);
    expect(texPreviewKey("\\documentclass{book}", "$x$")).not.toBe(base);
  });
});

describe("firstTexErrorLine", () => {
  it("prefers TeX's own error line over the log's tail", () => {
    const log = "This is pdfTeX\n! Undefined control sequence.\nl.5 \\foo\n[1] Output written.\n";
    expect(firstTexErrorLine(log)).toBe("Undefined control sequence.");
  });

  it("falls back to the last thing said when nothing was flagged", () => {
    expect(firstTexErrorLine("running\nno pages of output.\n\n")).toBe("no pages of output.");
    expect(firstTexErrorLine("")).toBe("compile failed");
  });
});
