/**
 * The legend's rows for steering Inside the Reader's Diffs view (the
 * `inside Diffs` block of `STEERING_KEYS`) and their keys.
 */
import { describe, expect, it } from "vitest";
import { steeringKeysFor, steeringRowLabel, type SteeringLegendState } from "../../lib/shortcuts/shortcuts";
import { enSource as en } from "../../lib/i18n/en";

const base: SteeringLegendState = {
  level: "scroll",
  sideRegion: false,
  multiPane: false,
  apps: { mail: false, calendar: false, todo: false },
  terminal: true,
  agent: { clear: true, plan: true, goal: true, prompt: true },
  statusCounts: { decision: 0, working: 0, done: 0 },
  reader: { view: "changes" },
};
const diffsRows = (s: Partial<SteeringLegendState> = {}) =>
  steeringKeysFor({ ...base, ...s }).filter((k) => k.labelKey.startsWith("steering.changes."));

describe("the Diffs Inside legend rows", () => {
  it("lists the eight rows with their default keys on the Inside level of a Diffs view", () => {
    const shown = diffsRows().map((k) => [k.labelKey, steeringRowLabel(k, null)]);
    expect(shown).toEqual([
      ["steering.changes.scroll.label", "S F / ← →"],
      ["steering.changes.card.label", "E D / ↑ ↓"],
      ["steering.changes.file.label", "Shift+E D / ↑ ↓"],
      ["steering.changes.fold.label", "Z"],
      ["steering.changes.new.label", "N"],
      ["steering.changes.layout.label", "U"],
      ["steering.changes.open.label", "O"],
      ["steering.changes.openDiff.label", "V"],
    ]);
  });

  it("follows a rebound key", () => {
    const row = diffsRows().find((k) => k.labelKey === "steering.changes.fold.label")!;
    expect(steeringRowLabel(row, { viewToggle: ["x"] })).toBe("X");
  });

  it("is hidden on the other views, levels and tabs without a strip", () => {
    for (const view of ["chat", "files", "terminal"] as const) expect(diffsRows({ reader: { view } })).toEqual([]);
    expect(diffsRows({ reader: undefined })).toEqual([]);
    expect(diffsRows({ level: "tabs" })).toEqual([]);
    expect(diffsRows({ level: "panes" })).toEqual([]);
  });

  it("describes each row as Diffs-only and keeps Work here and the prompt", () => {
    for (const row of diffsRows()) {
      expect((en as Record<string, string>)[row.descKey]).toMatch(/^In Diffs, /);
    }
    const all = steeringKeysFor({ ...base }).map((k) => k.labelKey);
    expect(all).toEqual(expect.arrayContaining(["steering.work.label", "steering.agentPrompt.label"]));
  });
});
