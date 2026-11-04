/**
 * Keyboard steering (`stores/keyboardSteering`): the mode is transient and
 * imperative, and `projectStations` is the ONE ring behind project cycling,
 * the steering digits and the pill badges — root leads it, inactive projects
 * are out, and the rest follow pill display order (`position`), never the
 * store's array order.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { projectStations, useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { useProjectsStore } from "../../stores/projects";
import { useBoxesStore } from "../../stores/boxes";
import { resetBoxSlice, useBoxSliceStore } from "../../stores/boxSlice";
import { useTabsStore } from "../../stores/tabs";
import type { ProjectEntry } from "../../types";

function project(id: string, position: number, status = "active"): ProjectEntry {
  return { id, name: id, status, position, local_file: `/p/${id}/project.json` };
}

beforeEach(() => {
  useKeyboardSteeringStore.setState({ active: false });
  useProjectsStore.setState({ projects: [] });
  useBoxesStore.setState({ boxes: [] });
  resetBoxSlice();
  useTabsStore.setState({ scope: "root" });
});

describe("mode", () => {
  it("enters and exits without anything else in the store", () => {
    useKeyboardSteeringStore.getState().enter();
    expect(useKeyboardSteeringStore.getState().active).toBe(true);
    useKeyboardSteeringStore.getState().exit();
    expect(useKeyboardSteeringStore.getState().active).toBe(false);
  });
});

describe("projectStations", () => {
  it("leads with the root terminal even when there are no projects", () => {
    expect(projectStations()).toEqual([null]);
  });

  it("orders by pill position and leaves inactive projects out", () => {
    useProjectsStore.setState({
      projects: [project("c", 2), project("z", 5, "inactive"), project("a", 0, "current"), project("b", 1)],
    });
    expect(projectStations()).toEqual([null, "a", "b", "c"]);
  });

  describe("inside a box slice", () => {
    beforeEach(() => {
      useProjectsStore.setState({
        projects: [
          project("a", 0),
          project("b", 1, "inactive"),
          project("c", 2),
          project("d", 3),
          project("e", 4, "inactive"),
        ],
      });
      useBoxesStore.setState({
        boxes: [{ id: "bx", name: "bx", member_ids: ["d", "b", "a"], position: 0 }],
      });
    });

    it("is the visible pills: the members, inactive ones included, in pill order", () => {
      useBoxSliceStore.setState({ sliceBoxId: "bx" });
      expect(projectStations()).toEqual([null, "a", "b", "d"]);
    });

    it("keeps the project in scope even when it is not a member", () => {
      useBoxSliceStore.setState({ sliceBoxId: "bx" });
      useTabsStore.setState({ scope: "c" });
      expect(projectStations()).toEqual([null, "a", "b", "c", "d"]);
    });

    it("is the plain active ring again once the slice is left", () => {
      useBoxSliceStore.setState({ sliceBoxId: "bx" });
      useBoxSliceStore.setState({ sliceBoxId: null });
      expect(projectStations()).toEqual([null, "a", "c", "d"]);
    });

    it("falls back to the plain ring when the sliced box is gone", () => {
      useBoxSliceStore.setState({ sliceBoxId: "vanished" });
      expect(projectStations()).toEqual([null, "a", "c", "d"]);
    });
  });
});
