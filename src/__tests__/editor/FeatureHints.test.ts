// The feature-hint catalogue (`lib/shortcuts/featureHints.ts`): ~100 tips, each
// pointing at a control by CSS selector. A selector rots silently when chrome is
// renamed (the hint just never shows), so this gate checks every class and
// `data-hint-anchor` the catalogue names still exists in the source.
import { describe, expect, it } from "vitest";
// @ts-expect-error node:fs has no type declarations in this project (no @types/node)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { enSource } from "../../lib/i18n";
import { FEATURE_HINTS, type FeatureHintSpec } from "../../lib/shortcuts/featureHints";
import { HINTS, pickHint, type HintCtx } from "../../lib/shortcuts/hints";

// vitest runs from the repo root (the untested-register gate relies on that too).
const SRC = "src";

function sourceText(): string {
  const parts: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir) as string[]) {
      if (name === "__tests__" || name === "i18n") continue;
      const full = `${dir}/${name}`;
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(tsx?|css)$/.test(name)) parts.push(readFileSync(full, "utf8") as string);
    }
  };
  walk(SRC);
  return parts.join("\n");
}

const active: HintCtx = { projectCount: 1, activeId: "p1" };
const dict = enSource as Record<string, string>;

describe("the feature-hint catalogue", () => {
  it("has about a hundred hints with unique ids", () => {
    const ids = FEATURE_HINTS.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(90);
    expect(new Set(HINTS.map((h) => h.id)).size).toBe(HINTS.length);
  });

  it("has English copy for every hint, using only known placeholders", () => {
    for (const { id } of FEATURE_HINTS) {
      for (const part of ["title", "body"]) {
        const text = dict[`hint.f.${id}.${part}`];
        expect(text, `hint.f.${id}.${part} is missing from en.ts`).toBeTruthy();
        const placeholders = (text.match(/\{[^}]*\}/g) ?? []).filter((p) => p !== "{app}" && p !== "{slug}");
        expect(placeholders, `${id} ${part} has an unknown placeholder`).toEqual([]);
      }
      expect(dict[`hint.f.${id}.body`].length, `${id} body is too long for a bubble`).toBeLessThanOrEqual(260);
    }
  });

  it("points only at classes and anchors that still exist in the source", () => {
    const text = sourceText();
    for (const { id, anchor } of FEATURE_HINTS) {
      for (const [, cls] of anchor.matchAll(/\.([A-Za-z0-9_-]+)/g)) {
        expect(text.includes(cls), `${id}: no component or stylesheet mentions .${cls}`).toBe(true);
      }
      for (const [, value] of anchor.matchAll(/data-hint-anchor="([^"]+)"/g)) {
        expect(text.includes(`data-hint-anchor="${value}"`), `${id}: nothing carries data-hint-anchor="${value}"`).toBe(true);
      }
    }
  });
});

describe("pickHint with feature hints", () => {
  const seenCore = new Set(["add-tab", "toggle-panels", "file-tree", "create-project"]);

  it("never offers a feature hint without a way to look at the screen", () => {
    expect(pickHint(active, seenCore, true)).toBeNull();
  });

  it("offers one only while its anchor is on screen", () => {
    const onScreen = (sel: string) => sel === ".cal-sidebar";
    expect(pickHint(active, seenCore, true, { anchorOnScreen: onScreen })).toBe("cal-caldav");
    expect(pickHint(active, seenCore, true, { anchorOnScreen: () => false })).toBeNull();
  });

  it("holds feature hints back when the session cap or gap says so", () => {
    expect(pickHint(active, seenCore, true, { anchorOnScreen: () => true, allowFeature: false })).toBeNull();
  });

  it("ranks what is open now above always-on chrome", () => {
    const picked = pickHint(active, seenCore, true, { anchorOnScreen: () => true });
    const spec = (FEATURE_HINTS as readonly FeatureHintSpec[]).find((h) => h.id === picked);
    expect(spec).toBeDefined();
    expect(spec?.ambient).toBeFalsy();
  });

  it("skips seen hints and falls through the catalogue", () => {
    const seen = new Set(seenCore);
    const order: string[] = [];
    for (let i = 0; i < FEATURE_HINTS.length; i++) {
      const next = pickHint(active, seen, true, { anchorOnScreen: () => true });
      if (!next) break;
      order.push(next);
      seen.add(next);
    }
    expect(order.length).toBe(FEATURE_HINTS.length);
    expect(pickHint(active, seen, true, { anchorOnScreen: () => true })).toBeNull();
  });

  it("still lets an anchored onboarding hint wait for its anchor", () => {
    expect(pickHint(active, new Set(), true, { anchorOnScreen: () => false })).toBe("toggle-panels");
  });
});
