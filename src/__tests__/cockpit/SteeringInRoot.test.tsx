/**
 * Keyboard steering while the Root view is up (`lib/shortcuts/steeringScope`):
 * its tab levels walk **Root's** tabs and the keys that act on "the active tab"
 * act on Root's, so after a status key jumped to a root agent the arrows do not
 * step the workspace's tab bar behind the window, and what is typed after
 * leaving steering goes to the root terminal. Same keys, still rebindable.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ isFullscreen: vi.fn().mockResolvedValue(false), setFullscreen: vi.fn() }),
}));
// What the real door does for a root tab (`jumpToTab`): reveal it and open the
// Root view; a project tab is brought up in the workspace.
const jumps = vi.hoisted(() => [] as [string, string][]);
vi.mock("../../lib/shortcuts/tabJump", async () => {
  const { useRootOverlayStore } = await import("../../stores/rootOverlay");
  const { useTabsStore } = await import("../../stores/tabs");
  return {
    jumpToTab: (scope: string, key: string) => {
      jumps.push([scope, key]);
      if (scope === "root") {
        useTabsStore.getState().revealTabInScope("root", key);
        useRootOverlayStore.setState({ open: true, view: "root" });
      }
    },
  };
});

import { useKeyboard } from "../../hooks/useKeyboard";
import { steeringActiveTab } from "../../lib/shortcuts/steeringAgent";
import { activeTabElement, clearRegionCursor, topLayer } from "../../lib/shortcuts/steeringRegion";
import { useActivityStore } from "../../stores/activity";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore, type LayoutNode, type TabEntry } from "../../stores/tabs";
import type { Settings } from "../../types";

function Harness() {
  useKeyboard({ onTogglePanels: () => {} });
  return null;
}
function press(init: Partial<KeyboardEventInit> & { key: string }) {
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  });
}
const steering = () => useKeyboardSteeringStore.getState();
const shell = (key: string): TabEntry => ({ key, label: key, cmd: "bash", cwd: "/p", kind: "shell" });
const agent = (key: string): TabEntry => ({ key, label: key, cmd: "claude", cwd: "/p", kind: "agent" });
const group = (id: string, keys: string[], activeKey: string): LayoutNode => ({ type: "group", id, tabKeys: keys, activeKey });

function setSteeringKeys(steeringKeys?: Settings["steering_keys"]) {
  useSettingsStore.setState({ settings: { steering_keys: steeringKeys } as Settings });
}

beforeEach(() => {
  jumps.length = 0;
  setSteeringKeys();
  useTabsStore.setState({
    scope: "p",
    tabs: [shell("w1"), shell("w2")],
    layout: group("gw", ["w1", "w2"], "w1"),
    focusedGroupId: "gw",
    activeKey: "w1",
    fullscreenGroupId: null,
    tabsByScope: { p: [shell("w1"), shell("w2")], root: [agent("r1"), agent("r2"), agent("r3")] },
    layoutByScope: { p: group("gw", ["w1", "w2"], "w1"), root: group("gr", ["r1", "r2", "r3"], "r1") },
    focusedGroupByScope: { p: "gw", root: "gr" },
  });
  useActivityStore.setState({ busyByTab: {}, attentionByTab: { "root:r3": "decision" }, lastDoneByTab: {}, lastWorkingByTab: {} });
  useRootOverlayStore.setState({ open: true, view: "root" });
  useKeyboardSteeringStore.getState().exit();
});
afterEach(() => {
  cleanup();
  clearRegionCursor();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const rootActive = () => (useTabsStore.getState().layoutByScope.root as { activeKey: string }).activeKey;
const workspaceActive = () => (useTabsStore.getState().layoutByScope.p as { activeKey: string }).activeKey;

describe("steering with the Root view up", () => {
  it("walks Root's tabs with the arrows, leaving the workspace's alone", () => {
    render(<Harness />);
    press({ key: " ", shiftKey: true });
    expect(steering()).toMatchObject({ active: true, level: "tabs" });
    press({ key: "ArrowRight" });
    expect(rootActive()).toBe("r2");
    press({ key: "ArrowRight" });
    expect(rootActive()).toBe("r3");
    press({ key: "ArrowLeft" });
    expect(rootActive()).toBe("r2");
    expect(workspaceActive()).toBe("w1");
    expect(useTabsStore.getState().activeKey).toBe("w1");
    // The key that "acts on the active tab" acts on this one.
    expect(steeringActiveTab()).toMatchObject({ scope: "root", tab: { key: "r2" } });
  });

  it("after a status key jumps to a root agent, the tabs level is Root's", () => {
    render(<Harness />);
    press({ key: " ", shiftKey: true });
    press({ key: "q" }); // next tab that asks (the default key)
    expect(jumps).toEqual([["root", "r3"]]);
    expect(rootActive()).toBe("r3");
    expect(steering().level).toBe("tabs");
    press({ key: "ArrowLeft" });
    expect(rootActive()).toBe("r2");
    expect(workspaceActive()).toBe("w1");
    // The walk goes on from the root tab, not from the workspace's active one.
    press({ key: "q" });
    expect(jumps[1]).toEqual(["root", "r3"]);
  });

  it("the keys stay rebindable: a user's binding walks Root too", () => {
    setSteeringKeys({ right: ["l"], left: ["h"] });
    render(<Harness />);
    press({ key: " ", shiftKey: true });
    press({ key: "l" });
    expect(rootActive()).toBe("r2");
    press({ key: "ArrowRight" }); // no longer bound
    expect(rootActive()).toBe("r2");
    expect(workspaceActive()).toBe("w1");
  });

  it("the new-tab keys open nothing behind the window", () => {
    const heard = vi.fn((e: Event) => e.preventDefault());
    window.addEventListener("app:new-tab-shortcut", heard);
    render(<Harness />);
    press({ key: " ", shiftKey: true });
    press({ key: "ArrowUp" }); // projects level cannot take them; back to tabs
    press({ key: "ArrowDown" });
    press({ key: "ArrowDown" });
    for (const key of ["n", "o", "1"]) press({ key });
    window.removeEventListener("app:new-tab-shortcut", heard);
    expect(heard).not.toHaveBeenCalled();
  });

  it("in a split Root, the active tab element is the focused subwindow's, not the first one's", () => {
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, toJSON: () => ({}) };
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect as DOMRect);
    document.body.innerHTML =
      '<div class="modal-backdrop root-overlay-backdrop root-console-backdrop"><div class="root-overlay">' +
      '<div class="tab-bar"><div class="tab-strip root-view-strip"><div class="tab root-view-tab active" id="view"></div></div></div>' +
      '<div class="subwindow root-overlay-group"><div class="tab-bar"><div class="tab-strip"><div class="tab active" id="first">r1</div></div></div></div>' +
      '<div class="subwindow root-overlay-group focused"><div class="tab-bar"><div class="tab-strip"><div class="tab active" id="second">r2</div></div></div></div>' +
      "</div></div>";
    expect(activeTabElement()?.id).toBe("second");
  });

  it("a jump to a project's tab steps the window aside, so the workspace is walked again", () => {
    useActivityStore.setState({ attentionByTab: { "p:w2": "decision" } });
    render(<Harness />);
    press({ key: " ", shiftKey: true });
    press({ key: "q" });
    expect(jumps).toEqual([["p", "w2"]]);
    expect(useRootOverlayStore.getState().open).toBe(false);
  });

  it("the window is the place steered, not an overlay over it (a menu over it still is)", () => {
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, toJSON: () => ({}) };
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect as DOMRect);
    document.body.innerHTML =
      '<div class="modal-backdrop root-overlay-backdrop root-console-backdrop"><div class="root-overlay" aria-modal="true">' +
      '<div class="tab-strip"><div class="tab active" id="rt">r1</div></div></div></div>' +
      '<div class="context-menu-portal" id="menu"></div>';
    expect(topLayer()?.id).toBe("menu");
    document.getElementById("menu")!.remove();
    expect(topLayer()).toBeNull();
    // And its active tab is the one in the Root strip (the tab menu's target).
    expect(activeTabElement()?.id).toBe("rt");
    // Steering stays on the tab level through a key (no overlay region).
    render(<Harness />);
    press({ key: " ", shiftKey: true });
    press({ key: "ArrowRight" });
    expect(steering().level).toBe("tabs");
    expect(rootActive()).toBe("r2");
  });
});

describe("steering without the Root view", () => {
  it("walks the workspace's tabs when the window is shut", () => {
    useRootOverlayStore.setState({ open: false });
    render(<Harness />);
    press({ key: " ", shiftKey: true });
    press({ key: "ArrowRight" });
    expect(workspaceActive()).toBe("w2");
    expect(rootActive()).toBe("r1");
  });

  it("walks the workspace's tabs on a cockpit view", () => {
    useRootOverlayStore.setState({ open: true, view: "now" });
    render(<Harness />);
    press({ key: " ", shiftKey: true });
    press({ key: "ArrowRight" });
    expect(workspaceActive()).toBe("w2");
    expect(rootActive()).toBe("r1");
  });
});
