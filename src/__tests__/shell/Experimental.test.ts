/**
 * The experimental-flag rule (`lib/experimental.ts`): a flag is a tri-state, and
 * explicit always wins — in both directions. *Unset* is off on a profile marked
 * `experimental_explicit`; on an UNMARKED one (not yet migrated) it still means
 * "whatever debug mode says", except for the GPU-sensitive WebGL renderer, which
 * is explicit opt-in everywhere. The unmarked cases below are the old rule.
 */
import { describe, it, expect } from "vitest";
import { experimentalEnabled, EXPERIMENTAL_FLAGS, ON_BY_DEFAULT_FLAGS } from "../../lib/experimental";
import type { Settings } from "../../types";

const s = (o: Partial<Settings>): Settings => o as Settings;

describe("experimentalEnabled", () => {
  it("is off when the flag is unset and debug mode is off", () => {
    expect(experimentalEnabled(s({}), "python_run_debug")).toBe(false);
    expect(experimentalEnabled(s({ debug: false }), "python_run_debug")).toBe(false);
  });

  it("is on when the flag is unset and debug mode is on, while unmarked", () => {
    // Until the migration has written the ticks, a debug profile keeps what it had.
    expect(experimentalEnabled(s({ debug: true }), "python_run_debug")).toBe(true);
    expect(experimentalEnabled(s({ debug: true }), "deck_presenter")).toBe(true);
  });

  it("keeps the WebGL terminal renderer opt-in even in debug mode", () => {
    expect(experimentalEnabled(s({ debug: true }), "terminal_webgl")).toBe(false);
    expect(experimentalEnabled(s({ terminal_webgl: true }), "terminal_webgl")).toBe(true);
  });

  it("keeps GPU compositing opt-in even in debug mode", () => {
    expect(experimentalEnabled(s({ debug: true }), "gpu_compositing")).toBe(false);
    expect(experimentalEnabled(s({ debug: true, experimental_explicit: true }), "gpu_compositing")).toBe(false);
    expect(experimentalEnabled(s({ gpu_compositing: true }), "gpu_compositing")).toBe(true);
  });

  it("lets an explicit value win over debug mode, both ways", () => {
    // Off while in debug mode — "turn this off" must work for the people most
    // likely to hit a broken experiment.
    expect(experimentalEnabled(s({ debug: true, python_run_debug: false }), "python_run_debug"))
      .toBe(false);
    // On without debug mode — an ordinary user can opt into one experiment.
    expect(experimentalEnabled(s({ python_run_debug: true }), "python_run_debug")).toBe(true);
  });

  it("ships mail, Tabby and project remarks on, and nothing else", () => {
    expect([...ON_BY_DEFAULT_FLAGS].sort()).toEqual(["assistant", "mail_client", "project_remarks"]);
    for (const flag of ON_BY_DEFAULT_FLAGS) {
      expect(experimentalEnabled(s({ experimental_explicit: true }), flag)).toBe(true);
      expect(experimentalEnabled(s({ experimental_explicit: true, [flag]: false }), flag)).toBe(false);
      // Not loaded yet still reads as off, so a switched-off flag never flashes in.
      expect(experimentalEnabled(null, flag)).toBe(false);
    }
  });

  it("treats settings that have not loaded yet as off", () => {
    expect(experimentalEnabled(null, "python_run_debug")).toBe(false);
    expect(experimentalEnabled(undefined, "deck_presenter")).toBe(false);
  });

  it("applies the debug default to every flag but the GPU ones, while unmarked", () => {
    for (const flag of EXPERIMENTAL_FLAGS) {
      expect(experimentalEnabled(s({}), flag)).toBe(ON_BY_DEFAULT_FLAGS.includes(flag));
      expect(experimentalEnabled(s({ debug: true }), flag)).toBe(flag !== "terminal_webgl" && flag !== "gpu_compositing");
      expect(experimentalEnabled(s({ debug: true, [flag]: false }), flag)).toBe(false);
    }
  });

  it("turns no flag on through debug mode once the profile is marked", () => {
    for (const flag of EXPERIMENTAL_FLAGS) {
      const marked = { debug: true, experimental_explicit: true };
      expect(experimentalEnabled(s(marked), flag)).toBe(ON_BY_DEFAULT_FLAGS.includes(flag));
      // An explicit value still wins, in both directions.
      expect(experimentalEnabled(s({ ...marked, [flag]: true }), flag)).toBe(true);
      expect(experimentalEnabled(s({ ...marked, [flag]: false }), flag)).toBe(false);
      expect(experimentalEnabled(s({ experimental_explicit: true, [flag]: true }), flag)).toBe(true);
    }
  });

  it("treats a false marker as no marker", () => {
    expect(
      experimentalEnabled(s({ debug: true, experimental_explicit: false }), "web_browser"),
    ).toBe(true);
  });
});
