/**
 * Regression tests for CARET / INSERT-POSITION correctness in the native in-app
 * code editors (the shared `CodeEditor` behind the text / markdown / TeX / code
 * viewers).
 *
 * These bugs keep coming back whenever unrelated editor work touches the
 * overlay/line-height plumbing, so the invariants are pinned here:
 *
 *  1. VERTICAL alignment ("caret sits below the coloured glyphs, drifting down
 *     the file"). The editor stacks a transparent <textarea> (owns the caret)
 *     over a syntax-highlighted <pre> (owns the visible glyphs). WebKitGTK lays
 *     the textarea's lines out as whole-device-pixel boxes while the <pre> uses
 *     the exact fractional multiple; under a fractional display scale those
 *     diverge and ACCUMULATE — the caret drifts a full line off by the bottom.
 *     `snapToDevicePx` is the fix: snap the shared line-height so both layers
 *     land on the same device-pixel grid. We model both layouts and assert the
 *     drift is zero with snapping (and non-zero without, so the model is real).
 *
 *  2. INSERT positions: Tab / Shift+Tab indentation must land the caret and keep
 *     the selection exactly (`applyIndent`), and a SyncTeX reverse-search jump
 *     must place the caret at the right source offset (`lineStartOffset` +
 *     column, clamped to the line).
 *
 * The horizontal "caret is left of the click on some lines" symptom is a metric
 * divergence between the layers (font/kerning/tab-size); that invariant is
 * locked in `NativeEditorMetricsCss.test.ts`, and the rendered device-pixel snap
 * in `NativeEditorCaretLayout.test.tsx`.
 */
import { describe, it, expect } from "vitest";
import { snapToDevicePx } from "../../components/embed/fileViewer/caretMirror";
import { applyIndent, advanceTexBraceTabStop } from "../../components/embed/fileViewer/indent";
import { lineStartOffset, offsetToLineCol } from "../../lib/viewers/tex/tex";

// --- vertical caret/glyph drift model ---------------------------------------
//
// Reproduce the two competing layouts EXACTLY as WebKitGTK does (see the
// `snapToDevicePx` doc comment). Both are fed the SAME CSS line-height `lhCss`;
// they only diverge in how each rounds to device pixels.
//
//   overlay <pre>  : row n top (device px) = round(n · lhCss · dpr)   (fractional multiple)
//   <textarea>     : row n top (device px) = n · round(lhCss · dpr)   (whole-box stacking)
//
// The caret rides the textarea; the visible glyph rides the <pre>. Their
// difference is exactly the caret-vs-glyph vertical drift a user sees.
const overlayRowTop = (n: number, lhCss: number, dpr: number) =>
  Math.round(n * lhCss * dpr);
const textareaRowTop = (n: number, lhCss: number, dpr: number) =>
  n * Math.round(lhCss * dpr);
const caretDrift = (n: number, lhCss: number, dpr: number) =>
  textareaRowTop(n, lhCss, dpr) - overlayRowTop(n, lhCss, dpr);

// Fractional display scales that actually ship (125%, 150%, 175%, 133%, …), plus
// a couple of awkward ones. Integer scales (1, 2, 3) are covered separately.
const FRACTIONAL_DPRS = [1.1, 1.25, 1.333333, 1.5, 1.75, 2.25, 2.5, 1.2];
// Raw line-heights the size control produces: round(fontSize · 1.5) over the
// editor's whole font-size range (see EDITOR_LINE_RATIO / the A± control).
const RAW_LINE_HEIGHTS = Array.from({ length: 24 }, (_, i) =>
  Math.round((8 + i) * 1.5),
);

describe("snapToDevicePx", () => {
  it("is a no-op for whole-pixel line-heights at integer device-pixel ratios", () => {
    // The size control only ever produces whole-pixel line-heights (round(font·1.5)),
    // and at an integer dpr those already sit on the device grid → nothing to snap.
    for (const dpr of [1, 2, 3]) {
      for (const px of [12, 18, 21, 24, 27]) {
        expect(snapToDevicePx(px, dpr)).toBe(px);
      }
    }
  });

  it("lands the line-height on a whole number of device pixels", () => {
    for (const dpr of FRACTIONAL_DPRS) {
      for (const px of RAW_LINE_HEIGHTS) {
        const snapped = snapToDevicePx(px, dpr);
        const devicePx = snapped * dpr;
        // Snapped × dpr must be (within fp tolerance) an integer of device px —
        // that is the whole point: both layers now share the same device grid.
        expect(Math.abs(devicePx - Math.round(devicePx))).toBeLessThan(1e-6);
      }
    }
  });

  it("snaps to the NEAREST device-pixel grid line (≤ half a device px moved)", () => {
    for (const dpr of FRACTIONAL_DPRS) {
      for (const px of RAW_LINE_HEIGHTS) {
        const snapped = snapToDevicePx(px, dpr);
        // The correction never moves the line-height more than half a device px,
        // so text size is visually preserved while the grid is fixed.
        expect(Math.abs(snapped - px) * dpr).toBeLessThanOrEqual(0.5 + 1e-9);
      }
    }
  });
});

describe("caret-vs-glyph vertical drift (the recurring bug)", () => {
  it("REPRODUCES: without snapping the caret drifts off the glyphs and accumulates", () => {
    // Guard against a false-green model: prove the raw layouts really do diverge,
    // so the with-snapping assertion below is meaningful. On a fractional scale
    // with an odd line-height, the caret drifts more than a full CSS line within
    // a few hundred lines.
    const dpr = 1.5;
    const lhCss = 21; // odd → 21·1.5 = 31.5, not on the device grid
    const maxDrift = Math.max(
      ...Array.from({ length: 400 }, (_, n) =>
        Math.abs(caretDrift(n, lhCss, dpr) / dpr),
      ),
    );
    // Drifts well past a whole line (21 CSS px) — this is the "caret a line below
    // the text by the bottom of the file" the user reported.
    expect(maxDrift).toBeGreaterThan(lhCss);
  });

  it("FIXED: with snapToDevicePx the caret sits on the glyphs on EVERY line", () => {
    // The exact invariant the editor depends on: feed the SAME snapped line-height
    // to both layers and the per-row advance is identical, so nothing accumulates
    // no matter how long the file or how awkward the display scale.
    for (const dpr of [1, 2, 3, ...FRACTIONAL_DPRS]) {
      for (const raw of RAW_LINE_HEIGHTS) {
        const lhCss = snapToDevicePx(raw, dpr);
        for (const n of [0, 1, 2, 10, 100, 999, 3000]) {
          expect(caretDrift(n, lhCss, dpr)).toBe(0);
        }
      }
    }
  });

  it("FIXED: caret is neither above NOR below the glyphs (drift is exactly 0, not just small)", () => {
    // The user has seen it both ways (above and below) across regressions; assert
    // the signed drift is zero so neither direction can creep back.
    const dpr = 1.25;
    for (const raw of RAW_LINE_HEIGHTS) {
      const lhCss = snapToDevicePx(raw, dpr);
      for (let n = 0; n <= 2000; n += 7) {
        expect(caretDrift(n, lhCss, dpr)).toBe(0);
      }
    }
  });
});

// --- Tab / Shift+Tab insert positions ---------------------------------------

/** Build a real jsdom textarea with a value + selection for `applyIndent`. */
function ta(value: string, selStart: number, selEnd = selStart): HTMLTextAreaElement {
  const el = document.createElement("textarea");
  el.value = value;
  el.setSelectionRange(selStart, selEnd);
  return el;
}

const INDENT = "    "; // 4 spaces (mirrors the editor's INDENT)

describe("applyIndent — Tab / Shift+Tab caret & selection", () => {
  it("inserts one indent AT THE CARET and moves the caret past it", () => {
    // "abc|def" + Tab → "abc    |def"; caret advances by exactly the indent width.
    const r = applyIndent(ta("abcdef", 3), false);
    expect(r).not.toBeNull();
    expect(r!.value).toBe("abc" + INDENT + "def");
    expect(r!.selStart).toBe(3 + INDENT.length);
    expect(r!.selEnd).toBe(3 + INDENT.length);
  });

  it("inserts at the caret even at the very start of a line, not the line start heuristic", () => {
    // Caret at start of the 2nd line ("a\n|b") → indent goes at the caret.
    const r = applyIndent(ta("a\nb", 2), false);
    expect(r!.value).toBe("a\n" + INDENT + "b");
    expect(r!.selStart).toBe(2 + INDENT.length);
  });

  it("indents every line a multi-line selection touches and keeps the selection over the same text", () => {
    // Select "a\nb" in "a\nb\nc"; Tab indents both lines.
    const r = applyIndent(ta("a\nb\nc", 0, 3), false);
    expect(r!.value).toBe(INDENT + "a\n" + INDENT + "b\nc");
    // First line shifts by one indent; the selection end shifts by both indents.
    expect(r!.selStart).toBe(INDENT.length); // 4
    expect(r!.selEnd).toBe(3 + 2 * INDENT.length); // 11
    // The selected slice still spans exactly the two (now-indented) lines.
    expect(r!.value.slice(r!.selStart, r!.selEnd)).toBe("a\n" + INDENT + "b");
  });

  it("extends indentation to the whole first line when the selection starts mid-line", () => {
    // Selection begins inside the first line ("x[x\ny]y"): the indent still lands
    // at the line start, and the anchor is pushed right by the indent width.
    const r = applyIndent(ta("xx\nyy", 1, 4), false);
    expect(r!.value).toBe(INDENT + "xx\n" + INDENT + "yy");
    expect(r!.selStart).toBe(1 + INDENT.length); // 5
    expect(r!.selEnd).toBe(4 + 2 * INDENT.length); // 12
  });

  it("outdent strips one indent from each selected line", () => {
    const r = applyIndent(ta(INDENT + "a\n" + INDENT + "b", 0, (INDENT + "a\n" + INDENT + "b").length), true);
    expect(r!.value).toBe("a\nb");
  });

  it("outdent removes only the leading whitespace that exists (fewer than a full indent)", () => {
    // Two leading spaces → only two are stripped, caret never crosses the line start.
    const r = applyIndent(ta("  a", 3, 3), true);
    expect(r!.value).toBe("a");
    // selStart clamps to the line start (0), never negative / into the prior line.
    expect(r!.selStart).toBeGreaterThanOrEqual(0);
  });

  it("outdent on a line with no leading whitespace is a no-op on the text", () => {
    const r = applyIndent(ta("abc\ndef", 0, 7), true);
    expect(r!.value).toBe("abc\ndef");
  });
});

describe("advanceTexBraceTabStop", () => {
  it("moves a collapsed caret past the closing argument brace", () => {
    const value = "\\begin{align}";
    const caret = "\\begin{align".length;
    expect(advanceTexBraceTabStop(ta(value, caret))).toBe(caret + 1);
  });

  it("leaves non-brace positions and selections to normal Tab indentation", () => {
    expect(advanceTexBraceTabStop(ta("\\begin{align}", 2))).toBeNull();
    expect(advanceTexBraceTabStop(ta("\\begin{align}", 7, 12))).toBeNull();
  });
});

// --- SyncTeX reverse-search caret placement ---------------------------------
//
// Mirrors the `gotoLine` effect in CodeEditor: place the caret at (1-based)
// line/column, clamping the column to the line end so a stale SyncTeX column
// can't spill onto the next line. Kept in lock-step with the component via the
// exported `lineStartOffset` it is built on.
function caretOffsetForLineCol(text: string, line: number, column: number): number {
  const lineStart = lineStartOffset(text, line);
  if (!column || column <= 1) return lineStart;
  const nl = text.indexOf("\n", lineStart);
  const lineEnd = nl === -1 ? text.length : nl;
  return Math.min(lineStart + (column - 1), lineEnd);
}

describe("reverse-search caret placement (line/column → insert offset)", () => {
  const TEXT = "\\section{Intro}\nHello world\nsecond paragraph here\n";

  it("column ≤ 1 (or 0, SyncTeX's no-column sentinel) lands at the line start", () => {
    expect(caretOffsetForLineCol(TEXT, 2, 0)).toBe(lineStartOffset(TEXT, 2));
    expect(caretOffsetForLineCol(TEXT, 2, 1)).toBe(lineStartOffset(TEXT, 2));
    // And that offset is genuinely the first char of line 2 ("Hello world").
    expect(TEXT.slice(caretOffsetForLineCol(TEXT, 2, 1), caretOffsetForLineCol(TEXT, 2, 1) + 5)).toBe("Hello");
  });

  it("offsets into the line by (column − 1) and round-trips through offsetToLineCol", () => {
    // Caret at line 2, column 7 → the 'w' of "world".
    const off = caretOffsetForLineCol(TEXT, 2, 7);
    expect(TEXT[off]).toBe("w");
    expect(offsetToLineCol(TEXT, off)).toEqual({ line: 2, column: 7 });
  });

  it("clamps an over-long (stale) column to the line end, never spilling to the next line", () => {
    const off = caretOffsetForLineCol(TEXT, 2, 999);
    const { line } = offsetToLineCol(TEXT, off);
    expect(line).toBe(2); // still on line 2, not line 3
    // Exactly at the newline that ends line 2.
    expect(TEXT[off]).toBe("\n");
  });

  it("places every in-range (line, column) at an offset that round-trips exactly", () => {
    const lines = TEXT.split("\n");
    for (let l = 1; l <= lines.length; l++) {
      const len = lines[l - 1].length;
      for (let c = 1; c <= len + 1; c++) {
        const off = caretOffsetForLineCol(TEXT, l, c);
        expect(offsetToLineCol(TEXT, off)).toEqual({ line: l, column: c });
      }
    }
  });
});
