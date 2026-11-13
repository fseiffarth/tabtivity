/**
 * Steering's project level walks the pills the All-projects strip DRAWS: the
 * projects the user hid from it (`bar_hidden_projects`, a hidden box's members)
 * are not stations, the project in scope stays one (its pill comes back while
 * it is current), and a hidden project made active some other way never leaves
 * ←/→ without a place to step on from. Digits number the same ring.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFullscreen: vi.fn().mockResolvedValue(false),
    setFullscreen: vi.fn(),
  }),
}));

import { useKeyboard } from "../../hooks/useKeyboard";
import { projectStations, useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { useTabsStore } from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
import { useProjectsStore } from "../../stores/projects";
import { useBoxesStore } from "../../stores/boxes";
import { rootViewShown, useRootOverlayStore } from "../../stores/rootOverlay";
import { resetBoxSlice, useBoxSliceStore } from "../../stores/boxSlice";
import type { ProjectEntry, Settings } from "../../types";

function Harness() {
  useKeyboard({ onTogglePanels: () => {} });
  return null;
}

function press(init: Partial<KeyboardEventInit> & { key: string }) {
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  });
}

const rootViewUp = () => rootViewShown(useRootOverlayStore.getState());

function project(id: string, position: number, status = "active"): ProjectEntry {
  return { id, name: id, status, position, local_file: `/p/${id}/project.json` };
}

function hide(patch: Partial<Settings>) {
  useSettingsStore.setState({ settings: { ...patch } as Settings });
}

/** A `setActive` that lands at once, like a project already open: the active
 *  id and the tab scope follow, the way a real switch settles. */
function instantSetActive(lagScope = false) {
  const setActive = vi.fn(async (id: string | null) => {
    useProjectsStore.setState({ activeId: id });
    if (!lagScope) useTabsStore.setState({ scope: id ?? "root" });
  });
  useProjectsStore.setState({ setActive } as never);
  return setActive;
}

beforeEach(() => {
  useProjectsStore.setState({
    projects: [project("a", 0), project("b", 1), project("c", 2), project("d", 3)],
    activeId: "a",
  });
  useBoxesStore.setState({ boxes: [] });
  useSettingsStore.setState({ settings: null });
  resetBoxSlice();
  useTabsStore.setState({ scope: "a", tabsByScope: {}, layoutByScope: {}, focusedGroupByScope: {} });
  useRootOverlayStore.setState({ open: false, view: "root" });
  useKeyboardSteeringStore.getState().exit();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("projectStations with hidden projects", () => {
  it("leaves out projects hidden one by one", () => {
    hide({ bar_hidden_projects: ["b"] });
    expect(projectStations()).toEqual([null, "a", "c", "d"]);
  });

  it("leaves out every member of a hidden box", () => {
    useBoxesStore.setState({ boxes: [{ id: "bx", name: "bx", member_ids: ["c", "d"], position: 0 }] });
    hide({ bar_hidden_boxes: ["bx"] });
    expect(projectStations()).toEqual([null, "a", "b"]);
  });

  it("keeps the project in scope even when it is hidden", () => {
    hide({ bar_hidden_projects: ["a", "b"] });
    expect(projectStations()).toEqual([null, "a", "c", "d"]);
  });

  it("keeps the active project while the scope has not followed yet", () => {
    hide({ bar_hidden_projects: ["b"] });
    useProjectsStore.setState({ activeId: "b" });
    expect(projectStations()).toEqual([null, "a", "b", "c", "d"]);
  });

  it("does not apply the lists inside a box slice", () => {
    useBoxesStore.setState({ boxes: [{ id: "bx", name: "bx", member_ids: ["b", "c"], position: 0 }] });
    hide({ bar_hidden_projects: ["b"], bar_hidden_boxes: ["bx"] });
    useBoxSliceStore.setState({ sliceBoxId: "bx" });
    expect(projectStations()).toEqual([null, "a", "b", "c"]);
  });
});

describe("steering the project level past hidden projects", () => {
  function toProjects() {
    // Landing on a project drops steering to its tabs; climb back up.
    if (!useKeyboardSteeringStore.getState().active) press({ key: " ", shiftKey: true });
    for (let i = 0; i < 2 && useKeyboardSteeringStore.getState().level !== "projects"; i++) press({ key: "ArrowUp" });
    expect(useKeyboardSteeringStore.getState().level).toBe("projects");
  }

  it("→ skips hidden projects, in the order of the visible row", () => {
    const setActive = instantSetActive();
    hide({ bar_hidden_projects: ["b", "c"] });
    render(<Harness />);
    toProjects();
    press({ key: "ArrowRight" });
    expect(setActive).toHaveBeenLastCalledWith("d");
    toProjects();
    press({ key: "ArrowRight" });
    // Past the last visible pill: the ring wraps to the root station, which
    // opens the Root view and leaves the workspace on its project.
    expect(setActive).toHaveBeenLastCalledWith("d");
    expect(rootViewUp()).toBe(true);
  });

  it("← from a hidden active project reaches a visible neighbour, then keeps walking", () => {
    const setActive = instantSetActive();
    hide({ bar_hidden_projects: ["b", "c"] });
    useProjectsStore.setState({ activeId: "c" });
    useTabsStore.setState({ scope: "c" });
    render(<Harness />);
    toProjects();
    press({ key: "ArrowLeft" });
    // c is the scope so it is on the ring; b is not: the step before c is a.
    expect(setActive).toHaveBeenLastCalledWith("a");
    toProjects();
    press({ key: "ArrowLeft" });
    expect(setActive).not.toHaveBeenCalledWith(null);
    expect(rootViewUp()).toBe(true);
    toProjects();
    press({ key: "ArrowLeft" });
    expect(setActive).toHaveBeenLastCalledWith("d");
  });

  it("does not restart from the first station when the scope lags a hidden active project", () => {
    const setActive = instantSetActive(true);
    hide({ bar_hidden_projects: ["b"] });
    useProjectsStore.setState({ activeId: "b" });
    // scope still "a": the switch to b is under way.
    render(<Harness />);
    toProjects();
    press({ key: "ArrowRight" });
    expect(setActive).toHaveBeenLastCalledWith("c");
  });

  it("the digits number the visible row (1 = root)", () => {
    const setActive = instantSetActive();
    hide({ bar_hidden_projects: ["b"] });
    render(<Harness />);
    toProjects();
    press({ key: "3" });
    expect(setActive).toHaveBeenLastCalledWith("c");
    toProjects();
    press({ key: "4" });
    expect(setActive).toHaveBeenLastCalledWith("d");
  });
});
