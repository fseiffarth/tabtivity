/**
 * The rebindable steering-mode keys (`lib/shortcuts/steeringBindings`): the
 * default table resolves the keys the mode always had, a user list replaces
 * (or, empty, unbinds) an action's keys, conflicts are per level, and the
 * legend's key text follows the bindings.
 */
import { describe, expect, it } from "vitest";
import {
  STEERING_BINDINGS,
  findSteeringConflicts,
  steeringActionFor,
  steeringKeyFromEvent,
  steeringRowKeys,
  steeringSlot,
  steeringSlotKey,
  steeringSlotKeys,
} from "../../lib/shortcuts/steeringBindings";
import { steeringKeysFor, steeringRowLabel, type SteeringLegendState } from "../../lib/shortcuts/shortcuts";

const ev = (key: string, code = "") => ({ key, code });

describe("steering bindings", () => {
  it("resolves the default keys per level", () => {
    expect(steeringActionFor(ev("e"), "panes", null)).toBe("up");
    expect(steeringActionFor(ev("ArrowUp"), "region", null)).toBe("up");
    expect(steeringActionFor(ev("N"), "projects", null)).toBe("newProject");
    expect(steeringActionFor(ev("n"), "panes", null)).toBe("newShell");
    expect(steeringActionFor(ev("n"), "region", null)).toBeNull();
    expect(steeringActionFor(ev("Escape"), "panes", null)).toBe("work");
    expect(steeringActionFor(ev("Escape"), "region", null)).toBe("back");
    expect(steeringActionFor(ev("Enter"), "region", null)).toBe("press");
    expect(steeringActionFor(ev(" "), "region", null)).toBe("exit");
    expect(steeringActionFor(ev("?"), "projects", null)).toBe("help");
    expect(steeringActionFor(ev("="), "panes", null)).toBe("newTabMenu");
  });

  it("keeps mail, calendar and to-do on the same keys on both tab-bar levels", () => {
    for (const context of ["projects", "panes"] as const) {
      expect(steeringActionFor(ev("m"), context, null)).toBe("mail");
      expect(steeringActionFor(ev("c"), context, null)).toBe("calendar");
      expect(steeringActionFor(ev("t"), context, null)).toBe("todo");
    }
    expect(steeringActionFor(ev("o"), "panes", null)).toBe("newMonitor");
    expect(steeringActionFor(ev("m"), "region", null)).toBeNull();
  });

  it("has the agent keys inside a pane only", () => {
    expect(steeringActionFor(ev("k"), "panes", null)).toBe("agentClear");
    expect(steeringActionFor(ev("l"), "panes", null)).toBe("agentPlan");
    expect(steeringActionFor(ev("g"), "panes", null)).toBe("agentGoal");
    expect(steeringActionFor(ev("k"), "projects", null)).toBeNull();
  });

  it("matches a digit slot by physical key too", () => {
    const a = steeringActionFor(ev("&", "Digit1"), "projects", null);
    expect(a).toBe("slot1");
    expect(steeringSlot(a)).toBe(1);
    expect(steeringSlot("up")).toBeNull();
  });

  it("lets a user list replace or unbind an action's keys", () => {
    const map = { up: ["i"], newShell: [], closeTab: ["n"] };
    expect(steeringActionFor(ev("i"), "panes", map)).toBe("up");
    expect(steeringActionFor(ev("e"), "panes", map)).toBeNull();
    expect(steeringActionFor(ev("n"), "panes", map)).toBe("closeTab");
  });

  it("has no conflicts in the default table", () => {
    expect(findSteeringConflicts(null).size).toBe(0);
    expect(new Set(STEERING_BINDINGS.map((d) => d.action)).size).toBe(STEERING_BINDINGS.length);
  });

  it("reports a clash only where both actions are live", () => {
    // N on the projects level (new project) and inside a pane (new shell)
    // never meet; W moved onto the up key does.
    expect(findSteeringConflicts({ closeTab: ["o"] }).get("closeTab")).toEqual(["newMonitor"]);
    expect(findSteeringConflicts({ closeTab: ["m"] }).get("closeTab")).toEqual(["mail"]);
    expect(findSteeringConflicts({ files: ["e"] }).get("files")).toEqual(["up"]);
    expect(findSteeringConflicts({ newProject: ["w"] }).size).toBe(0);
  });

  it("renders the legend's key text from the bindings", () => {
    expect(steeringRowKeys(["left", "right"], null, true)).toBe("S F / ← →");
    expect(steeringRowKeys(["exit", "work"], null)).toBe("Space / Enter / Esc");
    expect(steeringRowKeys(["left", "right"], { left: ["j"], right: ["l"] }, true)).toBe("J L");
    expect(steeringRowKeys(["files"], { files: [] })).toBe("—");
    expect(steeringSlotKeys(null)).toBe("1–9");
    expect(steeringSlotKeys({ slot2: ["y"] })).toBe("1 Y 3 4 5 6 7 8 9");
    expect(steeringSlotKey(2, { slot2: ["y"] })).toBe("Y");
  });

  it("captures bare keys, never a lone modifier", () => {
    expect(steeringKeyFromEvent({ key: "K" })).toBe("k");
    expect(steeringKeyFromEvent({ key: "Escape" })).toBe("Escape");
    expect(steeringKeyFromEvent({ key: "Shift" })).toBeNull();
  });
});

describe("steering legend agent rows", () => {
  const state: SteeringLegendState = {
    level: "tabs",
    sideRegion: false,
    multiPane: false,
    apps: { mail: true, calendar: true, todo: true },
    statusCounts: { decision: 0, working: 0, done: 0 },
  };
  const labels = (s: Partial<SteeringLegendState>) => steeringKeysFor({ ...state, ...s }).map((k) => k.labelKey);

  it("lists the header apps inside a pane too", () => {
    expect(labels({})).toEqual(expect.arrayContaining(["steering.mail.label", "steering.calendar.label", "steering.todo.label"]));
  });

  it("lists Clear / Plan / Goal only for what the active tab takes", () => {
    expect(labels({})).not.toContain("steering.agentClear.label");
    const gemini = labels({ agent: { clear: true, plan: true, goal: false, prompt: true } });
    expect(gemini).toEqual(
      expect.arrayContaining(["steering.agentClear.label", "steering.agentPlan.label", "steering.agentPrompt.label"]),
    );
    expect(gemini).not.toContain("steering.agentGoal.label");
    expect(labels({ level: "projects", agent: { clear: true, plan: true, goal: true, prompt: true } })).not.toContain(
      "steering.agentClear.label",
    );
  });

  it("never lists the same key twice with every row live", () => {
    for (const level of ["panes", "tabs"] as const) {
      const keys = steeringKeysFor({
        ...state,
        level,
        agent: { clear: true, plan: true, goal: true, prompt: true },
        statusCounts: { decision: 1, working: 1, done: 1 },
      }).map((k) => steeringRowLabel(k, null));
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});
