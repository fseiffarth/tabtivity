/**
 * Unit tests for the bracket-match helpers: `findMatchingBracket` (which
 * bracket, if any, the caret sits just before/after, and its partner) and
 * `decorateBracketMatch` (the transparent overlay that highlights both).
 * Mirrors the search-decoration tests.
 */
import { describe, it, expect } from "vitest";
import {
  findMatchingBracket,
  decorateBracketMatch,
  decorateUnclosedBrackets,
} from "../../components/embed/fileViewer/decorations";

/** A single-character range at `i`, for terser expectations below. */
function at(i: number) {
  return { start: i, end: i + 1 };
}

describe("findMatchingBracket", () => {
  it("matches a caret right before an opening paren", () => {
    // "(foo)" — caret at 0, just before "("
    expect(findMatchingBracket("(foo)", 0)).toEqual({ open: at(0), close: at(4) });
  });

  it("matches a caret right after a closing paren", () => {
    // caret at 5, just after ")"
    expect(findMatchingBracket("(foo)", 5)).toEqual({ open: at(0), close: at(4) });
  });

  it("matches a caret right after an opening bracket", () => {
    // "[bar]" — caret at 1, just after "[" (the position right after typing
    // an opener, or clicking directly against it).
    expect(findMatchingBracket("[bar]", 1)).toEqual({ open: at(0), close: at(4) });
  });

  it("matches a caret right before a closing bracket", () => {
    // "[bar]" — caret at 4, just before "]" (the position right before
    // deleting a closer with Delete/Backspace).
    expect(findMatchingBracket("[bar]", 4)).toEqual({ open: at(0), close: at(4) });
  });

  it("matches all four caret positions touching one pair to the same result", () => {
    const text = "(foo)";
    const expected = { open: at(0), close: at(4) };
    expect(findMatchingBracket(text, 0)).toEqual(expected); // before "("
    expect(findMatchingBracket(text, 1)).toEqual(expected); // after "("
    expect(findMatchingBracket(text, 4)).toEqual(expected); // before ")"
    expect(findMatchingBracket(text, 5)).toEqual(expected); // after ")"
  });

  it("matches braces", () => {
    expect(findMatchingBracket("{a{b}c}", 0)).toEqual({ open: at(0), close: at(6) });
    expect(findMatchingBracket("{a{b}c}", 7)).toEqual({ open: at(0), close: at(6) });
  });

  it("matches the inner pair of nested brackets", () => {
    const text = "{a{b}c}";
    // caret at 2, just before the inner "{"
    expect(findMatchingBracket(text, 2)).toEqual({ open: at(2), close: at(4) });
    // caret at 5, just after the inner "}"
    expect(findMatchingBracket(text, 5)).toEqual({ open: at(2), close: at(4) });
  });

  it("prefers the bracket right after the caret over the one right before", () => {
    // "()()" caret at 2 sits between the first ")" and the second "(" — the
    // char right after (the second "(") wins.
    expect(findMatchingBracket("()()", 2)).toEqual({ open: at(2), close: at(3) });
  });

  it("returns null when the caret touches no bracket", () => {
    expect(findMatchingBracket("hello world", 3)).toBeNull();
  });

  it("returns null for an unbalanced bracket", () => {
    expect(findMatchingBracket("(foo", 0)).toBeNull();
    expect(findMatchingBracket("foo)", 4)).toBeNull();
  });

  it("does not pair mismatched bracket kinds", () => {
    expect(findMatchingBracket("(a]", 0)).toBeNull();
  });

  it("handles a caret at the very start/end of the text", () => {
    expect(findMatchingBracket("", 0)).toBeNull();
    expect(findMatchingBracket(")", 0)).toBeNull();
  });

  it("matches TeX-style group braces and optional-arg brackets", () => {
    const text = "\\includegraphics[width=2cm]{fig.png}";
    // caret just before the opening "[" of the optional arg
    const optBracket = text.indexOf("[");
    const optClose = text.indexOf("]");
    expect(findMatchingBracket(text, optBracket)).toEqual({ open: at(optBracket), close: at(optClose) });
    // caret just after the closing "}" of the mandatory arg
    const braceOpen = text.indexOf("{");
    const braceClose = text.indexOf("}");
    expect(findMatchingBracket(text, braceClose + 1)).toEqual({
      open: at(braceOpen),
      close: at(braceClose),
    });
  });
});

describe("decorateBracketMatch", () => {
  it("wraps both bracket characters in a highlight span, escaping the rest", () => {
    const html = decorateBracketMatch("(a<b>c)", { open: at(0), close: at(6) });
    expect(html).toBe(
      '<span class="file-viewer-bracket-match">(</span>a&lt;b&gt;c' +
        '<span class="file-viewer-bracket-match">)</span>',
    );
  });

  it("works regardless of which side is passed as open vs. close", () => {
    const a = decorateBracketMatch("[x]", { open: at(0), close: at(2) });
    const b = decorateBracketMatch("[x]", { open: at(2), close: at(0) });
    expect(a).toBe(b);
  });

  it("highlights a multi-character range, not just one glyph", () => {
    // The LaTeX extras (math delimiters, \begin/\end) match whole tokens.
    const html = decorateBracketMatch("\\[x\\]", { open: { start: 0, end: 2 }, close: { start: 3, end: 5 } });
    expect(html).toBe(
      '<span class="file-viewer-bracket-match">\\[</span>x' +
        '<span class="file-viewer-bracket-match">\\]</span>',
    );
  });
});

describe("decorateUnclosedBrackets", () => {
  it("repaints every unmatched opener while escaping the surrounding source", () => {
    expect(decorateUnclosedBrackets("{a<b>(", [at(0), at(5)])).toBe(
      '<span class="file-viewer-unclosed-bracket">{</span>a&lt;b&gt;' +
        '<span class="file-viewer-unclosed-bracket">(</span>',
    );
  });

  // The hover tooltip reads `data-hint` off the span it hit, so each range can
  // say which mistake it is — an unclosed `\begin` and a stray `\end` share the
  // underline but not the sentence.
  it("carries a range's hint into data-hint, escaped", () => {
    expect(
      decorateUnclosedBrackets("{x", [{ start: 0, end: 1, hint: 'no "end" <yet>' }]),
    ).toBe(
      '<span class="file-viewer-unclosed-bracket" ' +
        'data-hint="no &quot;end&quot; &lt;yet&gt;">{</span>x',
    );
  });
});
