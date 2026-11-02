/**
 * The desktop type scale (docs/context/desktop_ui_system.md): every UI size
 * reads a `--text-*` token, so density moves from `themes.css` and the Theme
 * Customizer's fonts reach it. `viewers.css` is out on purpose — a viewer's
 * interior sizes its own content (the native editor's layers must keep their
 * metrics in step, `NativeEditorMetricsCss.test.ts`).
 *
 * A literal size here is either a drawn mark too small for the scale or a
 * hero number too big for it, and each is named so a new one has to argue.
 */
import { describe, it, expect } from "vitest";
import { readAppStylesheet } from "../helpers/cssCorpus";

const ALLOWED_LITERALS = new Set(["7px", "8px", "21px", "32px"]);

const corpus = () =>
  readAppStylesheet({ exclude: ["viewers.css"] }).replace(/\/\*[\s\S]*?\*\//g, "");

describe("the type scale", () => {
  it("no rule outside the allow-list spells a font size in px", () => {
    const literals = [...corpus().matchAll(/font-size:\s*(\d+(?:\.\d+)?px)/g)].map((m) => m[1]);
    expect(literals.filter((size) => !ALLOWED_LITERALS.has(size))).toEqual([]);
  });

  it("keeps a half-pixel size out of the scale", () => {
    expect(corpus()).not.toMatch(/font-size:\s*\d+\.\d+px/);
  });
});
