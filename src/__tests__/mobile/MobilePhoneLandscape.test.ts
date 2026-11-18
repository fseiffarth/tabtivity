/**
 * A phone held sideways (`PHONE_LANDSCAPE_QUERY` in `mobile-web/src/useTier.ts`
 * and its block in `style.css`): the agent chat spends the width and docks the
 * composer on the right. Pinned here: the query stays a phone's (never a
 * tablet's), its copy in the stylesheet stays equal, and the docking reaches
 * only an agent tab's Chat view.
 */
// @ts-expect-error node:fs has no type declarations in this project (no @types/node)
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PHONE_LANDSCAPE_QUERY, TABLET_QUERY } from "../../../mobile-web/src/useTier";

const CSS: string = readFileSync("mobile-web/src/style.css", "utf8");

function block(): string {
  const start = CSS.indexOf(`@media ${PHONE_LANDSCAPE_QUERY} {`);
  expect(start).toBeGreaterThan(0);
  const end = CSS.indexOf("\n}\n", start);
  return CSS.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, "");
}

function rules(): string[] {
  return block().split("\n").slice(1).map((line) => line.trim()).filter(Boolean);
}

describe("a phone on its side", () => {
  it("is spelled once in the stylesheet, as the hook spells it", () => {
    expect(CSS.split(`@media ${PHONE_LANDSCAPE_QUERY} {`).length).toBe(2);
  });

  it("never overlaps the tablet tiers: they need 600px of height, it stops at 599px", () => {
    expect(TABLET_QUERY).toMatch(/min-height:600px/);
    expect(PHONE_LANDSCAPE_QUERY).toMatch(/max-height:599px/);
    expect(PHONE_LANDSCAPE_QUERY).toMatch(/orientation:landscape/);
    // A portrait phone whose keyboard shrank the viewport reads as landscape;
    // no portrait phone is 560px wide.
    expect(PHONE_LANDSCAPE_QUERY).toMatch(/min-width:560px/);
  });

  it("docks the composer and widens the transcript only in an agent tab's Chat view", () => {
    const scoped = rules().filter((rule) => !rule.startsWith(".terminal-screen > header {"));
    expect(scoped.length).toBeGreaterThan(0);
    for (const rule of scoped) expect(rule, rule).toMatch(/^\.terminal-screen\.agent-tab\[data-view="focus"\]/);
    expect(block()).toMatch(/> \.terminal-controls \{[^}]*grid-column:2/);
  });

  it("lets the field fill the column over the inline height the composer's auto-grow writes", () => {
    expect(block()).toMatch(/\.prompt-composer textarea \{[^}]*height:auto !important/);
  });

  it("invents no colour, so every theme recolours it", () => {
    expect(block()).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
  });
});
