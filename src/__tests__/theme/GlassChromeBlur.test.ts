/**
 * Performance plan §3.5: nothing in the app carries a `backdrop-filter`.
 * WebKitGTK's software path re-blurs a backdrop-filter's region on every repaint
 * beneath it — the tab bars and file sidebar lost theirs first, and the header,
 * menus, dialogs and modal backdrop followed when it made every header hover
 * menu slow to appear and to vanish. To make up for the lost frost, the fills
 * the glass themes read (`--glass-panel`, which `--glass-subheader` mixes over,
 * and `--glass-elevated`) are (near-)opaque, so nothing behind them reads through.
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

  it("never blurs behind anything", () => {
    expect(blurred).toEqual([]);
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

  it("both glass themes give menus and dialogs an opaque fill", () => {
    const elevated = [...CSS.matchAll(/--glass-elevated\s*:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(elevated).toHaveLength(2);
    for (const fill of elevated) expect(fill).toMatch(/^rgb\(/);
  });

  it("the tab bars and the docked file column read that fill", () => {
    expect(CSS).toMatch(/--glass-subheader\s*:\s*color-mix\([^;]*var\(--glass-panel\)\)/);
    expect(CSS).toMatch(/\[data-theme="light_lavender"\] \.subwindow-files\s*\{\s*background:\s*var\(--glass-panel\)/);
  });
});
