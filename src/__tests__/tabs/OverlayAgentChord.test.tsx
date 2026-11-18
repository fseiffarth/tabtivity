/**
 * Ctrl+1–9 inside a mail / calendar / to-do view of the console window: the
 * chord goes to the shown app (`OVERLAY_AGENT_EVENT`), which docks that slot's
 * root agent beside it — never to the workspace pane hidden under the window.
 * An unanswered request passes the key on; with no app view shown (or its
 * setting off) the old new-tab path is unchanged, and the shell / monitor
 * chords always take it.
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
  ROOT_EMPTY_GROUP_ID,
  requestOverlayAgent,
  type NewTabShortcutDetail,
  type OverlayAgentDetail,
} from "../../lib/shortcuts/newTabChord";
import { shownApp } from "../../lib/shortcuts/appViews";
import { allGroups, useTabsStore } from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";

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

/** Show an app's view in the window (or none: the window closed). The store
 *  is set directly, as the settings gate is the test's own business. */
function showApp(app?: "mail" | "calendar" | "todo") {
  useRootOverlayStore.setState(app ? { open: true, view: app } : { open: false, view: "root" });
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

describe("Ctrl+1–9 inside an app view", () => {
  let events: ReturnType<typeof listen> | null = null;

  beforeEach(() => {
    cleanup();
    document.body.innerHTML = "";
    onePane();
    setSettings(ALL_ON);
    showApp();
    useKeyboardSteeringStore.getState().exit();
  });

  afterEach(() => {
    events?.off();
    events = null;
  });

  it("asks the view for the slot, not the workspace pane", () => {
    showApp("calendar");
    render(<Harness />);
    events = listen({ overlay: true, newTab: true });
    const ev = press(CTRL_3);
    expect(events.overlay).toEqual([{ app: "calendar", slot: 2 }]);
    expect(events.newTab).toEqual([]);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("keeps the window up (the docked column is in it) and leaves steering once the view docked", () => {
    showApp("todo");
    render(<Harness />);
    act(() => useKeyboardSteeringStore.getState().enter());
    events = listen({ overlay: true, newTab: true });
    press(CTRL_1);
    expect(events.overlay).toEqual([{ app: "todo", slot: 0 }]);
    expect(useRootOverlayStore.getState()).toMatchObject({ open: true, view: "todo" });
    expect(useKeyboardSteeringStore.getState().active).toBe(false);
  });

  it("passes an unanswered request on, without a hidden workspace tab", () => {
    showApp("mail");
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

  it("keeps the old path with no app view shown: the workspace pane takes the tab, a cockpit view steps aside", () => {
    useRootOverlayStore.setState({ open: true, view: "now" });
    render(<Harness />);
    events = listen({ overlay: true, newTab: true });
    const ev = press(CTRL_1);
    expect(events.overlay).toEqual([]);
    expect(events.newTab.map((d) => d.request)).toEqual([{ kind: "agent", slot: 0 }]);
    expect(ev.defaultPrevented).toBe(true);
    expect(useRootOverlayStore.getState().open).toBe(false);
  });

  it("with the Root view up the chord is addressed to Root's pane (RootNewTabKeys) and the window stays", () => {
    useRootOverlayStore.setState({ open: true, view: "root" });
    render(<Harness />);
    events = listen({ overlay: true, newTab: true });
    press(CTRL_1);
    // Root has no subwindow in this fixture: the empty one, not the workspace's pane.
    expect(events.newTab.map((d) => d.groupId)).toEqual([ROOT_EMPTY_GROUP_ID]);
    expect(useRootOverlayStore.getState().open).toBe(true);
  });

  it("ignores an app view whose setting is off", () => {
    showApp("calendar");
    setSettings({ ...ALL_ON, calendar_global_app: false });
    render(<Harness />);
    events = listen({ overlay: true, newTab: true });
    press(CTRL_1);
    expect(events.overlay).toEqual([]);
    expect(events.newTab.map((d) => d.request)).toEqual([{ kind: "agent", slot: 0 }]);
  });

  it("leaves the shell and monitor chords to the workspace pane", () => {
    showApp("calendar");
    render(<Harness />);
    events = listen({ overlay: true, newTab: true });
    press({ key: "N", ctrlKey: true, shiftKey: true });
    press({ key: "M", ctrlKey: true, shiftKey: true });
    expect(events.overlay).toEqual([]);
    expect(events.newTab.map((d) => d.request)).toEqual([{ kind: "shell" }, { kind: "monitor" }]);
  });
});

describe("steering's agent numbers under an app view", () => {
  let events: ReturnType<typeof listen> | null = null;

  beforeEach(() => {
    cleanup();
    document.body.innerHTML = "";
    onePane();
    setSettings(ALL_ON);
    showApp();
    useKeyboardSteeringStore.getState().exit();
    // jsdom has no layout; steering only sees a layer with a box.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 10, height: 5, x: 0, y: 0, top: 0, left: 0, right: 10, bottom: 5, toJSON: () => ({}),
    });
  });

  afterEach(() => {
    events?.off();
    events = null;
    useKeyboardSteeringStore.getState().exit();
    vi.restoreAllMocks();
  });

  // The bare 1–9 belong to the tabs levels. The window on top pulls steering
  // into its region before the key is read (`syncLayer`), where they mean
  // nothing — so they never open an agent hidden under the window.
  it("opens no hidden workspace agent", () => {
    showApp("calendar");
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop app-overlay-backdrop root-console-backdrop";
    const frame = document.createElement("div");
    frame.className = "root-overlay subwindow focused";
    frame.appendChild(document.createElement("input"));
    backdrop.appendChild(frame);
    document.body.appendChild(backdrop);
    render(<Harness />);
    act(() => useKeyboardSteeringStore.getState().enter());
    events = listen({ overlay: true, newTab: true });
    press({ key: "1", code: "Digit1" });
    expect(events.newTab).toEqual([]);
    expect(useKeyboardSteeringStore.getState()).toMatchObject({ level: "region", region: "calendar" });
  });

  it("still opens one with no app view shown", () => {
    render(<Harness />);
    act(() => useKeyboardSteeringStore.getState().enter());
    events = listen({ overlay: true, newTab: true });
    press({ key: "1", code: "Digit1" });
    expect(events.newTab.map((d) => d.request)).toEqual([{ kind: "agent", slot: 0 }]);
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

describe("shownApp", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    showApp();
    setSettings(ALL_ON);
  });

  it("is null with the window closed or on another view", () => {
    expect(shownApp()).toBeNull();
    useRootOverlayStore.setState({ open: true, view: "now" });
    expect(shownApp()).toBeNull();
    useRootOverlayStore.setState({ open: true, view: "root" });
    expect(shownApp()).toBeNull();
  });

  it("is the shown app view, only while the window is up", () => {
    showApp("mail");
    expect(shownApp()).toBe("mail");
    showApp("calendar");
    expect(shownApp()).toBe("calendar");
    useRootOverlayStore.setState({ open: false });
    expect(shownApp()).toBeNull();
  });

  it("counts a shown app only while its setting is on", () => {
    showApp("mail");
    setSettings({ ...ALL_ON, mail_client: false });
    expect(shownApp()).toBeNull();
    showApp("todo");
    setSettings({ ...ALL_ON, todo_board: false });
    expect(shownApp()).toBeNull();
  });
});
