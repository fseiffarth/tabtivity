import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { BRAND } from "../../lib/brand";
import { forgetInputFrom, noteInputFrom } from "../../lib/agents/inputFrom";

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
});
