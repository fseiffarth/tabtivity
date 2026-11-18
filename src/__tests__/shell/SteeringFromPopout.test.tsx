/**
 * A popout handing steering to the main window (`DETACHED_STEER`, passed on by
 * the main window's host as `STEER_FROM_POPOUT` with the popout's payload): the
 * main window takes steering only once it has the keyboard, and lands on its
 * tabs. Both windows hold the chord back in a typing burst the same way
 * (`steeringChordFires`). The full round trips are `windows/SteeringHandover`.
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
import { STEER_HANDOVER_WAIT_MS } from "../../hooks/useSteering";
import type { DetachedSteerPayload } from "../../stores/detached";
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
  vi.restoreAllMocks();
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
  const request = (act: DetachedSteerPayload["act"]) =>
    new CustomEvent<DetachedSteerPayload>(STEER_FROM_POPOUT, {
      detail: { scope: "p", groupId: "pop", label: "detached-p-pop", act },
    });

  it("turns steering on in the main window, on its tabs, once it has the keyboard", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    useTabsStore.getState().addTab({ label: "a", cmd: "bash", cwd: "/p", kind: "shell" });
    useTabsStore.setState({ focusedGroupId: null });
    render(<Harness />);
    act(() => {
      window.dispatchEvent(request({ kind: "enter" }));
    });
    // Not yet: the window manager has not handed this window the keyboard.
    expect(steering().active).toBe(false);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(steering()).toMatchObject({ active: true, level: "tabs" });
    // A subwindow holds the focus for the tabs level to walk.
    expect(useTabsStore.getState().focusedGroupId).toBe(
      allGroups(useTabsStore.getState().layout)[0].id,
    );
  });

  it("drops the request when the keyboard never arrives", () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(document, "hasFocus").mockReturnValue(false);
      useTabsStore.getState().addTab({ label: "a", cmd: "bash", cwd: "/p", kind: "shell" });
      render(<Harness />);
      act(() => {
        window.dispatchEvent(request({ kind: "enter" }));
      });
      act(() => {
        vi.advanceTimersByTime(STEER_HANDOVER_WAIT_MS + 1);
      });
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
      expect(steering().active).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an arrival while steering is on lands on the tabs", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    useTabsStore.getState().addTab({ label: "a", cmd: "bash", cwd: "/p", kind: "shell" });
    render(<Harness />);
    act(() => {
      useKeyboardSteeringStore.getState().enter();
      useKeyboardSteeringStore.getState().setLevel("projects");
    });
    act(() => {
      window.dispatchEvent(request({ kind: "enter" }));
    });
    expect(steering()).toMatchObject({ active: true, level: "tabs" });
  });
});
