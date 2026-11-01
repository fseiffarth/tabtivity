/**
 * Chrome marks come from `common/icons/Icon.tsx`: a text glyph is drawn from
 * whichever symbol or emoji font the OS has, with its own weight, baseline
 * and, for two of them, colour. `eslint.config.js` (GLYPH_SYNTAX) flags a new
 * one at lint time; this reads the same set so the allow-list has to shrink
 * with the sites, not outlive them.
 */
import { describe, it, expect } from "vitest";

const GLYPH = /[✕✖×✓✔‹›●○✎✉⟳↻▶⠿⎇⚙☑⋯◷▭▦]|🗓|🧠/u;
const JSX_GLYPH = new RegExp(`>\\s*(?:${GLYPH.source})\\s*(?:<|\\{)`, "u");
const ALLOWED = new Set(
  [
    "embed/pdf/PdfMarkupBar.tsx",
    "files/GitHistory.tsx",
    "layout/RootReviewStrip.tsx",
    "terminal/TerminalReaderFacts.tsx",
    "terminal/TerminalReaderView.tsx",
  ].map((file) => `../../components/${file}`),
);

const SOURCES = import.meta.glob("../../components/**/*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("chrome glyphs", () => {
  it("no component outside the allow-list spells one as JSX text", () => {
    const stray = Object.entries(SOURCES)
      .filter(([file, source]) => !ALLOWED.has(file) && JSX_GLYPH.test(source))
      .map(([file]) => file);
    expect(stray).toEqual([]);
  });

  it("every allow-listed file still has one", () => {
    for (const file of ALLOWED) {
      expect(SOURCES[file], file).toBeDefined();
      expect(JSX_GLYPH.test(SOURCES[file]), file).toBe(true);
    }
  });
});
