import { describe, expect, it } from "vitest";
import { presenceMaps } from "../../stores/phonePresence";

const row = (project_id: string, device_id: string, device_name: string) => ({ project_id, device_id, device_name });

describe("presenceMaps", () => {
  it("marks a project from its screen and from its held tabs, one entry per phone", () => {
    const { byProject, byTmux } = presenceMaps(
      [row("p1", "a", "Pixel")],
      [
        { ...row("p1", "a", "Pixel"), tmux_session: "t1", watched: false },
        { ...row("p2", "b", "iPad"), tmux_session: "t2", watched: false },
        { ...row("p2", "a", "Pixel"), tmux_session: "t3", watched: true },
      ],
    );
    // The screen read counts as watching even though its tab is pocketed.
    expect(byProject.p1).toEqual([{ name: "Pixel", watched: true }]);
    expect(byProject.p2).toEqual([
      { name: "iPad", watched: false },
      { name: "Pixel", watched: true },
    ]);
    expect(byTmux.t1).toEqual([{ name: "Pixel", watched: false }]);
    expect(byTmux.t3).toEqual([{ name: "Pixel", watched: true }]);
  });

  it("is empty when no phone is anywhere", () => {
    expect(presenceMaps([], [])).toEqual({ byProject: {}, byTmux: {} });
  });
});
