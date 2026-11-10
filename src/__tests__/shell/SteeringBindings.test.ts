/**
 * The rebindable steering-mode keys (`lib/shortcuts/steeringBindings`): the
 * default table resolves the keys the mode always had, a user list replaces
 * (or, empty, unbinds) an action's keys, conflicts are per level, and the
 * legend's key text follows the bindings.
 */
import { describe, expect, it } from "vitest";
import {
  STEERING_BINDINGS,
  STEERING_BINDING_SECTIONS,
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
    expect(steeringActionFor(ev("Escape"), "panes", null)).toBe("exit");
    expect(steeringActionFor(ev("Escape"), "projects", null)).toBe("exit");
    expect(steeringActionFor(ev("Enter"), "panes", null)).toBe("work");
    expect(steeringActionFor(ev(" "), "panes", null)).toBe("agentPrompt");
    expect(steeringActionFor(ev("i"), "panes", null)).toBeNull();
    expect(steeringActionFor(ev("Escape"), "region", null)).toBe("back");
    expect(steeringActionFor(ev("Enter"), "region", null)).toBe("press");
    expect(steeringActionFor(ev(" "), "region", null)).toBeNull();
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
    expect(steeringActionFor(ev("k"), "panes", null)).toBeNull();
    expect(steeringActionFor(ev("l"), "panes", null)).toBeNull();
    // G is the subagents list now (an agent tab's, but not an agent key).
    expect(steeringActionFor(ev("g"), "panes", null)).toBe("subagents");
    expect(steeringActionFor(ev("g"), "projects", null)).toBeNull();
    expect(steeringActionFor(ev(" "), "panes", null)).toBe("agentPrompt");
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
    expect(steeringRowKeys(["exit", "work"], null)).toBe("Esc / Enter");
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
      expect.arrayContaining(["steering.agentPrompt.label"]),
    );
    expect(gemini).not.toContain("steering.agentClear.label");
    expect(gemini).not.toContain("steering.agentPlan.label");
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

describe("steering bindings Inside a view", () => {
  it("puts the view cycle on Tab at the panes and Inside, not in the projects", () => {
    expect(steeringActionFor(ev("Tab"), "panes", null)).toBe("readerView");
    expect(steeringActionFor(ev("Tab"), "inside", null)).toBe("readerView");
    expect(steeringActionFor(ev("Tab"), "projects", null)).toBeNull();
    expect(steeringActionFor(ev("Tab"), "region", null)).toBeNull();
  });

  it("answers z u o v n with the view actions Inside only", () => {
    const keys = { z: "viewToggle", u: "viewMode", o: "viewOpen", v: "viewOpenAlt", n: "viewNew" } as const;
    for (const [key, action] of Object.entries(keys)) {
      expect(steeringActionFor(ev(key), "inside", null)).toBe(action);
      expect(steeringActionFor(ev(key.toUpperCase()), "inside", null)).toBe(action);
    }
    expect(steeringActionFor(ev("z"), "panes", null)).toBeNull();
    expect(steeringActionFor(ev("z"), "projects", null)).toBeNull();
    // The pane keys of the same letters keep their meaning outside Inside.
    expect(steeringActionFor(ev("n"), "panes", null)).toBe("newShell");
    expect(steeringActionFor(ev("o"), "panes", null)).toBe("newMonitor");
    expect(steeringActionFor(ev("v"), "panes", null)).toBe("files");
    expect(steeringActionFor(ev("u"), "panes", null)).toBe("cockpit");
  });

  it("still resolves the mode-wide and live pane keys Inside, and swallows the dead ones", () => {
    expect(steeringActionFor(ev("e"), "inside", null)).toBe("up");
    expect(steeringActionFor(ev("ArrowRight"), "inside", null)).toBe("right");
    expect(steeringActionFor(ev("Enter"), "inside", null)).toBe("work");
    expect(steeringActionFor(ev(" "), "inside", null)).toBe("agentPrompt");
    expect(steeringActionFor(ev("Escape"), "inside", null)).toBe("exit");
    expect(steeringActionFor(ev("3"), "inside", null)).toBe("slot3");
    // Dead Inside (the handler swallows them), but still resolved to their action.
    expect(steeringActionFor(ev("c"), "inside", null)).toBe("calendar");
    expect(steeringActionFor(ev("w"), "inside", null)).toBe("closeTab");
    expect(steeringActionFor(ev("i"), "inside", null)).toBeNull();
  });

  it("lists an Inside section after the panes in the settings", () => {
    const scopes = STEERING_BINDING_SECTIONS.map((s) => s.scope);
    expect(scopes.indexOf("inside")).toBe(scopes.indexOf("panes") + 1);
    const insideDefs = STEERING_BINDINGS.filter((d) => d.scopes[0] === "inside").map((d) => d.action);
    expect(insideDefs).toEqual(["viewToggle", "viewMode", "viewOpen", "viewOpenAlt", "viewNew"]);
  });

  it("flags an Inside key only against what is live Inside", () => {
    expect(findSteeringConflicts(null).size).toBe(0);
    // Against the mode-wide up key.
    expect(findSteeringConflicts({ viewNew: ["e"] }).get("viewNew")).toEqual(["up"]);
    // Against Work here, which acts Inside.
    expect(findSteeringConflicts({ viewOpen: ["Enter"] }).get("viewOpen")).toEqual(["work"]);
    // Against the view cycle and a slot.
    expect(findSteeringConflicts({ viewMode: ["Tab"] }).get("viewMode")).toEqual(["readerView"]);
    expect(findSteeringConflicts({ viewMode: ["4"] }).get("viewMode")).toEqual(["slot4"]);
    // Mail is dead Inside: no clash.
    expect(findSteeringConflicts({ viewOpen: ["m"] }).size).toBe(0);
    // Two Inside keys on one letter.
    expect(findSteeringConflicts({ viewOpen: ["z"] }).get("viewOpen")).toEqual(["viewToggle"]);
    // The view cycle keeps its panes meeting: rebinding it onto a pane key clashes.
    expect(findSteeringConflicts({ readerView: ["w"] }).get("readerView")).toEqual(["closeTab"]);
  });

  it("lets a user list rebind an Inside key", () => {
    expect(steeringActionFor(ev("y"), "inside", { viewToggle: ["y"] })).toBe("viewToggle");
    expect(steeringActionFor(ev("z"), "inside", { viewToggle: [] })).toBeNull();
  });
});
