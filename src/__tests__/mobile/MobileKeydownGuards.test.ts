/**
 * Keyboard steering swallows a key by calling `preventDefault` on its keydown
 * (never `stopPropagation`), so every other keydown handler on the phone must
 * look at `defaultPrevented` first or both would act on one key. A source scan,
 * so a handler added later is held to it. The engine itself and the Tab-only
 * focus trap are the two exceptions; the surfaces that own their keys are named
 * by class in the engine, and those classes must still exist.
 */
import { describe, expect, it } from "vitest";
// @ts-expect-error node:fs has no type declarations
import { readFileSync, readdirSync, statSync } from "node:fs";
// @ts-expect-error node:path has no type declarations
import { join, relative, sep } from "node:path";
import { OWN_KEYS_SELECTOR } from "../../../mobile-web/src/steering/steeringDom";

declare const process: { cwd(): string };

const SRC: string = join(process.cwd(), "mobile-web", "src");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir) as string[]) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

const rel = (path: string) => relative(SRC, path).split(sep).join("/");
const EXEMPT = (path: string) => rel(path).startsWith("steering/") || rel(path) === "modalFocus.ts";

describe("Mobile keydown handlers honor a key steering swallowed", () => {
  const LISTENER = /addEventListener\(\s*["']keydown["']\s*,\s*([A-Za-z_$][\w$]*)/g;

  it("every keydown listener reads defaultPrevented in its handler", () => {
    const missing: string[] = [];
    let found = 0;
    for (const path of sources(SRC)) {
      if (EXEMPT(path)) continue;
      const text: string = readFileSync(path, "utf8");
      for (const match of text.matchAll(LISTENER)) {
        found += 1;
        const name = match[1];
        const start = text.lastIndexOf(`const ${name} =`, match.index);
        const handler = start >= 0 ? text.slice(start, match.index) : "";
        if (!handler.includes("defaultPrevented")) missing.push(`${rel(path)}: ${name}`);
      }
    }
    expect(found).toBeGreaterThan(5);
    expect(missing).toEqual([]);
  });

  it("no keydown listener is added inline (the scan above must see its handler)", () => {
    const inline: string[] = [];
    for (const path of sources(SRC)) {
      if (EXEMPT(path)) continue;
      const text: string = readFileSync(path, "utf8");
      if (/addEventListener\(\s*["']keydown["']\s*,\s*(?:\(|function|async)/.test(text)) inline.push(rel(path));
    }
    expect(inline).toEqual([]);
  });

  it("the grip's React onKeyDown (rowDrag) reads defaultPrevented", () => {
    const text: string = readFileSync(join(SRC, "rowDrag.ts"), "utf8");
    expect(text.slice(text.indexOf("onKeyDown: (event) =>"))).toContain("defaultPrevented");
  });

  it("only the steering engine and the Tab trap swallow keys or stop them", () => {
    for (const path of sources(SRC)) {
      const text: string = readFileSync(path, "utf8");
      if (rel(path).startsWith("steering/")) expect(text, rel(path)).not.toMatch(/\.stopPropagation\(\)|stopImmediatePropagation/);
    }
  });

  it("every class in OWN_KEYS_SELECTOR still names a surface in the sources", () => {
    const classes = OWN_KEYS_SELECTOR.split(",").map((part) => part.trim().replace(/^\./, ""));
    expect(classes.length).toBeGreaterThan(0);
    const all = sources(SRC).filter((path) => !rel(path).startsWith("steering/")).map((path) => readFileSync(path, "utf8") as string);
    for (const name of classes) {
      expect(all.some((text) => new RegExp(`["'\`\\s]${name}["'\`\\s]`).test(text)), name).toBe(true);
    }
  });
});
