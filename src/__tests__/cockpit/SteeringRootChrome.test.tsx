/**
 * Keyboard steering inside the Root view reaches the window's own chrome (the
 * view tabs, the rail toggle, the bar's buttons: the chrome region, ↑ from
 * Root's tabs) and the new-tab keys open a tab in Root, the one the console's +
 * menu would. The keys are the existing steering ones, so they stay rebindable.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ isFullscreen: vi.fn().mockResolvedValue(false), setFullscreen: vi.fn() }),
}));
// The views have their own suites; the + menu's probes are not under test.
vi.mock("../../components/cockpit/CockpitViews", () => ({ CockpitViewBody: () => null }));
vi.mock("../../components/tabs/TabPane", () => ({ TabPane: () => null }));
vi.mock("../../components/tabs/useAddTabMenuData", () => ({
  useAddTabMenuData: () => ({
    enabledAgents: new Set(["claude"]),
    installedCustom: null,
    customAgents: [],
    defaultAgentBin: "claude",
    agentOrder: undefined,
    localModel: undefined,
    localModelOffInRoot: undefined,
    localDrivers: [],
    vibeForLocalModel: undefined,
    compactAgentBins: new Set<string>(),
    refreshAgents: () => {},
    memberTable: null,
  }),
}));

import { RootOverlayHost } from "../../components/layout/RootOverlay";
import { useKeyboard } from "../../hooks/useKeyboard";
import { clearRegionCursor } from "../../lib/shortcuts/steeringRegion";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import type { Settings } from "../../types";

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
const agent = (key: string): TabEntry => ({ key, label: key, cmd: "claude", cwd: "/root", kind: "agent" });
const rootTabs = () => useTabsStore.getState().tabsByScope.root ?? [];
const lastRootTab = () => rootTabs()[rootTabs().length - 1];
const cursor = () => document.querySelector<HTMLElement>(".steer-cursor");
const view = () => useRootOverlayStore.getState().view;

function setSteeringKeys(steeringKeys?: Settings["steering_keys"]) {
  useSettingsStore.setState({ settings: { steering_keys: steeringKeys } as Settings });
}

beforeEach(() => {
  localStorage.clear();
  const rect = { x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 30, width: 100, height: 30, toJSON: () => ({}) };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect as DOMRect);
  setSteeringKeys();
  useTabsStore.setState({
    scope: "p",
    tabs: [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
    tabsByScope: { p: [], root: [agent("r1"), agent("r2")] },
    layoutByScope: { root: { type: "group", id: "gr", tabKeys: ["r1", "r2"], activeKey: "r1" } },
    focusedGroupByScope: { root: "gr" },
  });
  useRootOverlayStore.setState({ open: true, view: "root" });
  steering().exit();
});
afterEach(() => {
  cleanup();
  clearRegionCursor();
  vi.restoreAllMocks();
});

describe("steering reaches the root window's chrome", () => {
  it("up from Root's tabs is the window bar: the cursor starts on the shown view tab", () => {
    render(<><Harness /><RootOverlayHost /></>);
    press({ key: " ", shiftKey: true });
    expect(steering()).toMatchObject({ active: true, level: "tabs" });
    press({ key: "ArrowUp" });
    expect(steering()).toMatchObject({ level: "region", region: "chrome", regionReturn: "tabs" });
    expect(cursor()?.getAttribute("data-root-view")).toBe("root");
  });

  it("left / right walk the view tabs and the bar's buttons, never Root's own tabs or the body", () => {
    render(<><Harness /><RootOverlayHost /></>);
    press({ key: " ", shiftKey: true });
    press({ key: "ArrowUp" });
    const seen: string[] = [];
    for (let i = 0; i < 14; i++) {
      press({ key: "ArrowRight" });
      const el = cursor();
      expect(el).not.toBeNull();
      // Every target is inside the bar (or is the rail toggle) and none is a Root tab.
      expect(el!.closest(".root-overlay-bar, .cockpit-root-rail-full, .cockpit-rail-icons")).not.toBeNull();
      expect(el!.closest(".root-overlay-slot .tab-strip")).toBeNull();
      seen.push(el!.getAttribute("data-root-view") ?? el!.className);
    }
    // The five view tabs are all on the walk, in order (it wraps).
    const views = seen.filter((s) => ["now", "projects", "tonight", "usage", "root"].includes(s));
    expect(views.slice(0, 5)).toEqual(["now", "projects", "tonight", "usage", "root"]);
    // ... and the bar's buttons and the rail toggle sit on the same walk.
    expect(seen.some((c) => c.includes("cockpit-rail-expand"))).toBe(true);
    expect(seen.some((c) => c.includes("root-overlay-approvals"))).toBe(true);
    expect(seen.some((c) => c.includes("subwindow-hide"))).toBe(true);
  });

  it("Enter on a view tab opens that view; the window stays up", () => {
    render(<><Harness /><RootOverlayHost /></>);
    press({ key: " ", shiftKey: true });
    press({ key: "ArrowUp" });
    for (let i = 0; i < 8 && cursor()?.getAttribute("data-root-view") !== "now"; i++) press({ key: "ArrowLeft" });
    expect(cursor()?.getAttribute("data-root-view")).toBe("now");
    press({ key: "Enter" });
    expect(view()).toBe("now");
    expect(useRootOverlayStore.getState().open).toBe(true);
    // Still steering the bar (the view tabs are still there).
    expect(steering()).toMatchObject({ active: true, level: "region", region: "chrome" });
  });

  it("down leaves for Root's tabs, up goes on to the projects, Escape comes back", () => {
    render(<><Harness /><RootOverlayHost /></>);
    press({ key: " ", shiftKey: true });
    press({ key: "ArrowUp" });
    press({ key: "ArrowDown" });
    expect(steering()).toMatchObject({ level: "tabs", region: null });
    press({ key: "ArrowUp" });
    press({ key: "ArrowUp" });
    expect(steering()).toMatchObject({ level: "projects", region: null });
    // And back down: Root's tabs again, not the workspace's.
    press({ key: "ArrowDown" });
    press({ key: "ArrowDown" });
    press({ key: "ArrowUp" });
    expect(steering().region).toBe("chrome");
    press({ key: "Escape" });
    expect(steering()).toMatchObject({ level: expect.stringMatching(/panes|tabs/), region: null });
    expect(useRootOverlayStore.getState().open).toBe(true);
  });

  it("the keys are the steering ones, so a rebinding walks the bar too", () => {
    setSteeringKeys({ right: ["l"], left: ["h"], up: ["k"] });
    render(<><Harness /><RootOverlayHost /></>);
    press({ key: " ", shiftKey: true });
    press({ key: "ArrowUp" }); // no longer bound
    expect(steering().level).toBe("tabs");
    press({ key: "k" });
    expect(steering().region).toBe("chrome");
    const before = cursor();
    press({ key: "l" });
    expect(cursor()).not.toBe(before);
  });
});

describe("the new-tab keys open a tab in Root", () => {
  it("steering's N / O / 1 add a shell, the system monitor and the default agent to Root's tabs", () => {
    render(<><Harness /><RootOverlayHost /></>);
    press({ key: " ", shiftKey: true });
    press({ key: "n" });
    expect(rootTabs().map((t) => t.kind)).toEqual(["agent", "agent", "shell"]);
    press({ key: "o" });
    expect(lastRootTab()?.kind).toBe("monitor");
    press({ key: "1" });
    expect(lastRootTab()).toMatchObject({ kind: "agent", cmd: "claude" });
    // Nothing went to the workspace behind the window.
    expect(useTabsStore.getState().tabsByScope.p).toEqual([]);
    expect(steering().active).toBe(true);
  });

  it("an agent number with no agent behind it does nothing", () => {
    render(<><Harness /><RootOverlayHost /></>);
    press({ key: " ", shiftKey: true });
    press({ key: "5" });
    expect(rootTabs()).toHaveLength(2);
  });

  it("an empty Root takes them too", () => {
    useTabsStore.setState({ tabsByScope: { p: [], root: [] }, layoutByScope: {}, focusedGroupByScope: {} });
    render(<><Harness /><RootOverlayHost /></>);
    press({ key: " ", shiftKey: true });
    press({ key: "n" });
    expect(rootTabs().map((t) => t.kind)).toEqual(["shell"]);
  });

  it("the + key opens Root's + menu and walks it as the add-tab region", () => {
    render(<><Harness /><RootOverlayHost /></>);
    press({ key: " ", shiftKey: true });
    press({ key: "+" });
    expect(document.querySelector(".tab-add-menu")).not.toBeNull();
    expect(steering()).toMatchObject({ level: "region", region: "addTab" });
  });

  it("the chords do the same while the Root view is up, and the window stays", () => {
    render(<><Harness /><RootOverlayHost /></>);
    press({ key: "N", ctrlKey: true, shiftKey: true });
    expect(lastRootTab()?.kind).toBe("shell");
    expect(useRootOverlayStore.getState().open).toBe(true);
    press({ key: "1", ctrlKey: true });
    expect(lastRootTab()).toMatchObject({ kind: "agent", cmd: "claude" });
    expect(useRootOverlayStore.getState().open).toBe(true);
  });

  it("with the window on another view the keys are not Root's", () => {
    useRootOverlayStore.setState({ open: true, view: "now" });
    render(<><Harness /><RootOverlayHost /></>);
    press({ key: "N", ctrlKey: true, shiftKey: true });
    expect(rootTabs()).toHaveLength(2);
  });
});
