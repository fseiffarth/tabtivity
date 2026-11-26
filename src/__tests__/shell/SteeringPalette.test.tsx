/**
 * Steering hands the keys to the command palette's input. A pick closes the
 * palette and ends steering, so the tab or file it opened gets the keys. Esc
 * in the input only comes back to steering on the surface underneath; the
 * palette's own Escape then closes it without ending steering.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => []),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFullscreen: vi.fn().mockResolvedValue(false),
    setFullscreen: vi.fn(),
  }),
}));
vi.mock("../../lib/shortcuts/tabJump", () => ({ jumpToTab: vi.fn() }));
vi.mock("../../components/embed/fileViewer/openLinked", () => ({
  openLinkedFile: vi.fn(),
  viewerForPath: () => "code",
}));

import { useKeyboard } from "../../hooks/useKeyboard";
import { CommandPalette, OPEN_PALETTE_EVENT } from "../../components/layout/CommandPalette";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { useProjectsStore } from "../../stores/projects";
import { useTabsStore } from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
import type { TabEntry } from "../../stores/tabs/types";
import { forgetRegionCursors } from "../../lib/shortcuts/steeringRegion";

function Keyboard() {
  useKeyboard({ onTogglePanels: () => {} });
  return null;
}

const tab = (key: string, label: string): TabEntry => ({ key, label, cmd: "", cwd: "/p", kind: "shell", scope: "p1" });

function press(init: Partial<KeyboardEventInit> & { key: string }) {
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  });
}

// Past `syncSoon`'s late pass and the placement retries (as in SteeringOverlays).
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 200));
  });
}

const steering = () => useKeyboardSteeringStore.getState();
const palette = () => document.querySelector(".command-palette-backdrop");

/** Steering on, the palette opened over it, and the input handed the keys. */
async function openHanded() {
  press({ key: " ", shiftKey: true });
  expect(steering().active).toBe(true);
  act(() => void window.dispatchEvent(new CustomEvent(OPEN_PALETTE_EVENT, { detail: { filter: "" } })));
  // A steering key follows the open, as it does from the + menu's row.
  press({ key: "d" });
  await settle();
  expect(palette()).not.toBeNull();
  expect(steering()).toMatchObject({ active: false, handedTo: "field" });
  expect(document.activeElement).toBe(screen.getByRole("textbox"));
}

beforeEach(() => {
  useTabsStore.setState({
    scope: "p1",
    tabs: [tab("t1", "build log")],
    tabsByScope: { p1: [tab("t1", "build log")] },
    layoutByScope: {},
    focusedGroupByScope: {},
    layout: null,
    focusedGroupId: null,
    activeKey: null,
    fullscreenGroupId: null,
  });
  useProjectsStore.setState({
    projects: [{ id: "p1", name: "Alpha", directory: "/p" } as never],
    activeId: "p1",
    loaded: true,
  });
  useSettingsStore.setState({ settings: null });
  steering().exit();
  forgetRegionCursors();
  // jsdom has no layout: steering sees a layer only once it has a box.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return { width: 10, height: 5, x: 0, y: 0, top: 0, left: 0, right: 10, bottom: 5, toJSON: () => ({}) };
  });
});

afterEach(() => {
  cleanup();
  steering().exit();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("steering and the command palette", () => {
  it("a pick from the palette ends steering, so the opened tab gets the keys", async () => {
    render(
      <>
        <Keyboard />
        <CommandPalette />
      </>,
    );
    await openHanded();

    // Enter picks the first row (the tab); the palette closes.
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    await settle();
    expect(palette()).toBeNull();
    expect(steering()).toMatchObject({ active: false, handedTo: null });
  });

  it("Escape in the input comes back to steering, and a second Escape closes the palette without ending it", async () => {
    render(
      <>
        <Keyboard />
        <CommandPalette />
      </>,
    );
    await openHanded();

    press({ key: "Escape" });
    await settle();
    expect(palette()).not.toBeNull();
    expect(steering()).toMatchObject({ active: true, handedTo: null });

    press({ key: "Escape" });
    await settle();
    expect(palette()).toBeNull();
    expect(steering()).toMatchObject({ active: true, handedTo: null });
  });
});
