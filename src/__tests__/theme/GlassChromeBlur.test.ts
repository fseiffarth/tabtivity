/**
 * Performance plan §3.5: in the glass themes the tab bars and the docked file
 * sidebar carry no `backdrop-filter`. There is one of each per subwindow, all
 * beside live panes, and WebKitGTK's software path re-blurs a backdrop-filter's
 * region on every repaint beneath it. The header (one, static) keeps its frost.
 * To make up for the lost frost, the fill those surfaces read (`--glass-panel`,
 * which `--glass-subheader` mixes over) is near-opaque, so nothing behind them
 * reads through.
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

describe("glass chrome fill without the blur", () => {
  /** Alpha of every `--glass-panel: rgba(…)` a theme declares. */
  const alphas = [...CSS.matchAll(/--glass-panel\s*:\s*rgba\(([^)]*)\)/g)].map((m) =>
    Number(m[1].split(",")[3]),
  );

  it("both glass themes give the unblurred surfaces a near-opaque fill", () => {
    expect(alphas).toHaveLength(2);
    for (const a of alphas) expect(a).toBeGreaterThanOrEqual(0.85);
  });

  it("the tab bars and the docked file column read that fill", () => {
    expect(CSS).toMatch(/--glass-subheader\s*:\s*color-mix\([^;]*var\(--glass-panel\)\)/);
    expect(CSS).toMatch(/\[data-theme="light_lavender"\] \.subwindow-files\s*\{\s*background:\s*var\(--glass-panel\)/);
  });
});
