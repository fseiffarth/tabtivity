/**
 * Steering's scroll level asks the Reader's Inside target first
 * (`lib/agents/readerSteering`): `leave` steps out to the tabs, `handled` stops
 * there, `pass` falls through to the scroll level's own meaning. A terminal
 * with no target behaves as in `SteeringScroll.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { Terminal } from "@xterm/xterm";

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
import { registerTerminal, unregisterTerminal } from "../../lib/terminal/terminalRegistry";
import { releaseTerminalScroll } from "../../lib/terminal/terminalScroll";
import {
  registerReaderInside,
  type ReaderInsideResult,
  type ReaderInsideTarget,
} from "../../lib/agents/readerSteering";
import type { SteeringAction } from "../../lib/shortcuts/steeringBindings";

function Harness() {
  useKeyboard({ onTogglePanels: () => {} });
  return null;
}

function press(init: Partial<KeyboardEventInit> & { key: string }) {
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  });
}

const steering = () => useKeyboardSteeringStore.getState();
const cleanups: (() => void)[] = [];

/** A fake xterm on the tab's pane id; `wheels` records the notches it saw. */
function pane(tracking: boolean) {
  const tab = useTabsStore.getState().addTab({ label: "claude", cmd: "claude", cwd: "/p", kind: "agent" });
  const id = `p:${tab.key}`;
  const element = document.createElement("div");
  const screen = document.createElement("div");
  screen.className = "xterm-screen";
  element.appendChild(screen);
  document.body.appendChild(element);
  const wheels: number[] = [];
  element.addEventListener("wheel", (e) => wheels.push(Math.sign((e as WheelEvent).deltaY)));
  const term = {
    element,
    rows: 40,
    modes: { mouseTrackingMode: tracking ? "vt200" : "none" },
    buffer: { active: { type: tracking ? "alternate" : "normal" } },
    scrollLines: vi.fn(),
    scrollToBottom: vi.fn(),
  };
  registerTerminal(id, term as unknown as Terminal);
  cleanups.push(() => unregisterTerminal(id, term as unknown as Terminal));
  return { id, term, wheels };
}

/** An agent tab with a tracking terminal and an Inside target answering `answer`. */
function inside(answer: (action: SteeringAction, e: KeyboardEvent) => ReaderInsideResult) {
  const { id, wheels } = pane(true);
  const key = vi.fn(answer);
  const target: ReaderInsideTarget = { view: "changes", key };
  cleanups.push(registerReaderInside(id, target));
  return { key, wheels };
}

function stepInside() {
  render(<Harness />);
  press({ key: " ", shiftKey: true });
  press({ key: "ArrowDown" });
  expect(steering().level).toBe("scroll");
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
  releaseTerminalScroll();
  for (const off of cleanups.splice(0)) off();
  cleanup();
  document.body.innerHTML = "";
});

describe("steering Inside a Reader view", () => {
  it("hands the target the resolved action and the event, and `handled` stops there", () => {
    const { key, wheels } = inside(() => "handled");
    stepInside();
    key.mockClear();
    press({ key: "z" });
    expect(key).toHaveBeenCalledTimes(1);
    expect(key.mock.calls[0][0]).toBe("viewToggle");
    expect(key.mock.calls[0][1]).toBeInstanceOf(KeyboardEvent);
    press({ key: "S", shiftKey: true });
    expect(key.mock.calls[1][0]).toBe("left");
    expect(key.mock.calls[1][1].shiftKey).toBe(true);
    // `handled` left ← alone: nothing reached the terminal.
    expect(wheels).toEqual([]);
    expect(steering().level).toBe("scroll");
  });

  it("`leave` steps out to the tabs", () => {
    inside((action) => (action === "up" ? "leave" : "handled"));
    stepInside();
    press({ key: "e" });
    expect(steering().level).toBe("tabs");
    expect(steering().active).toBe(true);
  });

  it("`pass` reaches the scroll level's own keys", () => {
    const { key, wheels } = inside(() => "pass");
    stepInside();
    press({ key: "s" });
    expect(key.mock.calls[key.mock.calls.length - 1]?.[0]).toBe("left");
    expect(wheels.length).toBeGreaterThan(0);
    expect(steering().level).toBe("scroll");
    // Work here still leaves steering.
    press({ key: "Enter" });
    expect(steering().active).toBe(false);
  });

  it("never asks for a key that resolves to nothing, or for the keys served before it", () => {
    const { key } = inside(() => "handled");
    stepInside();
    key.mockClear();
    press({ key: "i" });
    expect(key).not.toHaveBeenCalled();
    // Escape leaves steering before the level's handler.
    press({ key: "Escape" });
    expect(key).not.toHaveBeenCalled();
    expect(steering().active).toBe(false);
  });

  it("lets a dead pane key reach the target as its own action, not as a new tab", () => {
    const { key } = inside(() => "handled");
    stepInside();
    key.mockClear();
    const tabs = useTabsStore.getState().tabs.length;
    press({ key: "c" });
    expect(key.mock.calls[0][0]).toBe("calendar");
    expect(useTabsStore.getState().tabs.length).toBe(tabs);
  });

  it("serves a terminal with no target as before: N and O are swallowed, S scrolls", () => {
    const { term } = pane(false);
    stepInside();
    const count = useTabsStore.getState().tabs.length;
    press({ key: "n" });
    press({ key: "o" });
    expect(useTabsStore.getState().tabs.length).toBe(count);
    expect(steering().level).toBe("scroll");
    press({ key: "s" });
    expect(term.scrollLines).toHaveBeenCalledWith(-20);
  });
});
