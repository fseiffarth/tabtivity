/**
 * The box cycle chord (`cycleBox` in hooks/useKeyboard): walks the boxes in
 * row order and opens the next / previous one, and is also the way INTO the
 * boxes from a project or the root scope.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));

import { cycleBox } from "../../hooks/useKeyboard";
import { useBoxesStore } from "../../stores/boxes";
import { resetBoxSlice, useBoxSliceStore } from "../../stores/boxSlice";
import { useTabsStore } from "../../stores/tabs";
import { SHORTCUT_DEFS, findConflicts } from "../../lib/shortcuts/shortcuts";
import type { ProjectBox } from "../../types";

function box(id: string, position: number): ProjectBox {
  return { id, name: id, member_ids: [], position };
}

describe("cycleBox", () => {
  const openBox = vi.fn().mockResolvedValue(undefined);
  const leaveBox = vi.fn().mockResolvedValue(undefined);
  beforeEach(() => {
    openBox.mockReset().mockResolvedValue(undefined);
    leaveBox.mockReset().mockResolvedValue(undefined);
    resetBoxSlice();
    useBoxSliceStore.setState({ leaveBox });
    // Row order is by position, not array order.
    useBoxesStore.setState({ boxes: [box("c", 3), box("a", 1), box("b", 2)], openBox });
    useTabsStore.setState({ scope: "root" });
  });

  it("steps into the first box from outside any box, and into the last walking back", () => {
    cycleBox(1);
    expect(openBox).toHaveBeenLastCalledWith("a");
    cycleBox(-1);
    expect(openBox).toHaveBeenLastCalledWith("c");
  });

  it("walks the boxes in row order", () => {
    useTabsStore.setState({ scope: "box:a" });
    cycleBox(1);
    expect(openBox).toHaveBeenLastCalledWith("b");
    useTabsStore.setState({ scope: "box:b" });
    cycleBox(1);
    expect(openBox).toHaveBeenLastCalledWith("c");
    useTabsStore.setState({ scope: "box:c" });
    cycleBox(-1);
    expect(openBox).toHaveBeenLastCalledWith("b");
  });

  it("the step past the last box returns to the project you came from and unslices", () => {
    useTabsStore.setState({ scope: "box:c" });
    cycleBox(1);
    expect(leaveBox).toHaveBeenCalledTimes(1);
    expect(openBox).not.toHaveBeenCalled();
  });

  it("walking back from the first box returns to the project, and from the project lands on the last box", () => {
    useTabsStore.setState({ scope: "box:a" });
    cycleBox(-1);
    expect(leaveBox).toHaveBeenCalledTimes(1);
    expect(openBox).not.toHaveBeenCalled();
    // ... and the project is the ring's first stop: back from it is the last box.
    useTabsStore.setState({ scope: "p1" });
    cycleBox(-1);
    expect(openBox).toHaveBeenLastCalledWith("c");
  });

  it("is a full round trip: project, a, b, c, project", () => {
    const trail: string[] = [];
    openBox.mockImplementation(async (id: string) => {
      useTabsStore.setState({ scope: `box:${id}` });
      trail.push(id);
    });
    leaveBox.mockImplementation(async () => {
      useTabsStore.setState({ scope: "p1" });
      trail.push("project");
    });
    useTabsStore.setState({ scope: "p1" });
    for (let i = 0; i < 4; i++) cycleBox(1);
    expect(trail).toEqual(["a", "b", "c", "project"]);
    cycleBox(1);
    expect(trail[trail.length - 1]).toBe("a");
  });

  it("keeps its place while visiting a member of the sliced box", () => {
    // Hopping to a member leaves the scope on a project, but the slice still
    // names the box: the next step is the box after it, not the first box.
    useBoxSliceStore.setState({ sliceBoxId: "b" });
    useTabsStore.setState({ scope: "p1" });
    cycleBox(1);
    expect(openBox).toHaveBeenLastCalledWith("c");
    cycleBox(-1);
    expect(openBox).toHaveBeenLastCalledWith("a");
  });

  it("a ring of one box is the box and the project it came from", () => {
    useBoxesStore.setState({ boxes: [box("only", 1)] });
    useTabsStore.setState({ scope: "p1" });
    cycleBox(1);
    expect(openBox).toHaveBeenLastCalledWith("only");
    useTabsStore.setState({ scope: "box:only" });
    cycleBox(1);
    expect(leaveBox).toHaveBeenCalledTimes(1);
    cycleBox(-1);
    expect(leaveBox).toHaveBeenCalledTimes(2);
  });

  it("does nothing without boxes", () => {
    useBoxesStore.setState({ boxes: [] });
    cycleBox(1);
    expect(openBox).not.toHaveBeenCalled();
    expect(leaveBox).not.toHaveBeenCalled();
  });

  it("has a rebindable chord each way that collides with no other default", () => {
    const actions = SHORTCUT_DEFS.map((s) => s.action);
    expect(actions).toContain("cycleBox");
    expect(actions).toContain("cycleBoxBack");
    expect(findConflicts({}).size).toBe(0);
  });
});
