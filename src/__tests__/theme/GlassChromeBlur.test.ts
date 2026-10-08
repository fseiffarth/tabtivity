/**
 * Performance plan §3.5: in the glass themes the tab bars and the docked file
 * sidebar carry no `backdrop-filter`. There is one of each per subwindow, all
 * beside live panes, and WebKitGTK's software path re-blurs a backdrop-filter's
 * region on every repaint beneath it. The header (one, static) keeps its frost.
 */
import { describe, it, expect } from "vitest";
import { readAppStylesheet } from "../helpers/cssCorpus";

const CSS: string = readAppStylesheet().replace(/\/\*[\s\S]*?\*\//g, "");

/** Selectors of every rule whose block sets a (prefixed or not) backdrop-filter other than `none`. */
function blurredSelectors(css: string): string[] {
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    const decl = /(?:^|;)\s*(?:-webkit-)?backdrop-filter\s*:\s*([^;]+)/.exec(m[2]);
    if (!decl || decl[1].trim() === "none") continue;
    out.push(...m[1].split(",").map((s) => s.trim()));
  }
  return out;
}

describe("glass chrome blur", () => {
  const blurred = blurredSelectors(CSS);

  it("never blurs behind a tab bar or the docked file sidebar", () => {
    const offenders = blurred.filter((s) => /\.tab-bar\b|\.subwindow-files\b/.test(s));
    expect(offenders).toEqual([]);
  });

  it("keeps the header's frost in both glass themes", () => {
    expect(blurred).toContain('[data-theme="fancy_dark"] .app-header');
    expect(blurred).toContain('[data-theme="light_lavender"] .app-header');
  });
});
