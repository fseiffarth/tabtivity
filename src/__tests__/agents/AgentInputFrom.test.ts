import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { BRAND } from "../../lib/brand";
import { forgetInputFrom, noteInputFrom } from "../../lib/agents/inputFrom";
import { noteTabMessagesHumanInput, setTabMessagesWakeActive } from "../../lib/window/tabsMcp";

describe(`input source — the screen ${BRAND.slug}-send routes to`, () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
  });

  it("reports a change of screen once, not every keystroke", () => {
    noteInputFrom("p:a1", "desktop");
    noteInputFrom("p:a1", "desktop");
    noteInputFrom("p:a1", "phone");
    noteInputFrom("p:a1", "phone");
    noteInputFrom("p:a1", "desktop");
    expect(invoke.mock.calls).toEqual([
      ["pty_input_from", { id: "p:a1", from: "desktop" }],
      ["pty_input_from", { id: "p:a1", from: "phone" }],
      ["pty_input_from", { id: "p:a1", from: "desktop" }],
    ]);
  });

  it("keeps each tab's screen apart", () => {
    noteInputFrom("p:b1", "phone");
    noteInputFrom("p:b2", "phone");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("reports again after a respawn, whose record starts empty", () => {
    noteInputFrom("p:c1", "desktop");
    forgetInputFrom("p:c1");
    noteInputFrom("p:c1", "desktop");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("tries again on the next input when the record was not written", async () => {
    invoke.mockRejectedValueOnce("not a plain folder");
    noteInputFrom("p:d1", "phone");
    await Promise.resolve();
    await Promise.resolve();
    noteInputFrom("p:d1", "phone");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("reports typing to tab messaging only while a project opts in to the wake", () => {
    noteInputFrom("p:d1", "desktop");
    expect(invoke.mock.calls.map((c) => c[0])).toEqual(["pty_input_from"]);
    setTabMessagesWakeActive(true);
    try {
      noteInputFrom("p:d1", "desktop");
      expect(invoke.mock.calls).toContainEqual(["tabs_mcp_human_input", { id: "p:d1" }]);
    } finally {
      setTabMessagesWakeActive(false);
    }
    noteInputFrom("p:d1", "phone");
    expect(invoke.mock.calls.filter((c) => c[0] === "tabs_mcp_human_input")).toHaveLength(1);
  });

  it("throttles the typing report per tab", () => {
    setTabMessagesWakeActive(true);
    try {
      noteTabMessagesHumanInput("p:e1", 10_000);
      noteTabMessagesHumanInput("p:e1", 11_000);
      noteTabMessagesHumanInput("p:e2", 11_000);
      noteTabMessagesHumanInput("p:e1", 12_500);
      expect(invoke.mock.calls).toEqual([
        ["tabs_mcp_human_input", { id: "p:e1" }],
        ["tabs_mcp_human_input", { id: "p:e2" }],
        ["tabs_mcp_human_input", { id: "p:e1" }],
      ]);
    } finally {
      setTabMessagesWakeActive(false);
    }
  });
});
