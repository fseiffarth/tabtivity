/**
 * Ctrl+Tab / Ctrl+Shift+Tab (`nextProjectTab` / `prevProjectTab`): every tab of
 * the project in document order, across its subwindows — past a subwindow's
 * last tab comes the next one's first and focus moves along; the ends wrap.
 * Works from a focused pane terminal too. Next / previous project moved to
 * AltGr+Tab / AltGr+Shift+Tab (right Alt), Alt+Shift+→ / ← kept as aliases.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ isFullscreen: vi.fn().mockResolvedValue(false), setFullscreen: vi.fn() }),
}));

import { useKeyboard } from "../../hooks/useKeyboard";
import {
  actionMatches,
  chordFromEvent,
  chordLabel,
  chordMatches,
  findConflicts,
  resolveChord,
  type ShortcutAction,
} from "../../lib/shortcuts/shortcuts";
import { terminalMayTakeChord, terminalYieldsChord } from "../../lib/shortcuts/terminalTabChord";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { useSettingsStore } from "../../stores/settings";
import { allGroups, stepOrderedTab, useTabsStore, type LayoutNode, type TabEntry } from "../../stores/tabs";
import type { Settings } from "../../types";

function Harness() {
  useKeyboard({ onTogglePanels: () => {} });
  return null;
}
function chord(action: ShortcutAction, target: Element = document.body): KeyboardEvent {
  const c = resolveChord(action, undefined);
  const e = new KeyboardEvent("keydown", {
    key: c.key,
    ctrlKey: !!c.ctrl,
    shiftKey: !!c.shift,
    altKey: !!c.alt,
    metaKey: !!c.meta,
    bubbles: true,
    cancelable: true,
  });
  expect(chordMatches(c, e)).toBe(true);
  act(() => {
    target.dispatchEvent(e);
  });
  return e;
}
const tab = (key: string): TabEntry => ({ key, label: key, cmd: "bash", cwd: "/p", kind: "shell" });
const group = (id: string, keys: string[], activeKey: string): LayoutNode => ({ type: "group", id, tabKeys: keys, activeKey });
const split = (a: LayoutNode, b: LayoutNode): LayoutNode =>
  ({ type: "split", id: "s", direction: "row", sizes: [50, 50], children: [a, b] }) as unknown as LayoutNode;

function seed(layout: LayoutNode, focused: string) {
  const tabs = allGroups(layout).flatMap((g) => g.tabKeys).map(tab);
  useTabsStore.setState({
    scope: "p",
    tabs,
    layout,
    focusedGroupId: focused,
    activeKey: allGroups(layout).find((g) => g.id === focused)?.activeKey ?? null,
    fullscreenGroupId: null,
    tabsByScope: { p: tabs },
    layoutByScope: { p: layout },
    focusedGroupByScope: { p: focused },
  });
}
const now = () => {
  const s = useTabsStore.getState();
  return { focused: s.focusedGroupId, active: s.activeKey };
};

beforeEach(() => {
  useSettingsStore.setState({ settings: {} as Settings });
  useRootOverlayStore.setState({ open: false, view: "root" });
  seed(split(group("ga", ["a1", "a2"], "a2"), group("gb", ["b1", "b2"], "b1")), "ga");
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("project tab cycle", () => {
  it("defaults: Ctrl+Tab / Ctrl+Shift+Tab", () => {
    expect(resolveChord("nextProjectTab", undefined)).toEqual({ key: "Tab", ctrl: true });
    expect(resolveChord("prevProjectTab", undefined)).toEqual({ key: "Tab", ctrl: true, shift: true });
    expect(findConflicts(undefined).size).toBe(0);
  });

  it("runs on into the next subwindow, moving focus, and wraps both ways", () => {
    render(<Harness />);
    expect(chord("nextProjectTab").defaultPrevented).toBe(true);
    expect(now()).toEqual({ focused: "gb", active: "b1" });
    chord("nextProjectTab");
    expect(now()).toEqual({ focused: "gb", active: "b2" });
    chord("nextProjectTab");
    expect(now()).toEqual({ focused: "ga", active: "a1" });
    chord("prevProjectTab");
    expect(now()).toEqual({ focused: "gb", active: "b2" });
  });

  it("is handed over by a focused pane terminal", () => {
    render(<Harness />);
    document.body.innerHTML = '<textarea class="xterm-helper-textarea" id="t"></textarea>';
    expect(chord("nextProjectTab", document.getElementById("t")!).defaultPrevented).toBe(true);
    expect(now()).toEqual({ focused: "gb", active: "b1" });
  });

  it("carries a fullscreen subwindow along", () => {
    useTabsStore.setState({ fullscreenGroupId: "ga" });
    render(<Harness />);
    chord("nextProjectTab");
    expect(useTabsStore.getState().fullscreenGroupId).toBe("gb");
  });

  it("does nothing with a single tab", () => {
    seed(group("g", ["only"], "only"), "g");
    render(<Harness />);
    expect(chord("nextProjectTab").defaultPrevented).toBe(false);
  });

  it("on another view of the root window leaves the workspace alone", () => {
    useRootOverlayStore.setState({ open: true, view: "now" as never });
    render(<Harness />);
    chord("nextProjectTab");
    expect(now()).toEqual({ focused: "ga", active: "a2" });
  });
});

describe("stepOrderedTab", () => {
  it("falls back to the first group when the focus is unknown", () => {
    const layout = split(group("ga", ["a1"], "a1"), group("gb", ["b1"], "b1"));
    expect(stepOrderedTab(layout, "gone", 1)).toEqual({ groupId: "gb", key: "b1" });
    expect(stepOrderedTab(layout, null, -1)).toEqual({ groupId: "gb", key: "b1" });
  });
});

/** A keydown with AltGr held: Linux reports neither Ctrl nor Alt with it,
 *  Windows reports Ctrl+Alt. */
function altGrKey(init: KeyboardEventInit, target: EventTarget = document.body): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(e, "getModifierState", { value: (m: string) => m === "AltGraph" });
  Object.defineProperty(e, "target", { value: target });
  return e;
}

describe("project cycle on AltGr+Tab", () => {
  it("defaults to AltGr+Tab / AltGr+Shift+Tab, labelled AltGr", () => {
    expect(resolveChord("cycleProject", undefined)).toEqual({ key: "Tab", altGr: true });
    expect(resolveChord("cycleProjectBack", undefined)).toEqual({ key: "Tab", altGr: true, shift: true });
    expect(chordLabel(resolveChord("cycleProjectBack", undefined))).toBe("AltGr+Shift+Tab");
  });

  it("matches AltGr as Linux and as Windows report it, never plain or left Alt", () => {
    const next = resolveChord("cycleProject", undefined);
    expect(chordMatches(next, altGrKey({ key: "Tab" }))).toBe(true);
    expect(chordMatches(next, altGrKey({ key: "Tab", ctrlKey: true, altKey: true }))).toBe(true);
    expect(chordMatches(next, altGrKey({ key: "Tab", shiftKey: true }))).toBe(false);
    expect(chordMatches(next, new KeyboardEvent("keydown", { key: "Tab", altKey: true }))).toBe(false);
    expect(chordMatches(next, new KeyboardEvent("keydown", { key: "Tab" }))).toBe(false);
    // Windows' AltGr is Ctrl+Alt: it must not fire the Ctrl+Tab tab cycle.
    expect(actionMatches("nextProjectTab", undefined, altGrKey({ key: "Tab", ctrlKey: true, altKey: true }))).toBe(false);
  });

  it("keeps Alt+Shift+→ / ← beside it until rebound", () => {
    const arrow = new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, shiftKey: true });
    expect(actionMatches("cycleProject", undefined, arrow)).toBe(true);
    expect(actionMatches("cycleProject", { cycleProject: { key: "F2" } }, arrow)).toBe(false);
  });

  it("is captured as an AltGr chord, Windows' Ctrl+Alt dropped", () => {
    expect(chordFromEvent(altGrKey({ key: "Tab", shiftKey: true, ctrlKey: true, altKey: true }))).toEqual({
      key: "Tab",
      altGr: true,
      shift: true,
    });
  });

  it("a pane terminal hands AltGr+Tab over, the arrow alias it keeps", () => {
    document.body.innerHTML = '<textarea class="xterm-helper-textarea" id="t"></textarea>';
    const t = document.getElementById("t")!;
    const gr = altGrKey({ key: "Tab" }, t);
    expect(terminalYieldsChord(gr, undefined)).toBe(true);
    expect(terminalMayTakeChord("cycleProject", gr)).toBe(true);
    const arrow = new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, shiftKey: true });
    Object.defineProperty(arrow, "target", { value: t });
    expect(terminalYieldsChord(arrow, undefined)).toBe(false);
    expect(terminalMayTakeChord("cycleProject", arrow)).toBe(false);
  });

  it("switches project from a focused terminal", () => {
    seed(group("g", ["only"], "only"), "g");
    render(<Harness />);
    document.body.innerHTML = '<textarea class="xterm-helper-textarea" id="t"></textarea>';
    const t = document.getElementById("t")!;
    const e = altGrKey({ key: "Tab" }, t);
    act(() => {
      t.dispatchEvent(e);
    });
    expect(e.defaultPrevented).toBe(true);
  });
});
