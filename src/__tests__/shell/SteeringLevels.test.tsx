/**
 * Keyboard steering as a hierarchy: projects → subwindows → tabs (↓ in, ↑ out,
 * E S D F doubling the arrows), opened on the tabs by Shift+Space and left by
 * Space / Escape / Enter, the new-tab keys inside a pane, the status jumps, the per-level
 * legend table (`steeringKeysFor`) and the region cursor that walks the side
 * panel, the header apps and a pane's + menu.
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
const jumps = vi.hoisted(() => [] as [string, string][]);
vi.mock("../../lib/shortcuts/tabJump", () => ({
  jumpToTab: (scope: string, key: string) => void jumps.push([scope, key]),
}));

import { useKeyboard } from "../../hooks/useKeyboard";
import { SteeringLegend } from "../../components/layout/SteeringLegend";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { allGroups, useTabsStore, type TabEntry } from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
import { useProjectsStore } from "../../stores/projects";
import { useActivityStore } from "../../stores/activity";
import {
  STEERING_KEYS,
  steeringKeysFor,
  steeringRowLabel,
  type SteeringLegendState,
} from "../../lib/shortcuts/shortcuts";
import {
  NEW_TAB_SHORTCUT_EVENT,
  NEW_TAB_SLOTS_EVENT,
  type NewTabShortcutDetail,
  type NewTabSlotsDetail,
} from "../../lib/shortcuts/newTabChord";
import { nextStatusTab, statusTabs } from "../../lib/shortcuts/statusJump";
import {
  activateRegionCursor,
  clearRegionCursor,
  focusRegionSearch,
  moveRegionCursor,
  moveRegionCursorByLine,
  placeRegionCursor,
  regionCursor,
  regionTargets,
} from "../../lib/shortcuts/steeringRegion";

function Harness() {
  useKeyboard({ onTogglePanels: () => {} });
  return null;
}

/** Steering listens on `document` in the capture phase, so the key has to
 *  travel through the document, not be dispatched on `window`. */
function press(init: Partial<KeyboardEventInit> & { key: string }) {
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  });
}

const steering = () => useKeyboardSteeringStore.getState();

function twoPanes() {
  const store = useTabsStore.getState();
  store.addTab({ label: "a1", cmd: "bash", cwd: "/p", kind: "shell" });
  store.addTab({ label: "a2", cmd: "bash", cwd: "/p", kind: "shell" });
  const b = store.addTab({ label: "b", cmd: "bash", cwd: "/p", kind: "shell" });
  const root = allGroups(useTabsStore.getState().layout)[0].id;
  useTabsStore.getState().splitWithTab(b.key, root, "right");
  const groups = allGroups(useTabsStore.getState().layout);
  const a = groups.find((g) => !g.tabKeys.includes(b.key))!;
  useTabsStore.getState().focusGroup(a.id);
  return { a: a.id, b: groups.find((g) => g.tabKeys.includes(b.key))!.id };
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
  jumps.length = 0;
});

afterEach(() => {
  cleanup();
  clearRegionCursor();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("steering levels", () => {
  it("starts on the tabs, climbs to the projects and goes back down", () => {
    const { a, b } = twoPanes();
    render(<Harness />);
    press({ key: " ", shiftKey: true });
    expect(steering()).toMatchObject({ active: true, level: "tabs" });
    press({ key: "ArrowUp" });
    expect(steering().level).toBe("panes");
    press({ key: "ArrowUp" });
    expect(steering().level).toBe("projects");

    press({ key: "ArrowDown" });
    expect(steering().level).toBe("panes");
    // ←/→ walk the subwindows while there are two.
    press({ key: "ArrowRight" });
    expect(useTabsStore.getState().focusedGroupId).toBe(b);
    press({ key: "ArrowLeft" });
    expect(useTabsStore.getState().focusedGroupId).toBe(a);

    press({ key: "ArrowDown" });
    expect(steering().level).toBe("tabs");
    const group = allGroups(useTabsStore.getState().layout).find((g) => g.id === a)!;
    const before = group.activeKey;
    press({ key: "ArrowRight" });
    expect(useTabsStore.getState().activeKey).not.toBe(before);
    expect(useTabsStore.getState().focusedGroupId).toBe(a);
    press({ key: "Escape" });
    expect(steering().active).toBe(false);
  });

  it("E S D F steer like the arrows, and Space leaves", () => {
    const { a, b } = twoPanes();
    render(<Harness />);
    press({ key: " ", shiftKey: true });
    const group = allGroups(useTabsStore.getState().layout).find((g) => g.id === a)!;
    const before = group.activeKey;
    press({ key: "f" });
    expect(useTabsStore.getState().activeKey).not.toBe(before);
    press({ key: "s" });
    expect(useTabsStore.getState().activeKey).toBe(before);
    press({ key: "e" });
    expect(steering().level).toBe("panes");
    press({ key: "f" });
    expect(useTabsStore.getState().focusedGroupId).toBe(b);
    press({ key: "d" });
    expect(steering().level).toBe("tabs");
    press({ key: " " });
    expect(steering().active).toBe(false);
  });

  it("leaves Shift+Space to the text in the middle of a typing burst", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);
      render(<Harness />);
      press({ key: "I", shiftKey: true });
      press({ key: " ", shiftKey: true });
      expect(steering().active).toBe(false);
      vi.setSystemTime(11_000);
      press({ key: " ", shiftKey: true });
      expect(steering().active).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("steps the tabs straight away when there is only one subwindow", () => {
    const store = useTabsStore.getState();
    store.addTab({ label: "t1", cmd: "bash", cwd: "/p", kind: "shell" });
    store.addTab({ label: "t2", cmd: "bash", cwd: "/p", kind: "shell" });
    render(<Harness />);
    press({ key: " ", shiftKey: true });
    const start = useTabsStore.getState().activeKey;
    press({ key: "ArrowRight" });
    expect(useTabsStore.getState().activeKey).not.toBe(start);
    // Up skips a panes level that would only step the same tabs.
    press({ key: "ArrowUp" });
    expect(steering().level).toBe("projects");
  });

  it("opens new tabs in the focused pane by type and stays in steering", () => {
    twoPanes();
    render(<Harness />);
    const requests: NewTabShortcutDetail[] = [];
    const onRequest = (e: Event) => {
      requests.push((e as CustomEvent<NewTabShortcutDetail>).detail);
      e.preventDefault();
    };
    window.addEventListener(NEW_TAB_SHORTCUT_EVENT, onRequest);
    try {
      press({ key: " ", shiftKey: true });
      press({ key: "n" });
      expect(requests[requests.length - 1]?.request).toEqual({ kind: "shell" });
      expect(steering().active).toBe(true);
      press({ key: "o" });
      expect(requests[requests.length - 1]?.request).toEqual({ kind: "monitor" });
      expect(steering().active).toBe(true);

      press({ key: "2" });
      expect(requests[requests.length - 1]?.request).toEqual({ kind: "agent", slot: 1 });
      expect(steering().active).toBe(true);

      press({ key: "+" });
      expect(requests[requests.length - 1]?.request).toEqual({ kind: "menu" });
      expect(steering()).toMatchObject({ active: true, level: "region", region: "addTab" });
    } finally {
      window.removeEventListener(NEW_TAB_SHORTCUT_EVENT, onRequest);
    }
  });

  it("acts on the user's steering keys, not the defaults they replaced", () => {
    const { a } = twoPanes();
    useSettingsStore.setState({
      settings: {
        steering_keys: { newShell: ["y"], right: ["l"], exit: ["Enter"], work: [] },
        keyboard_shortcuts: { steeringMode: { key: "k", ctrl: true } },
      },
    } as never);
    render(<Harness />);
    const requests: NewTabShortcutDetail[] = [];
    const onRequest = (e: Event) => {
      requests.push((e as CustomEvent<NewTabShortcutDetail>).detail);
      e.preventDefault();
    };
    window.addEventListener(NEW_TAB_SHORTCUT_EVENT, onRequest);
    try {
      // The rebound chord enters; the old Shift+Space no longer does.
      press({ key: " ", shiftKey: true });
      expect(steering().active).toBe(false);
      press({ key: "k", ctrlKey: true });
      expect(steering().active).toBe(true);

      // F lost its "right"; L has it. N does nothing any more, Y opens a shell.
      const group = allGroups(useTabsStore.getState().layout).find((g) => g.id === a)!;
      const before = group.activeKey;
      press({ key: "f" });
      expect(useTabsStore.getState().activeKey).toBe(before);
      press({ key: "l" });
      expect(useTabsStore.getState().activeKey).not.toBe(before);
      press({ key: "n" });
      expect(requests).toHaveLength(0);
      expect(steering().active).toBe(true);

      // Space and Escape are unbound now; Enter leaves.
      press({ key: " " });
      press({ key: "Escape" });
      expect(steering().active).toBe(true);
      press({ key: "Enter" });
      expect(steering().active).toBe(false);

      press({ key: "k", ctrlKey: true });
      press({ key: "y" });
      expect(requests[requests.length - 1]?.request).toEqual({ kind: "shell" });
    } finally {
      window.removeEventListener(NEW_TAB_SHORTCUT_EVENT, onRequest);
    }
  });

  it("digits on the project level jump stations and stay in the mode", () => {
    render(<Harness />);
    const setActive = vi.fn().mockResolvedValue(undefined);
    useProjectsStore.setState({
      activeId: null,
      setActive,
      projects: [{ id: "x", name: "x", status: "active", position: 0, local_file: "/x/project.json" }],
    });
    press({ key: " ", shiftKey: true });
    press({ key: "ArrowUp" });
    press({ key: "2" });
    expect(setActive).toHaveBeenCalledWith("x");
    expect(steering()).toMatchObject({ active: true, level: "projects" });
  });

  it("Q / R / X jump to the next tab in that state and land on the tab level", () => {
    const store = useTabsStore.getState();
    const t1 = store.addTab({ label: "t1", cmd: "claude", cwd: "/p", kind: "agent" });
    const t2 = store.addTab({ label: "t2", cmd: "claude", cwd: "/p", kind: "agent" });
    useActivityStore.setState({
      attentionByTab: { [`p:${t1.key}`]: "decision", [`p:${t2.key}`]: "done" },
      busyByTab: {},
    });
    render(<Harness />);
    press({ key: " ", shiftKey: true });
    press({ key: "x" });
    expect(jumps).toEqual([["p", t2.key]]);
    expect(steering().level).toBe("tabs");
    press({ key: "q" });
    expect(jumps[jumps.length - 1]).toEqual(["p", t1.key]);
    // Nothing is working: the key does nothing.
    press({ key: "r" });
    expect(jumps).toHaveLength(2);
  });

  it("marks the current level on <html> for the stylesheet, and clears it on exit", () => {
    const root = document.documentElement;
    render(<SteeringLegend />);
    expect(root.dataset.steer).toBeUndefined();
    act(() => steering().enter());
    expect(root.dataset.steer).toBe("tabs");
    act(() => steering().setLevel("projects"));
    expect(root.dataset.steer).toBe("projects");
    act(() => steering().setLevel("tabs"));
    expect(root.dataset.steer).toBe("tabs");
    act(() => steering().enterRegion("side"));
    expect(root.dataset).toMatchObject({ steer: "region", steerRegion: "side" });
    act(() => steering().leaveRegion());
    expect(root.dataset.steerRegion).toBeUndefined();
    act(() => steering().exit());
    expect(root.dataset.steer).toBeUndefined();
  });

  it("leaves the side panel on the key that opened it, as on Escape", () => {
    twoPanes();
    const onSidePanel = vi.fn((open: boolean) => {
      document.querySelector(".side-panel")?.remove();
      if (open) document.body.insertAdjacentHTML("beforeend", `<div class="side-panel open"><button>x</button></div>`);
    });
    function SideHarness() {
      useKeyboard({ onTogglePanels: () => {}, onSidePanel });
      return null;
    }
    render(<SideHarness />);
    press({ key: " ", shiftKey: true });
    press({ key: "b" });
    expect(steering()).toMatchObject({ level: "region", region: "side" });
    expect(onSidePanel).toHaveBeenLastCalledWith(true);
    press({ key: "b" });
    expect(steering()).toMatchObject({ active: true, level: "tabs" });
    expect(onSidePanel).toHaveBeenLastCalledWith(false);
    // Escape still does the same.
    press({ key: "b" });
    press({ key: "Escape" });
    expect(steering()).toMatchObject({ active: true, level: "tabs" });
    expect(document.querySelector(".side-panel.open")).toBeNull();
  });

  it("shows the pane's agent digits as one 1–N CLIs entry, names on hover", () => {
    twoPanes();
    const answer = (e: Event) => {
      (e as CustomEvent<NewTabSlotsDetail>).detail.labels = ["Claude", "Codex", "Gemini", null];
    };
    window.addEventListener(NEW_TAB_SLOTS_EVENT, answer);
    try {
      render(<SteeringLegend />);
      act(() => steering().enter());
      const items = [...document.querySelectorAll(".steering-legend-item")];
      const clis = items.find((el) => el.textContent?.includes("CLIs"));
      expect(clis?.querySelector("kbd")?.textContent).toBe("1–3");
      expect(clis?.getAttribute("title")).toBe("1 Claude · 2 Codex · 3 Gemini");
      expect(items.some((el) => el.textContent?.includes("Codex"))).toBe(false);
    } finally {
      window.removeEventListener(NEW_TAB_SLOTS_EVENT, answer);
    }
  });

  it("hides the mouse pointer until the mouse really moves, and again on the next key", () => {
    const root = document.documentElement;
    const move = (x: number, y: number) =>
      act(() => {
        window.dispatchEvent(new MouseEvent("mousemove", { screenX: x, screenY: y }));
      });
    render(<SteeringLegend />);
    expect(root.dataset.steerPointer).toBeUndefined();
    act(() => steering().enter());
    expect(root.dataset.steerPointer).toBe("hidden");
    // A still pointer (layout changed under it) keeps it hidden.
    move(100, 100);
    move(100, 100);
    expect(root.dataset.steerPointer).toBe("hidden");
    move(140, 100);
    expect(root.dataset.steerPointer).toBeUndefined();
    press({ key: "ArrowRight" });
    expect(root.dataset.steerPointer).toBe("hidden");
    act(() => steering().exit());
    expect(root.dataset.steerPointer).toBeUndefined();
  });
});

describe("status walk", () => {
  const tab = (key: string, kind: TabEntry["kind"] = "agent") => ({ key, kind }) as TabEntry;

  it("orders by station ring, then any other scope, then strip order, and wraps", () => {
    useProjectsStore.setState({
      projects: [{ id: "p", name: "p", status: "active", position: 0, local_file: "/p/project.json" }],
    });
    const tabsByScope = { "box:1": [tab("z")], p: [tab("b"), tab("a")], root: [tab("r")] };
    const attention = { "p:a": "done", "p:b": "done", "box:1:z": "done", "root:r": "done" } as const;
    const list = statusTabs("done", {}, { ...attention }, tabsByScope);
    expect(list.map((t) => `${t.scope}:${t.key}`)).toEqual(["root:r", "p:b", "p:a", "box:1:z"]);
    expect(nextStatusTab(list, { scope: "box:1", key: "z" }, 1)).toEqual({ scope: "root", key: "r" });
    expect(nextStatusTab(list, null, -1)).toEqual({ scope: "box:1", key: "z" });
    expect(nextStatusTab([], null, 1)).toBeNull();
  });

  it("counts only terminal tabs as working", () => {
    const list = statusTabs("working", { "p:a": true, "p:v": true }, {}, { p: [tab("a"), tab("v", "embed")] });
    expect(list).toEqual([{ scope: "p", key: "a" }]);
  });
});

describe("legend table", () => {
  const base: SteeringLegendState = {
    level: "projects",
    sideRegion: false,
    multiPane: false,
    apps: { mail: false, calendar: false, todo: false },
    statusCounts: { decision: 0, working: 0, done: 0 },
  };
  const labels = (s: Partial<SteeringLegendState>) =>
    steeringKeysFor({ ...base, ...s }).map((k) => k.labelKey);

  it("lists a header app only while it is switched on", () => {
    expect(labels({})).not.toContain("steering.mail.label");
    expect(labels({ apps: { mail: true, calendar: false, todo: false } })).toContain("steering.mail.label");
  });

  it("names what ←/→ do on the panes level", () => {
    expect(labels({ level: "panes", multiPane: true })).toContain("steering.focus.label");
    expect(labels({ level: "panes", multiPane: true })).not.toContain("steering.tabs.label");
    expect(labels({ level: "panes" })).toContain("steering.tabs.label");
    expect(labels({ level: "tabs", multiPane: true })).toContain("steering.tabs.label");
  });

  it("shows the new-tab keys inside a pane and the status jumps only when something is in that state", () => {
    expect(labels({ level: "panes" })).toEqual(
      expect.arrayContaining(["steering.newShell.label", "steering.newAgent.label", "steering.newTabMenu.label"]),
    );
    expect(labels({})).not.toContain("steering.nextDone.label");
    expect(labels({ statusCounts: { decision: 0, working: 0, done: 2 } })).toContain("steering.nextDone.label");
  });

  it("never lists the same key twice on one level", () => {
    const states: Partial<SteeringLegendState>[] = [
      { level: "projects", apps: { mail: true, calendar: true, todo: true } },
      { level: "panes", multiPane: true },
      { level: "panes" },
      { level: "tabs" },
      { level: "region", sideRegion: true },
    ];
    for (const s of states) {
      const keys = steeringKeysFor({ ...base, ...s, statusCounts: { decision: 1, working: 1, done: 1 } }).map(
        (k) => steeringRowLabel(k, null),
      );
      expect(new Set(keys).size, JSON.stringify(s)).toBe(keys.length);
    }
    expect(STEERING_KEYS.every((k) => k.levels.length > 0)).toBe(true);
  });
});

describe("region cursor", () => {
  function surface() {
    document.body.innerHTML = `
      <div id="root">
        <button id="b1">one</button>
        <div id="row" style="cursor: pointer"><span id="label" style="cursor: pointer">row</span></div>
        <input id="field" type="text" />
        <button id="gone" hidden>hidden</button>
      </div>`;
    // jsdom lays nothing out; give every element a box.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 10,
      height: 10,
    } as DOMRect);
    return document.getElementById("root")!;
  }

  it("/ hands the surface's text field the caret, and only on request", () => {
    const root = surface();
    placeRegionCursor(root);
    expect(document.activeElement?.id).not.toBe("field");
    expect(focusRegionSearch(root)).toBe(true);
    expect(document.activeElement?.id).toBe("field");
    expect(regionCursor()).toBeNull();
    document.getElementById("field")!.remove();
    expect(focusRegionSearch(root)).toBe(false);
  });

  it("finds controls and clickable rows once, skipping what is hidden", () => {
    const root = surface();
    expect(regionTargets(root).map((el) => el.id)).toEqual(["b1", "row", "field"]);
  });

  it("walks with wrapping, presses a button, and hands a text field the caret", () => {
    const root = surface();
    const clicked = vi.fn();
    document.getElementById("row")!.addEventListener("click", clicked);
    expect(placeRegionCursor(root)).toBe(true);
    expect(regionCursor()?.id).toBe("b1");
    moveRegionCursor(root, -1);
    expect(regionCursor()?.id).toBe("field");
    moveRegionCursor(root, 1);
    moveRegionCursor(root, 1);
    expect(regionCursor()?.id).toBe("row");
    expect(regionCursor()?.classList.contains("steer-cursor")).toBe(true);
    expect(activateRegionCursor()).toBe("press");
    expect(clicked).toHaveBeenCalledTimes(1);
    moveRegionCursor(root, 1);
    expect(activateRegionCursor()).toBe("type");
    expect(document.activeElement?.id).toBe("field");
    expect(document.querySelector(".steer-cursor")).toBeNull();
  });

  it("steps whole lines: a toolbar, then row by row past each row's own buttons", () => {
    document.body.innerHTML = `
      <div id="root">
        <button id="t1" data-top="0">reply</button>
        <button id="t2" data-top="0">delete</button>
        <div id="r1" role="button" data-top="20" data-height="30"><button id="r1b" data-top="22">☐</button></div>
        <div id="r2" role="button" data-top="50" data-height="30"><button id="r2b" data-top="52">☐</button></div>
      </div>`;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const top = Number(this.dataset.top ?? 0);
      const height = Number(this.dataset.height ?? 10);
      return { top, bottom: top + height, width: 10, height } as DOMRect;
    });
    const root = document.getElementById("root")!;
    const at = () => regionCursor()?.id;
    moveRegionCursorByLine(root, 1);
    expect(at()).toBe("t1");
    moveRegionCursorByLine(root, 1);
    expect(at()).toBe("r1");
    moveRegionCursorByLine(root, 1);
    expect(at()).toBe("r2");
    // From a row's own button, ↑ goes to the row above, not back onto its row.
    moveRegionCursor(root, 1);
    expect(at()).toBe("r2b");
    moveRegionCursorByLine(root, -1);
    expect(at()).toBe("r1");
    moveRegionCursorByLine(root, -1);
    moveRegionCursorByLine(root, -1);
    expect(at()).toBe("r2");
  });
});
