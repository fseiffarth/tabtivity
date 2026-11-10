/**
 * The steering chord pressed in a popout: the popout has no steering of its
 * own, so it sends the chord to the main window (`DETACHED_STEER`), which turns
 * steering on there (`STEER_FROM_POPOUT`). Both windows hold the chord back in
 * a typing burst the same way (`steeringChordFires`).
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
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { allGroups, useTabsStore } from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
import { useProjectsStore } from "../../stores/projects";
import { resolveChord } from "../../lib/shortcuts/shortcuts";
import {
  STEER_FROM_POPOUT,
  TYPING_BURST_MS,
  steeringChordFires,
} from "../../lib/shortcuts/steeringChord";

function Harness() {
  useKeyboard({ onTogglePanels: () => {} });
  return null;
}

const steering = () => useKeyboardSteeringStore.getState();

function key(init: KeyboardEventInit, timeStamp: number): KeyboardEvent {
  const e = new KeyboardEvent("keydown", init);
  Object.defineProperty(e, "timeStamp", { value: timeStamp });
  return e;
}

beforeEach(() => {
  useTabsStore.setState({
    scope: "p",
    tabsByScope: {},
    layoutByScope: {},
    focusedGroupByScope: {},
    tabs: [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
    fullscreenGroupId: null,
  });
  useSettingsStore.setState({ settings: null });
  useProjectsStore.setState({ projects: [] });
  useKeyboardSteeringStore.getState().exit();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("steering chord", () => {
  const chord = resolveChord("steeringMode", undefined);
  const shiftSpace = { key: " ", code: "Space", shiftKey: true };

  it("fires on its own, not inside a typing burst", () => {
    expect(steeringChordFires(chord, key(shiftSpace, 5000), false, -Infinity)).toBe(true);
    // "I am": the Shift still down from the I is a space.
    expect(steeringChordFires(chord, key(shiftSpace, 5000), false, 5000 - 50)).toBe(false);
    expect(
      steeringChordFires(chord, key(shiftSpace, 5000), false, 5000 - TYPING_BURST_MS - 1),
    ).toBe(true);
    // While steering is on it always counts: it leaves.
    expect(steeringChordFires(chord, key(shiftSpace, 5000), true, 5000 - 50)).toBe(true);
    expect(steeringChordFires(chord, key({ key: " " }, 5000), false, -Infinity)).toBe(false);
  });
});

describe("steering from a popout", () => {
  it("turns steering on in the main window, on its tabs", () => {
    useTabsStore.getState().addTab({ label: "a", cmd: "bash", cwd: "/p", kind: "shell" });
    useTabsStore.setState({ focusedGroupId: null });
    render(<Harness />);
    act(() => {
      window.dispatchEvent(new CustomEvent(STEER_FROM_POPOUT));
    });
    expect(steering()).toMatchObject({ active: true, level: "tabs" });
    // A subwindow holds the focus for the tabs level to walk.
    expect(useTabsStore.getState().focusedGroupId).toBe(
      allGroups(useTabsStore.getState().layout)[0].id,
    );
  });

  it("leaves steering that is already on where it is", () => {
    useTabsStore.getState().addTab({ label: "a", cmd: "bash", cwd: "/p", kind: "shell" });
    render(<Harness />);
    act(() => {
      useKeyboardSteeringStore.getState().enter();
      useKeyboardSteeringStore.getState().setLevel("projects");
    });
    act(() => {
      window.dispatchEvent(new CustomEvent(STEER_FROM_POPOUT));
    });
    expect(steering()).toMatchObject({ active: true, level: "projects" });
  });
});
