/**
 * Keyboard steering inside a popout window: the main window's own handler
 * (`useSteering`, surface "popout") over the popout's streamed tree and tabs
 * (`stores/popoutView`), its writes routed to the main window as edits through
 * the detached context. Rendered here over a real `DetachedCenterPanel` with a
 * detached context installed, which is what makes this heap a popout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(false)) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/api/window", () => ({
  cursorPosition: vi.fn(() => Promise.resolve({ x: 0, y: 0 })),
  getCurrentWindow: () => ({
    label: "detached-p-pop",
    innerPosition: () => Promise.resolve({ x: 0, y: 0 }),
    outerPosition: () => Promise.resolve({ x: 0, y: 0 }),
    outerSize: () => Promise.resolve({ width: 800, height: 600 }),
    scaleFactor: () => Promise.resolve(1),
    onMoved: () => Promise.resolve(() => {}),
    isFullscreen: () => Promise.resolve(false),
    setFullscreen: () => Promise.resolve(),
  }),
}));
vi.mock("../../components/tabs/TabPane", () => ({ TabPane: () => <div /> }));
// The + menu's probes are not under test: one installed agent, Claude.
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
// The window buttons, as `WindowControls` draws them (`.wm-controls`).
vi.mock("../../components/header/WindowControls", () => ({
  WindowControls: () => (
    <div className="wm-controls no-drag">
      <button type="button" className="wm-minimize">_</button>
      <button type="button" className="wm-close">x</button>
    </div>
  ),
}));

import { emit } from "@tauri-apps/api/event";
import { useSteering } from "../../hooks/useSteering";
import { DetachedCenterPanel } from "../../components/layout/DetachedCenterPanel";
import { SteeringLegend } from "../../components/layout/SteeringLegend";
import { SteeringConfirmOverlay } from "../../components/layout/SteeringConfirmOverlay";
import { setDetachedWindowContext } from "../../stores/detachedContext";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { usePopoutViewStore } from "../../stores/popoutView";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore, type LayoutNode, type TabEntry } from "../../stores/tabs";
import { clearRegionCursor, forgetRegionCursors, regionCursor } from "../../lib/shortcuts/steeringRegion";
import { ladder } from "../../lib/shortcuts/steeringBar";
import { steeringKeysFor } from "../../lib/shortcuts/shortcuts";

/** Apart from what re-renders, as in the app. */
function Steering() {
  useSteering({ surface: "popout" });
  return null;
}

const tab = (key: string): TabEntry => ({ key, label: key.toUpperCase(), cmd: "bash", cwd: "/p", kind: "shell" });
const one: LayoutNode = { type: "group", id: "g1", tabKeys: ["a", "b"], activeKey: "a" };
const split: LayoutNode = {
  type: "split",
  id: "s1",
  dir: "row",
  sizes: [0.5, 0.5],
  children: [
    { type: "group", id: "g1", tabKeys: ["a", "b"], activeKey: "a" },
    { type: "group", id: "g2", tabKeys: ["c"], activeKey: "c" },
  ],
};

const pushEdit = vi.fn();
const closeTab = vi.fn();
const onAddTab = vi.fn();
const steering = () => useKeyboardSteeringStore.getState();

function press(key: string, init: KeyboardEventInit = {}) {
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
  });
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
}

function mount(tree: LayoutNode = one, tabs: TabEntry[] = [tab("a"), tab("b"), tab("c")]) {
  return render(
    <>
      <Steering />
      <DetachedCenterPanel
        scope="p" popoutId="pop" tree={tree} tabs={tabs}
        onSplit={vi.fn()} onMove={vi.fn()} onReorder={vi.fn()}
        onActivate={vi.fn()} onClose={vi.fn()} onSetLocation={vi.fn()}
        onResize={vi.fn()} onAddTab={onAddTab} onFiles={vi.fn()}
        onDockWindow={vi.fn()}
      />
      <SteeringLegend />
      <SteeringConfirmOverlay />
    </>,
  );
}

/** Steering turned on with its chord, as the user does. */
function chord() {
  press(" ", { code: "Space", shiftKey: true });
}

beforeEach(() => {
  pushEdit.mockClear();
  closeTab.mockClear();
  onAddTab.mockClear();
  setDetachedWindowContext({
    scope: "p",
    groupId: "pop",
    label: "detached-p-pop",
    targetGroupId: () => "g1",
    pushEdit,
    closeTab,
  });
  usePopoutViewStore.getState().reset();
  useTabsStore.setState({ scope: "root", tabs: [], layout: null, focusedGroupId: null, activeKey: null, tabsByScope: {} });
  useSettingsStore.setState({ settings: null });
  steering().exit();
  forgetRegionCursors();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 10, height: 5, x: 0, y: 0, top: 0, left: 0, right: 10, bottom: 5, toJSON: () => ({}),
  });
  if (typeof ResizeObserver === "undefined") {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  }
});

afterEach(() => {
  cleanup();
  clearRegionCursor();
  steering().exit();
  setDetachedWindowContext(null);
  usePopoutViewStore.getState().reset();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("steering in a popout", () => {
  it("the chord turns it on, on the popout's tabs, and lights the markers", () => {
    mount();
    chord();
    expect(steering()).toMatchObject({ active: true, level: "tabs" });
    expect(document.documentElement.dataset.steer).toBe("tabs");
    // The popout's tabs store stays empty: nothing mirrored a layout into it.
    expect(useTabsStore.getState().layout).toBeNull();
  });

  it("left / right step its tabs through activate edits", () => {
    mount();
    chord();
    press("ArrowRight");
    expect(pushEdit).toHaveBeenCalledWith({ kind: "activate", key: "b" });
  });

  it("Shift+right and the subwindows level move the popout's own focus", () => {
    mount(split);
    chord();
    expect(usePopoutViewStore.getState().focusedGroupId).toBe("g1");
    press("ArrowRight", { shiftKey: true });
    expect(usePopoutViewStore.getState().focusedGroupId).toBe("g2");
    // Up from the tabs of a split popout: its subwindows.
    press("ArrowUp");
    expect(steering().level).toBe("panes");
    press("ArrowRight");
    expect(usePopoutViewStore.getState().focusedGroupId).toBe("g1");
    // No subwindow focus left the popout.
    expect(pushEdit).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "focus" }));
  });

  it("W asks, and its yes closes the tab the way the popout's × does", async () => {
    mount();
    chord();
    press("w");
    await settle();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    press("w");
    await settle();
    expect(closeTab).toHaveBeenCalledWith("a");
  });

  it("up from the tabs walks the title bar's buttons, the window buttons included", () => {
    mount();
    chord();
    press("ArrowUp");
    expect(steering()).toMatchObject({ level: "region", region: "chrome" });
    expect(regionCursor()?.classList.contains("detached-dock-btn")).toBe(true);
    press("ArrowRight");
    expect(regionCursor()?.closest(".wm-controls")).not.toBeNull();
    // Down: back to the tabs.
    press("ArrowDown");
    expect(steering().level).toBe("tabs");
  });

  it("N and 1 open a shell and the first agent beside the active tab, through the popout's add", () => {
    mount();
    chord();
    press("n");
    expect(onAddTab).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "shell" }),
      "g1",
      undefined,
      { besideActive: true },
    );
    press("1");
    expect(onAddTab).toHaveBeenLastCalledWith(
      expect.objectContaining({ cmd: expect.stringContaining("claude") }),
      "g1",
      undefined,
      { besideActive: true },
    );
    // Steering keeps the keyboard.
    expect(steering()).toMatchObject({ active: true, level: "tabs" });
  });

  it("Ctrl+Shift+N opens a shell in the popout without steering", () => {
    mount();
    press("N", { ctrlKey: true, shiftKey: true, code: "KeyN" });
    expect(onAddTab).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "shell" }), "g1", undefined, undefined);
  });

  it("+ opens the popout's own + menu and walks it", async () => {
    mount();
    chord();
    press("+");
    await settle();
    expect(document.querySelector(".tab-add-menu")).not.toBeNull();
    expect(steering()).toMatchObject({ level: "region", region: "addTab" });
  });

  it("the subwindows level numbers the popout's subwindows", () => {
    mount(split);
    chord();
    press("ArrowUp");
    expect(steering().level).toBe("panes");
    const badges = Array.from(document.querySelectorAll(".subwindow-number")).map((b) => b.textContent);
    expect(badges).toEqual(["0", "1↓"]);
  });

  it("its bar has no projects: Title bar over the tabs (no Main window rung), main-only keys apart", () => {
    const rungs = ladder({ level: "tabs", region: null, regionReturn: "tabs", popout: true });
    expect(rungs.map((r) => r.id)).toEqual(["titleBar", "panes", "tabs", "scroll"]);
    expect(rungs.find((r) => r.lit)?.id).toBe("tabs");
    // One subwindow: no Subwindows rung, as in the main window's ladder.
    const single = ladder({ level: "tabs", region: null, regionReturn: "tabs", popout: true, multiPane: false });
    expect(single.map((r) => r.id)).toEqual(["titleBar", "tabs", "scroll"]);
    expect(single.find((r) => r.lit)?.id).toBe("tabs");
    const onTitleBar = ladder({ level: "region", region: "chrome", regionReturn: "tabs", popout: true });
    expect(onTitleBar.find((r) => r.lit)?.labelKey).toBe("steering.region.titleBar");

    const state = {
      level: "tabs" as const,
      sideRegion: false,
      multiPane: false,
      apps: { mail: false, calendar: false, todo: false },
      statusCounts: { decision: 0, working: 0, done: 0 },
      popouts: true,
      popout: true,
    };
    const rows = steeringKeysFor(state);
    const labels = rows.map((r) => r.labelKey);
    expect(labels).toContain("steering.upTitleBar.label");
    expect(labels).not.toContain("steering.up.label");
    // The one way to the main window is a key, on every level of the popout.
    expect(rows.find((r) => r.actions[0] === "mainWindow")?.group).toBe("main");
    for (const level of ["panes", "tabs", "scroll", "region"] as const) {
      expect(steeringKeysFor({ ...state, level }).some((r) => r.actions[0] === "mainWindow")).toBe(true);
    }
    expect(rows.find((r) => r.actions[0] === "settings")?.group).toBe("main");
    expect(rows.find((r) => r.actions[0] === "closeTab")?.group).toBe("act");
    // The main window's own bar is unchanged, and has no Main window key.
    const main = steeringKeysFor({ ...state, popout: false });
    expect(main.find((r) => r.actions[0] === "settings")?.group).toBe("open");
    expect(main.map((r) => r.labelKey)).toContain("steering.up.label");
    for (const level of ["panes", "tabs", "scroll", "region"] as const) {
      expect(steeringKeysFor({ ...state, popout: false, level }).some((r) => r.actions[0] === "mainWindow")).toBe(false);
    }
  });

  it("the bar lists the Main window key first, with its label", () => {
    mount();
    chord();
    const items = Array.from(document.querySelectorAll(".steering-bar-keys .steering-bar-item"));
    expect(items[0].querySelector(".steering-bar-label")?.textContent).toBe("Main window");
    expect(items[0].querySelector(".steering-bar-caps")?.textContent).toBe("Home");
    // In the bar itself, not pinned as a floating cap.
    expect(document.querySelector(".steering-caps")?.textContent ?? "").not.toContain("Home");
    // The ladder no longer has a Main window rung.
    const rungs = Array.from(document.querySelectorAll(".steering-rung")).map((r) => r.textContent);
    expect(rungs).not.toContain("Main window");
    expect(rungs).toContain("Title bar");
  });

  it("Home hands the keyboard over from the tabs, and up stops at the title bar", () => {
    mount();
    chord();
    vi.mocked(emit).mockClear();
    press("Home");
    expect(emit).toHaveBeenCalledWith(
      "detached-steer",
      expect.objectContaining({ label: "detached-p-pop", act: { kind: "enter" } }),
    );
    // Steering stays on in the popout until the main window announces itself.
    expect(steering()).toMatchObject({ active: true, level: "tabs" });
    press("ArrowUp");
    expect(steering()).toMatchObject({ level: "region", region: "chrome" });
    vi.mocked(emit).mockClear();
    press("ArrowUp");
    expect(steering()).toMatchObject({ level: "region", region: "chrome" });
    expect(emit).not.toHaveBeenCalled();
  });

  it("a key whose target is the main window's does nothing here", () => {
    const opened = vi.fn();
    window.addEventListener("app:open-settings", opened);
    try {
      mount();
      chord();
      press("/");
      press("m");
      expect(opened).not.toHaveBeenCalled();
      expect(steering()).toMatchObject({ active: true, level: "tabs", region: null });
    } finally {
      window.removeEventListener("app:open-settings", opened);
    }
  });
});
