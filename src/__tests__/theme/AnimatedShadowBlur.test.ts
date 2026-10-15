/**
 * AGENTS.md "Never animate a blurred `box-shadow`": WebKitGTK repaints an
 * animated blurred shadow in software every frame. A glow that pulses is a
 * static shadow on a pseudo-element whose OPACITY animates instead (the
 * onboarding hint bubble, the Alt-drag absorb pulse, the tab landing).
 *
 * Two ways a blurred shadow animates, both scanned over the whole stylesheet
 * corpus:
 * - a `box-shadow` inside `@keyframes`: every layer must have a zero blur
 *   (spread-only rings, like `hint-target-pulse`, stay allowed);
 * - a `transition` that names `box-shadow`: every rule the transitioned one
 *   changes into (selectors that extend it — `:hover`, `.blob-node-active`)
 *   must be blur-free too, or the class change animates the blur.
 */
import { describe, expect, it } from "vitest";
import { readAppStylesheet } from "../helpers/cssCorpus";

const CSS: string = readAppStylesheet().replace(/\/\*[\s\S]*?\*\//g, "");

/** Splits at commas outside parentheses (`color-mix(in srgb, …)` stays whole). */
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

/** The layers of a `box-shadow` value that are (or may be) blurred. A value
 *  this cannot read — a `var()` shadow token — counts as blurred. */
function blurredLayers(value: string): string[] {
  const v = value.replace(/!important/, "").trim();
  if (v === "none" || v === "initial" || v === "unset") return [];
  return splitTopLevel(v).filter((layer) => {
    if (/^var\(/.test(layer)) return true;
    // Drop colour functions, then read the lengths in order: x y [blur [spread]].
    const flat = layer.replace(/[a-z-]+\([^()]*(\([^()]*\)[^()]*)*\)/gi, " ");
    const lengths = flat.split(/\s+/).filter((t) => /^-?[\d.]+(px|em|rem)?$/.test(t));
    return lengths.length >= 3 && parseFloat(lengths[2]) !== 0;
  });
}

function boxShadows(block: string): string[] {
  return [...block.matchAll(/(?:^|[;{\s])box-shadow\s*:\s*([^;}]+)/g)].map((m) => m[1].replace(/\s+/g, " ").trim());
}

/** Every `@keyframes` block, name → body. */
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

interface Rule {
  selectors: string[];
  body: string;
}

/** Every innermost rule outside `@keyframes`. */
function rules(css: string): Rule[] {
  const withoutKeyframes = css.replace(/@keyframes\s+[\w-]+\s*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  const out: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(withoutKeyframes); m; m = re.exec(withoutKeyframes)) {
    const selectors = m[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    out.push({ selectors, body: m[2] });
  }
  return out;
}

describe("no blurred box-shadow animates (WebKitGTK software path)", () => {
  it("reads a shadow's blur", () => {
    expect(blurredLayers("0 0 0 4px var(--accent), 0 0 18px var(--accent)")).toEqual(["0 0 18px var(--accent)"]);
    expect(blurredLayers("inset 0 0 0 1.5px color-mix(in srgb, var(--accent) 22%, transparent)")).toEqual([]);
    expect(blurredLayers("inset 0 -1.5px 0 color-mix(in srgb, var(--x) 62%, transparent)")).toEqual([]);
    expect(blurredLayers("var(--shadow-3)")).toEqual(["var(--shadow-3)"]);
    expect(blurredLayers("none")).toEqual([]);
  });

  it("keyframes animate no blurred box-shadow", () => {
    const frames = keyframes(CSS);
    // A corpus the scanner cannot read would pass vacuously.
    expect(frames.length).toBeGreaterThan(20);
    const offenders = frames.flatMap(({ name, body }) => boxShadows(body).flatMap((v) => blurredLayers(v).map((layer) => `@keyframes ${name}: ${layer}`)));
    expect(offenders).toEqual([]);
  });

  it("no transitioned box-shadow changes into a blurred one", () => {
    const all = rules(CSS);
    const transitioned = all.filter((r) => /(?:^|[;\s])transition(?:-property)?\s*:[^;]*\bbox-shadow\b/.test(r.body));
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

  it("the glows that used to animate their shadow pulse a pseudo-element's opacity", () => {
    const body = (name: string) => keyframes(CSS).find((k) => k.name === name)?.body ?? "";
    for (const name of ["hint-bubble-glow", "drag-group-glow", "tab-land-glow"]) {
      expect(body(name), `@keyframes ${name}`).toMatch(/opacity/);
    }
    for (const name of ["hint-bubble-breathe", "drag-group-absorb", "tab-land"]) {
      expect(body(name), `@keyframes ${name}`).not.toMatch(/box-shadow/);
    }
    const blob = rules(CSS).find((r) => r.selectors.includes(".blob-node") && /transition\s*:/.test(r.body));
    expect(blob?.body).not.toMatch(/box-shadow/);
  });
});
