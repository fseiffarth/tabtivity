/**
 * `stores/boxSlice`: the selected box slice and where the unsliced strip last
 * stood, moved out of `ProjectSwitcher` so a ✕, the palette, the search and
 * Dissolve-while-inside can reach it.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ProjectBox, ProjectEntry } from "../../types";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import { resetBoxSlice, useBoxSliceStore } from "../../stores/boxSlice";
import { useBoxesStore } from "../../stores/boxes";
import { useProjectsStore } from "../../stores/projects";
import { useTabsStore } from "../../stores/tabs";

const proj = (id: string, status: "active" | "inactive" = "active"): ProjectEntry => ({
  id,
  name: id,
  status,
  position: 10,
  local_file: `/p/${id}/project.json`,
});
const box = (id: string): ProjectBox => ({ id, name: id, member_ids: [], position: 1, folder: `/boxes/${id}` });

const setActive = vi.fn().mockResolvedValue(undefined);
const openBox = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  setActive.mockClear();
  openBox.mockClear();
  resetBoxSlice();
  useBoxesStore.setState({ boxes: [box("b1")], openBox });
  useProjectsStore.setState({ projects: [proj("p1"), proj("p2", "inactive")], setActive });
  useTabsStore.setState({ scope: "root" });
});

describe("boxSlice", () => {
  it("starts unsliced, with root as the place to return to", () => {
    expect(useBoxSliceStore.getState()).toMatchObject({ sliceBoxId: null, lastUnslicedScope: "root" });
  });

  it("selectBox(id) selects the slice and enters the box", async () => {
    await useBoxSliceStore.getState().selectBox("b1");
    expect(useBoxSliceStore.getState().sliceBoxId).toBe("b1");
    expect(openBox).toHaveBeenCalledWith("b1");
    expect(setActive).not.toHaveBeenCalled();
  });

  it("leaveBox from inside a box scope hands the scope back to where the unsliced strip stood", async () => {
    useTabsStore.setState({ scope: "p1" });
    useBoxSliceStore.getState().noteScope("p1");
    await useBoxSliceStore.getState().selectBox("b1");
    useTabsStore.setState({ scope: "box:b1" });
    await useBoxSliceStore.getState().leaveBox();
    expect(useBoxSliceStore.getState().sliceBoxId).toBeNull();
    expect(setActive).toHaveBeenCalledWith("p1");
  });

  it("falls back to no project when the remembered one has since been closed", async () => {
    useBoxSliceStore.getState().noteScope("p2");
    useTabsStore.setState({ scope: "box:b1" });
    await useBoxSliceStore.getState().selectBox(null);
    expect(setActive).toHaveBeenCalledWith(null);
  });

  it("leaves the scope alone when the strip is cleared from a member's scope", async () => {
    useBoxSliceStore.getState().setSlice("b1");
    useTabsStore.setState({ scope: "p1" });
    await useBoxSliceStore.getState().leaveBox();
    expect(useBoxSliceStore.getState().sliceBoxId).toBeNull();
    expect(setActive).not.toHaveBeenCalled();
  });

  it("only scopes seen while unsliced count as the place to return to", () => {
    const s = useBoxSliceStore.getState();
    s.noteScope("p1");
    expect(useBoxSliceStore.getState().lastUnslicedScope).toBe("p1");
    s.noteScope("box:b1");
    expect(useBoxSliceStore.getState().lastUnslicedScope).toBe("p1");
    s.setSlice("b1");
    useBoxSliceStore.getState().noteScope("p2");
    expect(useBoxSliceStore.getState().lastUnslicedScope).toBe("p1");
  });

  it("followScope selects a box scope's slice, and leaves the slice alone for any other scope", () => {
    const s = useBoxSliceStore.getState();
    s.followScope("p1");
    expect(useBoxSliceStore.getState().sliceBoxId).toBeNull();
    s.followScope("box:b1");
    expect(useBoxSliceStore.getState().sliceBoxId).toBe("b1");
    useBoxSliceStore.getState().followScope("p1");
    expect(useBoxSliceStore.getState().sliceBoxId).toBe("b1");
  });

  it("dropIfGone clears the slice of a dissolved box only", () => {
    useBoxSliceStore.getState().setSlice("b1");
    useBoxSliceStore.getState().dropIfGone(["b1", "b2"]);
    expect(useBoxSliceStore.getState().sliceBoxId).toBe("b1");
    useBoxSliceStore.getState().dropIfGone(["b2"]);
    expect(useBoxSliceStore.getState().sliceBoxId).toBeNull();
  });
});
