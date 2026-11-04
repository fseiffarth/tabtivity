import { beforeEach, describe, expect, it, vi } from "vitest";
import { barHiddenReason, setBoxBarHidden, setProjectBarHidden } from "../../lib/projects/barHidden";
import { useSettingsStore } from "../../stores/settings";
import type { Settings } from "../../types";

describe("barHidden", () => {
  const updateSettings = vi.fn(async () => {});

  beforeEach(() => {
    updateSettings.mockClear();
    useSettingsStore.setState({
      settings: { bar_hidden_projects: ["gone", "a"], bar_hidden_boxes: ["b1"] } as Settings,
      updateSettings,
    });
  });

  it("names why a project is off the strip: itself first, then its first hidden box", () => {
    const hidden = { projects: new Set(["a"]), boxes: new Set(["b2"]) };
    expect(barHiddenReason("a", ["b2"], hidden)).toEqual({ kind: "project" });
    expect(barHiddenReason("c", ["b1", "b2"], hidden)).toEqual({ kind: "box", boxId: "b2" });
    expect(barHiddenReason("c", ["b1"], hidden)).toBeNull();
    expect(barHiddenReason("c", undefined, hidden)).toBeNull();
  });

  it("hides and shows a project, pruning ids no project has any more", async () => {
    await setProjectBarHidden("c", true, new Set(["a", "c"]));
    expect(updateSettings).toHaveBeenLastCalledWith({ bar_hidden_projects: ["a", "c"] });
    await setProjectBarHidden("a", false, new Set(["a", "c"]));
    expect(updateSettings).toHaveBeenLastCalledWith({ bar_hidden_projects: undefined });
  });

  it("hides and shows a box's members", async () => {
    await setBoxBarHidden("b2", true, new Set(["b1", "b2"]));
    expect(updateSettings).toHaveBeenLastCalledWith({ bar_hidden_boxes: ["b1", "b2"] });
    await setBoxBarHidden("b1", false, new Set(["b1", "b2"]));
    expect(updateSettings).toHaveBeenLastCalledWith({ bar_hidden_boxes: undefined });
  });
});
