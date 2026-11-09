/**
 * The project ring's root station (steering's projects level: 1, ←/→, and the
 * cycle-project chord) opens the **Root view**. The workspace stays on its
 * project: the ring used to end in `setActive(null)`, which switched the whole
 * workspace to the root scope. Landing on a project from the Root view closes it.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ isFullscreen: vi.fn().mockResolvedValue(false), setFullscreen: vi.fn() }),
}));

import { useKeyboard } from "../../hooks/useKeyboard";
import { useBoxesStore } from "../../stores/boxes";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { useProjectsStore } from "../../stores/projects";
import { rootViewShown, useRootOverlayStore } from "../../stores/rootOverlay";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore } from "../../stores/tabs";
import { resetBoxSlice } from "../../stores/boxSlice";
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
const project = (id: string, position: number): ProjectEntry => ({
  id,
  name: id,
  status: "active",
  position,
  local_file: `/p/${id}/project.json`,
});
const rootUp = () => rootViewShown(useRootOverlayStore.getState());
const steering = () => useKeyboardSteeringStore.getState();

let setActive: ReturnType<typeof vi.fn>;
beforeEach(() => {
  setActive = vi.fn(async (id: string | null) => {
    useProjectsStore.setState({ activeId: id });
    useTabsStore.setState({ scope: id ?? "root" });
  });
  useProjectsStore.setState({ projects: [project("a", 0), project("b", 1)], activeId: "a", setActive } as never);
  useBoxesStore.setState({ boxes: [] });
  useSettingsStore.setState({ settings: {} as Settings });
  resetBoxSlice();
  useTabsStore.setState({ scope: "a", tabsByScope: {}, layoutByScope: {}, focusedGroupByScope: {} });
  useRootOverlayStore.setState({ open: false, view: "root" });
  steering().exit();
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

function toProjects() {
  if (!steering().active) press({ key: " ", shiftKey: true });
  for (let i = 0; i < 2 && steering().level !== "projects"; i++) press({ key: "ArrowUp" });
  expect(steering().level).toBe("projects");
}

describe("the project ring's root station", () => {
  it("steering's station 1 opens the Root view and leaves the workspace on its project", () => {
    render(<Harness />);
    toProjects();
    press({ key: "1" });
    expect(rootUp()).toBe(true);
    expect(setActive).not.toHaveBeenCalled();
    expect(useProjectsStore.getState().activeId).toBe("a");
    expect(useTabsStore.getState().scope).toBe("a");
    // Steering lands on the tabs, which are Root's now.
    expect(steering().level).toBe("tabs");
  });

  it("← from the first project lands on Root, not on the root scope", () => {
    render(<Harness />);
    toProjects();
    press({ key: "ArrowLeft" });
    expect(rootUp()).toBe(true);
    expect(setActive).not.toHaveBeenCalledWith(null);
    expect(useTabsStore.getState().scope).toBe("a");
  });

  it("→ from Root lands on the first project and the Root view steps aside", () => {
    useRootOverlayStore.setState({ open: true, view: "root" });
    render(<Harness />);
    toProjects();
    press({ key: "ArrowRight" });
    expect(rootUp()).toBe(false);
    expect(useProjectsStore.getState().activeId).toBe("a");
    expect(useTabsStore.getState().scope).toBe("a");
    // Walking on goes to the next project: the ring stood on Root, not on "a".
    toProjects();
    press({ key: "ArrowRight" });
    expect(setActive).toHaveBeenLastCalledWith("b");
  });

  it("a digit for a project closes the Root view", () => {
    useRootOverlayStore.setState({ open: true, view: "root" });
    render(<Harness />);
    toProjects();
    press({ key: "3" });
    expect(rootUp()).toBe(false);
    expect(setActive).toHaveBeenLastCalledWith("b");
  });

  it("the cycle-project chord opens Root too, and cycles on from it", () => {
    render(<Harness />);
    // Alt+Shift+→ walks forward: a -> b -> Root.
    press({ key: "ArrowRight", altKey: true, shiftKey: true });
    expect(setActive).toHaveBeenLastCalledWith("b");
    press({ key: "ArrowRight", altKey: true, shiftKey: true });
    expect(rootUp()).toBe(true);
    expect(setActive).not.toHaveBeenCalledWith(null);
    expect(useProjectsStore.getState().activeId).toBe("b");
    // Back (Alt+Shift+←) from Root: the last project, and Root steps aside.
    press({ key: "ArrowLeft", altKey: true, shiftKey: true });
    expect(rootUp()).toBe(false);
    expect(useProjectsStore.getState().activeId).toBe("b");
  });
});
