/**
 * One keyboard focus ring (base.css), reading a token the Customizer can move.
 * The xterm helper textarea holds focus whenever a terminal is active and must
 * never wear it. A component's own focus rule is for a ring drawn inside; any
 * ring it does draw reads --focus-ring, not the accent.
 */
import { describe, it, expect } from "vitest";
import { readAppStylesheet } from "../helpers/cssCorpus";

const css = readAppStylesheet({ exclude: ["reset.css"] }).replace(/\/\*[\s\S]*?\*\//g, "");

describe("the focus ring", () => {
  it("is one rule that leaves the xterm textarea alone", () => {
    expect(css).toMatch(
      /:where\(button, a, input, select, textarea, \[tabindex\]\):focus-visible:focus-visible \{\s*outline: 2px solid var\(--focus-ring\);\s*outline-offset: 2px;/,
    );
    expect(css).toMatch(/\.xterm-helper-textarea:focus-visible:focus-visible \{\s*outline: none;/);
  });

  it("no focus rule rings a control in the bare accent", () => {
    const rules = [...css.matchAll(/([^{}]*:focus-visible[^{}]*)\{([^}]*)\}/g)];
    const bare = rules.filter((rule) => /outline:[^;]*var\(--accent\)/.test(rule[2])).map((rule) => rule[1].trim());
    expect(bare).toEqual([]);
  });
});
