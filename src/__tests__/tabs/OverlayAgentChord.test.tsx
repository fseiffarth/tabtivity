/**
 * Ctrl+1–9 inside a mail / calendar / to-do overlay: the chord goes to the
 * front overlay (`OVERLAY_AGENT_EVENT`), which docks that slot's root agent
 * beside the app — never to the workspace pane hidden under the overlay. An
 * unanswered request passes the key on; with no overlay up (or its setting
 * off) the old new-tab path is unchanged, and the shell / monitor chords
 * always take it.
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
import {
  NEW_TAB_SHORTCUT_EVENT,
  OVERLAY_AGENT_EVENT,
  requestOverlayAgent,
  type NewTabShortcutDetail,
  type OverlayAgentDetail,
} from "../../lib/shortcuts/newTabChord";
import { frontAppOverlay } from "../../lib/shortcuts/appOverlays";
import { allGroups, useTabsStore } from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { useMailStore } from "../../stores/mail";
import { useCalendarStore } from "../../stores/calendar/calendar";
import { useTodoStore } from "../../stores/todo";

function Harness() {
  useKeyboard({ onTogglePanels: () => {} });
  return null;
}

const ALL_ON = { mail_client: true, calendar_global_app: true, todo_board: true };

function setSettings(patch: Record<string, unknown>) {
  useSettingsStore.setState({ settings: patch } as never);
}

function onePane() {
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
  useTabsStore.getState().addTab({ label: "a", cmd: "bash", cwd: "/p", kind: "shell" });
  useTabsStore.getState().focusGroup(allGroups(useTabsStore.getState().layout)[0].id);
}

function openOverlays(...apps: ("mail" | "calendar" | "todo")[]) {
  useMailStore.setState({ overlayOpen: apps.includes("mail") });
  useCalendarStore.setState({ overlayOpen: apps.includes("calendar") });
  useTodoStore.setState({ overlayOpen: apps.includes("todo") });
}

/** An overlay's frame, as its `<App>Overlay` renders it, with a focusable
 *  field inside. */
function frame(app: "mail" | "calendar" | "todo"): HTMLInputElement {
  const div = document.createElement("div");
  div.className = `root-overlay subwindow focused ${app}-overlay`;
  const input = document.createElement("input");
  div.appendChild(input);
  document.body.appendChild(div);
  return input;
}

function press(init: KeyboardEventInit, target: EventTarget = document.body): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(ev);
  });
  return ev;
}

const CTRL_1 = { key: "1", code: "Digit1", ctrlKey: true };
const CTRL_3 = { key: "3", code: "Digit3", ctrlKey: true };

/** Records both events; `answer` decides whether the overlay docks. */
function listen(answer: { overlay: boolean; newTab: boolean }) {
  const overlay: OverlayAgentDetail[] = [];
  const newTab: NewTabShortcutDetail[] = [];
  const onOverlay = (e: Event) => {
    overlay.push((e as CustomEvent<OverlayAgentDetail>).detail);
    if (answer.overlay) e.preventDefault();
  };
  const onNewTab = (e: Event) => {
    newTab.push((e as CustomEvent<NewTabShortcutDetail>).detail);
    if (answer.newTab) e.preventDefault();
  };
  window.addEventListener(OVERLAY_AGENT_EVENT, onOverlay);
  window.addEventListener(NEW_TAB_SHORTCUT_EVENT, onNewTab);
  const off = () => {
    window.removeEventListener(OVERLAY_AGENT_EVENT, onOverlay);
    window.removeEventListener(NEW_TAB_SHORTCUT_EVENT, onNewTab);
  };
  return { overlay, newTab, off };
}

describe("Ctrl+1–9 inside an app overlay", () => {
  let events: ReturnType<typeof listen> | null = null;

  beforeEach(() => {
    cleanup();
    document.body.innerHTML = "";
    onePane();
    openOverlays();
    setSettings(ALL_ON);
    useRootOverlayStore.setState({ open: false });
    useKeyboardSteeringStore.getState().exit();
  });

  afterEach(() => {
    events?.off();
    events = null;
  });

  it("asks the overlay for the slot, not the workspace pane", () => {
    openOverlays("calendar");
    render(<Harness />);
    events = listen({ overlay: true, newTab: true });
    const ev = press(CTRL_3);
    expect(events.overlay).toEqual([{ app: "calendar", slot: 2 }]);
    expect(events.newTab).toEqual([]);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("closes the root console and leaves steering once the overlay docked", () => {
    openOverlays("todo");
    useRootOverlayStore.setState({ open: true });
    render(<Harness />);
    act(() => useKeyboardSteeringStore.getState().enter());
    events = listen({ overlay: true, newTab: true });
    press(CTRL_1);
    expect(events.overlay).toEqual([{ app: "todo", slot: 0 }]);
    expect(useRootOverlayStore.getState().open).toBe(false);
    expect(useKeyboardSteeringStore.getState().active).toBe(false);
  });

  it("passes an unanswered request on, without a hidden workspace tab", () => {
    openOverlays("mail");
    useRootOverlayStore.setState({ open: true });
    render(<Harness />);
    events = listen({ overlay: false, newTab: true });
    const before = useTabsStore.getState().tabs.length;
    const ev = press(CTRL_1);
    expect(events.overlay).toEqual([{ app: "mail", slot: 0 }]);
    expect(events.newTab).toEqual([]);
    expect(ev.defaultPrevented).toBe(false);
    expect(useTabsStore.getState().tabs.length).toBe(before);
    expect(useRootOverlayStore.getState().open).toBe(true);
  });

  it("keeps the old path with no overlay up", () => {
    useRootOverlayStore.setState({ open: true });
    render(<Harness />);
    events = listen({ overlay: true, newTab: true });
    const ev = press(CTRL_1);
    expect(events.overlay).toEqual([]);
    expect(events.newTab.map((d) => d.request)).toEqual([{ kind: "agent", slot: 0 }]);
    expect(ev.defaultPrevented).toBe(true);
    expect(useRootOverlayStore.getState().open).toBe(false);
  });

  it("ignores an overlay whose setting is off", () => {
    openOverlays("calendar");
    setSettings({ ...ALL_ON, calendar_global_app: false });
    render(<Harness />);
    events = listen({ overlay: true, newTab: true });
    press(CTRL_1);
    expect(events.overlay).toEqual([]);
    expect(events.newTab.map((d) => d.request)).toEqual([{ kind: "agent", slot: 0 }]);
  });

  it("leaves the shell and monitor chords to the workspace pane", () => {
    openOverlays("calendar");
    render(<Harness />);
    events = listen({ overlay: true, newTab: true });
    press({ key: "N", ctrlKey: true, shiftKey: true });
    press({ key: "M", ctrlKey: true, shiftKey: true });
    expect(events.overlay).toEqual([]);
    expect(events.newTab.map((d) => d.request)).toEqual([{ kind: "shell" }, { kind: "monitor" }]);
  });
});

describe("requestOverlayAgent", () => {
  it("is true only when a listener cancelled it", () => {
    expect(requestOverlayAgent("todo", 0)).toBe(false);
    const answer = (e: Event) => e.preventDefault();
    window.addEventListener(OVERLAY_AGENT_EVENT, answer);
    try {
      expect(requestOverlayAgent("todo", 0)).toBe(true);
    } finally {
      window.removeEventListener(OVERLAY_AGENT_EVENT, answer);
    }
  });
});

describe("frontAppOverlay", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    openOverlays();
    setSettings(ALL_ON);
  });

  it("is null with no overlay open", () => {
    expect(frontAppOverlay()).toBeNull();
  });

  it("counts an open overlay only while its setting is on", () => {
    openOverlays("mail");
    expect(frontAppOverlay()).toBe("mail");
    setSettings({ ...ALL_ON, mail_client: false });
    expect(frontAppOverlay()).toBeNull();
    openOverlays("todo");
    setSettings({ ...ALL_ON, todo_board: false });
    expect(frontAppOverlay()).toBeNull();
  });

  it("picks the topmost by mount order: board, then calendar, then mail", () => {
    openOverlays("mail", "calendar", "todo");
    expect(frontAppOverlay()).toBe("todo");
    openOverlays("mail", "calendar");
    expect(frontAppOverlay()).toBe("calendar");
    setSettings({ ...ALL_ON, todo_board: false });
    openOverlays("mail", "todo");
    expect(frontAppOverlay()).toBe("mail");
  });

  it("prefers the overlay holding the focus", () => {
    openOverlays("mail", "calendar", "todo");
    frame("todo");
    const inMail = frame("mail");
    frame("calendar");
    inMail.focus();
    expect(frontAppOverlay()).toBe("mail");
  });

  it("ignores the focus inside an overlay that does not count", () => {
    openOverlays("calendar", "todo");
    const inMail = frame("mail");
    inMail.focus();
    expect(frontAppOverlay()).toBe("todo");
  });
});
