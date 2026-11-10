/**
 * The legend's side of the Reader view cycle: the Tab row only on a tab with a
 * view strip, the Inside rows that follow the shown view, and the ladder's
 * lit "Inside" rung naming it (`shortcuts.ts`, `steeringBar.ts`).
 */
import { describe, expect, it } from "vitest";
import { STEERING_KEYS, steeringKeysFor, steeringRowLabel, type SteeringLegendState } from "../../lib/shortcuts/shortcuts";
import { ladder } from "../../lib/shortcuts/steeringBar";
import { STEERING_BINDINGS } from "../../lib/shortcuts/steeringBindings";
import type { ReaderViewId } from "../../lib/agents/readerSteering";

const base: SteeringLegendState = {
  level: "tabs",
  sideRegion: false,
  multiPane: false,
  apps: { mail: false, calendar: false, todo: false },
  terminal: true,
  agent: { clear: true, plan: true, goal: true, prompt: true },
  statusCounts: { decision: 0, working: 0, done: 0 },
};
const rows = (s: Partial<SteeringLegendState>) => steeringKeysFor({ ...base, ...s });
const labels = (s: Partial<SteeringLegendState>) => rows(s).map((k) => k.labelKey);
const reader = (view: ReaderViewId) => ({ view });

describe("the Reader view cycle's legend row", () => {
  it("is listed only on a tab with a view strip", () => {
    expect(labels({})).not.toContain("steering.readerView.label");
    for (const view of ["chat", "changes", "files", "terminal"] as const) {
      for (const level of ["panes", "tabs", "scroll"] as const) {
        expect(labels({ level, reader: reader(view) })).toContain("steering.readerView.label");
      }
    }
    expect(labels({ level: "projects", reader: reader("chat") })).not.toContain("steering.readerView.label");
  });

  it("reads plain Tab, not Shift+Tab", () => {
    const row = rows({ reader: reader("chat") }).find((k) => k.labelKey === "steering.readerView.label")!;
    expect(row.shift).toBeUndefined();
    expect(steeringRowLabel(row, null)).toBe("Tab");
    expect(steeringRowLabel(row, { readerView: ["i"] })).toBe("I");
  });
});

describe("the Reader's view in the legend", () => {
  it("keeps the terminal rows for the Chat and Terminal views", () => {
    for (const view of ["chat", "terminal"] as const) {
      expect(labels({ level: "tabs", reader: reader(view) })).toContain("steering.intoTerminal.label");
      expect(labels({ level: "tabs", reader: reader(view) })).not.toContain("steering.intoReader.label");
      const inside = labels({ level: "scroll", reader: reader(view) });
      expect(inside).toEqual(expect.arrayContaining(["steering.scroll.label", "steering.scrollLive.label", "steering.scrollOut.label"]));
    }
  });

  it("swaps the way in and the terminal's scroll rows for the view's own on Diffs and Files", () => {
    for (const view of ["changes", "files"] as const) {
      const tabs = labels({ level: "tabs", reader: reader(view) });
      expect(tabs).toContain("steering.intoReader.label");
      expect(tabs).not.toContain("steering.intoTerminal.label");
      const inside = labels({ level: "scroll", reader: reader(view) });
      for (const gone of ["steering.scroll.label", "steering.scrollLive.label", "steering.scrollOut.label", "steering.scrollEnd.label"]) {
        expect(inside).not.toContain(gone);
      }
      // Work here and the prompt keep their rows.
      expect(inside).toEqual(expect.arrayContaining(["steering.work.label", "steering.agentPrompt.label", "steering.readerView.label"]));
    }
  });

  it("offers no way in over a document tab or with no terminal", () => {
    const l = labels({ level: "tabs", terminal: false, document: true });
    expect(l).not.toContain("steering.intoReader.label");
    expect(l).toContain("steering.intoDocument.label");
  });
});

describe("the ladder's Inside rung", () => {
  const lit = (reader?: { view: ReaderViewId }, document?: boolean) =>
    ladder({ level: "scroll", region: null, regionReturn: "tabs", reader, document })
      .filter((r) => r.lit)
      .map((r) => r.labelKey);

  it("names the shown view", () => {
    expect(lit(reader("chat"))).toEqual(["steering.level.scrollChat"]);
    expect(lit(reader("changes"))).toEqual(["steering.level.scrollChanges"]);
    expect(lit(reader("files"))).toEqual(["steering.level.scrollFiles"]);
  });

  it("keeps the terminal and document names", () => {
    expect(lit(reader("terminal"))).toEqual(["steering.level.scroll"]);
    expect(lit(undefined)).toEqual(["steering.level.scroll"]);
    expect(lit(undefined, true)).toEqual(["steering.level.scrollDocument"]);
  });

  it("leaves the other rungs alone", () => {
    const rungs = ladder({ level: "tabs", region: null, regionReturn: "tabs", reader: reader("changes") });
    expect(rungs.find((r) => r.id === "scroll")?.labelKey).toBe("steering.bar.inside");
    expect(rungs.find((r) => r.lit)?.id).toBe("tabs");
  });
});

describe("the table", () => {
  it("has no two tab-level rows with the same actions and label under one first level (the cheat sheet key)", () => {
    const keys = STEERING_KEYS.filter((k) => k.levels[0] !== "region").map((k) => `${k.levels[0]}|${k.actions.join(",")}|${k.labelKey}`);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  });

  it("gives every Inside binding a settings label", () => {
    const labelsOfInside = STEERING_BINDINGS.filter((d) => d.scopes[0] === "inside").map((d) => d.labelKey);
    expect(labelsOfInside).toEqual([
      "steering.viewToggle.label",
      "steering.viewMode.label",
      "steering.viewOpen.label",
      "steering.viewOpenAlt.label",
      "steering.viewNew.label",
    ]);
  });
});
