/**
 * A text field that takes the caret a while after a steering key (an async
 * step, a lazy chunk) is the key's own: it takes the keys (`field` hand-off).
 * Past the short window after the key, a focus is the pane's own and steering
 * keeps the keys.
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
import { useTabsStore } from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
import { useProjectsStore } from "../../stores/projects";
import { forgetRegionCursors } from "../../lib/shortcuts/steeringRegion";

function Keyboard() {
  useKeyboard({ onTogglePanels: () => {} });
  return null;
}

function press(init: Partial<KeyboardEventInit> & { key: string }) {
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  });
}

async function wait(ms: number) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

const steering = () => useKeyboardSteeringStore.getState();
const on = () => {
  press({ key: " ", shiftKey: true });
  expect(steering().active).toBe(true);
};

/** A pane outside every layer and outside `.center-pane`, with a text input. */
function sidePane() {
  const pane = document.createElement("div");
  pane.className = "side-panel-test";
  const field = document.createElement("input");
  field.type = "text";
  pane.appendChild(field);
  document.body.appendChild(pane);
  return field;
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
  forgetRegionCursors();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("a field focused after a steering key", () => {
  it("takes the keys when it focuses 400 ms after the key", async () => {
    render(<Keyboard />);
    on();
    const field = sidePane();
    press({ key: "j" });
    await wait(400);
    act(() => field.focus());
    await wait(10);
    expect(document.activeElement).toBe(field);
    expect(steering()).toMatchObject({ active: false, handedTo: "field" });
  });

  it("keeps steering when it focuses 3 s after the key", async () => {
    render(<Keyboard />);
    on();
    const field = sidePane();
    press({ key: "j" });
    // Past the 0 and 150 ms passes, which would hand a focused field off too.
    await wait(400);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 3000);
    act(() => field.focus());
    await wait(10);
    expect(document.activeElement).toBe(field);
    expect(steering()).toMatchObject({ active: true, handedTo: null });
  });
});
