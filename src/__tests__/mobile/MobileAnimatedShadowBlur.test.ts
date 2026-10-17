/**
 * AGENTS.md "Never animate a blurred `box-shadow`", for the phone's own
 * stylesheets. `theme/AnimatedShadowBlur` scans the desktop corpus
 * (`styles/index.css`'s imports) and never reads `mobile-web/src/`, yet the
 * phone runs on WebKit too (iOS Safari, the installed PWA) and its Home and
 * project screens carry the shadows most tempting to animate: a card's lift,
 * a FAB, a lamp's glow. A glow that pulses is a static shadow on a
 * pseudo-element whose opacity animates.
 *
 * The same two ways a blurred shadow animates:
 * - a `box-shadow` inside `@keyframes` with a blurred layer;
 * - a `transition` naming `box-shadow` (or `all`) on a rule whose selector a
 *   blurred-shadow rule extends, so the class change animates the blur.
 */
// @ts-expect-error node:fs has no type declarations in this project (no @types/node)
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SHEETS = ["mobile-web/src/style.css", "mobile-web/src/themes.css"];
const CSS: string = SHEETS.map((file) => readFileSync(file, "utf8") as string).join("\n").replace(/\/\*[\s\S]*?\*\//g, "");

/** Splits at commas outside parentheses. */
function splitTopLevel(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(value.slice(start, i));
      start = i + 1;
    }
  }
  out.push(value.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** The layers of a `box-shadow` value that are (or may be) blurred; a `var()`
 *  shadow counts as blurred. */
function blurredLayers(value: string): string[] {
  const v = value.replace(/!important/, "").trim();
  if (v === "none" || v === "initial" || v === "unset") return [];
  return splitTopLevel(v).filter((layer) => {
    if (/^var\(/.test(layer)) return true;
    const flat = layer.replace(/[a-z-]+\([^()]*(\([^()]*\)[^()]*)*\)/gi, " ");
    const lengths = flat.split(/\s+/).filter((t) => /^-?[\d.]+(px|em|rem)?$/.test(t));
    return lengths.length >= 3 && parseFloat(lengths[2]) !== 0;
  });
}

function boxShadows(block: string): string[] {
  return [...block.matchAll(/(?:^|[;{\s])box-shadow\s*:\s*([^;}]+)/g)].map((m) => m[1].replace(/\s+/g, " ").trim());
}

function keyframes(css: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  const re = /@keyframes\s+([\w-]+)\s*\{/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    let depth = 1;
    let i = re.lastIndex;
    while (depth > 0 && i < css.length) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    out.push({ name: m[1], body: css.slice(re.lastIndex, i - 1) });
  }
  return out;
}

/** Every innermost rule outside `@keyframes`. */
function rules(css: string): Array<{ selectors: string[]; body: string }> {
  const withoutKeyframes = css.replace(/@keyframes\s+[\w-]+\s*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  const out: Array<{ selectors: string[]; body: string }> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(withoutKeyframes); m; m = re.exec(withoutKeyframes)) {
    out.push({ selectors: m[1].split(",").map((s) => s.trim()).filter(Boolean), body: m[2] });
  }
  return out;
}

describe("the phone's stylesheets animate no blurred box-shadow", () => {
  it("reads the sheets it guards", () => {
    // A corpus the scanner cannot read would pass vacuously.
    expect(keyframes(CSS).length).toBeGreaterThan(5);
    expect(rules(CSS).length).toBeGreaterThan(500);
  });

  it("keyframes animate no blurred box-shadow", () => {
    const offenders = keyframes(CSS).flatMap(({ name, body }) => boxShadows(body).flatMap((v) => blurredLayers(v).map((layer) => `@keyframes ${name}: ${layer}`)));
    expect(offenders).toEqual([]);
  });

  it("no transitioned box-shadow changes into a blurred one", () => {
    const all = rules(CSS);
    const transitioned = all.filter((r) => /(?:^|[;\s])transition(?:-property)?\s*:[^;]*\b(?:box-shadow|all)\b/.test(r.body));
    const offenders: string[] = [];
    for (const rule of transitioned) {
      for (const base of rule.selectors) {
        for (const other of all) {
          if (!other.selectors.some((s) => s.startsWith(base))) continue;
          for (const value of boxShadows(other.body)) {
            for (const layer of blurredLayers(value)) offenders.push(`${base} → ${other.selectors.join(", ")}: ${layer}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
