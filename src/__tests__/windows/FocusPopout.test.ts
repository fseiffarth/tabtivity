import { describe, expect, it } from "vitest";
import { nextPopoutLabel } from "../../lib/window/focusPopout";
import { steeringActionFor } from "../../lib/shortcuts/steeringBindings";
import { steeringKeysFor, type SteeringLegendState } from "../../lib/shortcuts/shortcuts";

describe("steering J — raise a popout", () => {
  it("takes the first popout, then each next one, wrapping", () => {
    const labels = ["detached-a", "detached-b", "detached-c"];
    expect(nextPopoutLabel(labels, undefined)).toBe("detached-a");
    expect(nextPopoutLabel(labels, "detached-a")).toBe("detached-b");
    expect(nextPopoutLabel(labels, "detached-c")).toBe("detached-a");
    // The last one raised was docked back: start over.
    expect(nextPopoutLabel(labels, "detached-gone")).toBe("detached-a");
    expect(nextPopoutLabel([], undefined)).toBeNull();
  });

  it("J is the popout key on every tab-bar level", () => {
    const j = { key: "j", code: "KeyJ" };
    expect(steeringActionFor(j, "projects", null)).toBe("popout");
    expect(steeringActionFor(j, "panes", null)).toBe("popout");
  });

  it("the legend lists it only while the project has a popout", () => {
    const base: SteeringLegendState = {
      level: "panes",
      sideRegion: false,
      multiPane: false,
      apps: { mail: false, calendar: false, todo: false },
      statusCounts: { decision: 0, working: 0, done: 0 },
    };
    const has = (s: SteeringLegendState) => steeringKeysFor(s).some((k) => k.actions.includes("popout"));
    expect(has(base)).toBe(false);
    expect(has({ ...base, popouts: true })).toBe(true);
  });
});
