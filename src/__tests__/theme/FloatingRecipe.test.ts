/**
 * The floating recipe (apps.css): one paint for every surface. The shape of the
 * failure is a member present in one list and not the others, which shows as a
 * single menu with a square corner, or a glass theme's menu going untinted. The
 * cut stays a paint: a `clip-path` on these would take the elevation shadow off
 * and cut whatever hangs outside a surface.
 */
import { describe, it, expect } from "vitest";
import { readAppStylesheet } from "../helpers/cssCorpus";

const MEMBERS = [
  "project-dialog", "settings-dialog", "stats-dialog", "file-delete-dialog",
  "context-menu", "tab-new-menu", "project-switcher-add-menu", "box-chip-menu",
  "project-search-popover", "file-run-args", "file-viewer-run-args", "git-change-tree",
  "presentation-settings", "cal-alarm-popup", "project-pill-popup", "project-switch-toast",
  "hint-bubble",
];

const css = readAppStylesheet({ exclude: ["reset.css"] }).replace(/\/\*[\s\S]*?\*\//g, "");

/** The selector list of the first rule whose body holds `needle`. */
function selectorsOf(needle: string): string {
  const at = css.indexOf(needle);
  expect(at, needle).toBeGreaterThan(-1);
  const open = css.lastIndexOf("{", at);
  const close = css.lastIndexOf("}", open);
  return css.slice(close + 1, open);
}

describe("the floating recipe", () => {
  const fill = selectorsOf("--surface-rail: 2px");
  const wash = selectorsOf("inset: calc(-1 * var(--surface-rail)) 0 0");

  it.each(MEMBERS)("%s carries the fill and the wash", (member) => {
    expect(fill).toContain(`.${member}`);
    expect(wash).toContain(`.${member}::before`);
  });

  it("every member takes the glass fill in both glass themes", () => {
    const glassRules = [...css.matchAll(/([^{}]+)\{\s*--surface-fill: var\(--glass-elevated\)/g)]
      .map((m) => m[1])
      .join(",");
    for (const member of MEMBERS) {
      expect(glassRules).toContain(`[data-theme="fancy_dark"] .${member}`);
      expect(glassRules).toContain(`[data-theme="light_lavender"] .${member}`);
    }
  });

  it("no member paints a background of its own over the recipe", () => {
    for (const member of MEMBERS) {
      expect(css).not.toMatch(new RegExp(`(^|[\\s,}])\\.${member}\\s*\\{(?![^}]*--surface-fill)[^}]*\\bbackground(-color)?:`));
    }
  });

  it("never cuts with a clip-path, which would take the shadow", () => {
    for (const member of MEMBERS) {
      expect(css).not.toMatch(new RegExp(`\\.${member}\\s*\\{[^}]*clip-path`));
    }
  });

  it("shades a hover card with a drop-shadow, so its cuts are not left pale", () => {
    // A box-shadow is a rectangle that stops at the element's own box: each painted
    // cut then shows a pale triangle against the darkened rim around it.
    expect(css).toMatch(/:root:root \.project-pill-popup\s*\{\s*box-shadow:\s*none;\s*filter:\s*var\(--shadow-2-drop\)/);
    const blocks = [...css.matchAll(/--shadow-2:\s*0 4px 16px/g)].length;
    expect(blocks).toBeGreaterThan(0);
    expect([...css.matchAll(/--shadow-2-drop:\s*drop-shadow\(/g)].length).toBe(blocks);
  });

  it("zeroes the motion tokens once, past the theme blocks", () => {
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*:root:root\s*\{[^}]*--motion-exit: 0ms/);
  });
});
