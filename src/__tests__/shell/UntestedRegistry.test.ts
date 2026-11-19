// The untested register (`lib/untested`) is only worth having if it is
// complete: a pill whose id has no row cannot be cleared from one place, and a
// row no call site uses is a feature someone already deleted, left behind to
// make the list lie about how much is unverified.
//
// `scripts/untested.mjs check` is the one implementation of that audit — the
// CLI and this gate ask it the same question rather than keeping two scanners
// that can drift apart.
import { describe, expect, it } from "vitest";
// @ts-expect-error node:child_process has no type declarations in this project (no @types/node)
import { spawnSync } from "node:child_process";
import { UNTESTED, isUntested, setUntestedTagsVisible, untestedEntries, type UntestedEntry } from "../../lib/untested";

describe("the untested register", () => {
  it("matches the pills in the source", () => {
    const run = spawnSync("node", ["scripts/untested.mjs", "check"], { encoding: "utf8" });
    expect(run.stderr ?? "", "the audit itself failed to run").toBe("");
    expect(run.status, `\n${run.stdout}`).toBe(0);
  });

  it("describes every row well enough to find it again", () => {
    for (const row of untestedEntries()) {
      expect(row.area, `${row.id} has no area`).toMatch(/^[a-z]+$/);
      expect(row.what.length, `${row.id} has no description`).toBeGreaterThan(3);
      if (row.tested) expect(row.tested, `${row.id} has a non-ISO date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("hides a pill once its row is stamped tested", () => {
    const row = untestedEntries().find((r) => !r.tested);
    expect(row, "the register has no row still tagged").toBeDefined();
    const id = row!.id;
    // `as const` freezes the type, not the object: stamp the live row the way
    // `npm run untested -- tested` does, and put it back afterwards.
    const live = (UNTESTED as Record<string, UntestedEntry>)[id];
    try {
      expect(isUntested(id)).toBe(true);
      live.tested = "2026-01-01";
      expect(isUntested(id)).toBe(false);
      delete live.tested;
      expect(isUntested(id)).toBe(true);
    } finally {
      delete live.tested;
    }
    expect(isUntested(undefined)).toBe(false);
    expect(isUntested(false)).toBe(false);
  });

  it("keeps an unknown id visible rather than silently clearing it", () => {
    expect(isUntested("nothing.claims.this.id")).toBe(true);
    expect(Object.keys(UNTESTED).length).toBeGreaterThan(100);
  });

  it("hides every registered and unknown tag when visibility is off", () => {
    try {
      setUntestedTagsVisible(false);
      expect(isUntested("nothing.claims.this.id")).toBe(false);
      expect(isUntested(untestedEntries()[0].id)).toBe(false);
    } finally {
      setUntestedTagsVisible(true);
    }
  });
});
