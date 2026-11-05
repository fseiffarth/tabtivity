/**
 * The tab chords while the root window is in front. On the Root view Ctrl+W and
 * the tab / subwindow stepping chords act on **Root's** tabs (the shown Root
 * subwindow), not on the workspace tabs behind the window; on another view of the
 * window (Now ...) they do nothing to the workspace; with the window shut they are
 * the workspace's, as ever.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ isFullscreen: vi.fn().mockResolvedValue(false), setFullscreen: vi.fn() }),
}));

import { useKeyboard } from "../../hooks/useKeyboard";
import { chordMatches, resolveChord, type ShortcutAction } from "../../lib/shortcuts/shortcuts";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { useSettingsStore } from "../../stores/settings";
import { allGroups, useTabsStore, type LayoutNode, type TabEntry } from "../../stores/tabs";
import type { Settings } from "../../types";

function Harness() {
  useKeyboard({ onTogglePanels: () => {} });
  return null;
}
/** Fire the chord an action is bound to, from `target` (the body by default). */
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
const tab = (key: string, kind: TabEntry["kind"] = "shell"): TabEntry => ({ key, label: key, cmd: "bash", cwd: "/p", kind });
const group = (id: string, keys: string[], activeKey: string): LayoutNode => ({ type: "group", id, tabKeys: keys, activeKey });
const rootActive = () => (useTabsStore.getState().layoutByScope.root as { activeKey: string }).activeKey;
const wsActive = () => useTabsStore.getState().activeKey;
const rootKeys = () => (useTabsStore.getState().tabsByScope.root ?? []).map((t) => t.key);
const wsKeys = () => (useTabsStore.getState().tabsByScope.p ?? []).map((t) => t.key);

function seed(rootLayout: LayoutNode = group("gr", ["r1", "r2", "r3"], "r1")) {
  const rootTabs = ["r1", "r2", "r3", "r4"].map((k) => tab(k));
  const wsLayout = group("gw", ["w1", "w2"], "w1");
  useTabsStore.setState({
    scope: "p",
    tabs: [tab("w1"), tab("w2")],
    layout: wsLayout,
    focusedGroupId: "gw",
    activeKey: "w1",
    fullscreenGroupId: null,
    tabsByScope: { p: [tab("w1"), tab("w2")], root: rootTabs },
    layoutByScope: { p: wsLayout, root: rootLayout },
    focusedGroupByScope: { p: "gw", root: allGroups(rootLayout)[0]?.id ?? "gr" },
  });
}

beforeEach(() => {
  useSettingsStore.setState({ settings: {} as Settings });
  seed();
  useRootOverlayStore.setState({ open: true, view: "root" });
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("with the Root view in front", () => {
  it("Ctrl+W closes Root's active tab and leaves the workspace's alone", () => {
    render(<Harness />);
    const e = chord("closeTab");
    expect(e.defaultPrevented).toBe(true);
    expect(rootKeys()).not.toContain("r1");
    expect(wsKeys()).toEqual(["w1", "w2"]);
    expect(wsActive()).toBe("w1");
  });

  it("the tab-stepping chords step Root's focused subwindow, wrapping", () => {
    render(<Harness />);
    chord("nextTab");
    expect(rootActive()).toBe("r2");
    chord("cycleTabs");
    expect(rootActive()).toBe("r3");
    chord("nextTab");
    expect(rootActive()).toBe("r1");
    chord("prevTab");
    expect(rootActive()).toBe("r3");
    expect(wsActive()).toBe("w1");
    expect((useTabsStore.getState().layoutByScope.p as { activeKey: string }).activeKey).toBe("w1");
  });

  it("from Root's own terminal the step chord is Root's too", () => {
    render(<Harness />);
    document.body.innerHTML =
      '<div class="modal-backdrop root-console-backdrop"><div class="root-overlay"><textarea class="xterm-helper-textarea" id="t"></textarea></div></div>';
    chord("nextTab", document.getElementById("t")!);
    expect(rootActive()).toBe("r2");
    expect(wsActive()).toBe("w1");
  });

  it("in a split Root the subwindow chords move Root's focus, not the workspace's", () => {
    seed({ type: "split", id: "s", direction: "row", sizes: [50, 50], children: [group("ga", ["r1", "r2"], "r1"), group("gb", ["r3", "r4"], "r3")] } as unknown as LayoutNode);
    render(<Harness />);
    chord("subwindowDown");
    expect(useTabsStore.getState().focusedGroupByScope.root).toBe("gb");
    chord("nextTab");
    expect((allGroups(useTabsStore.getState().layoutByScope.root ?? null).find((g) => g.id === "gb"))?.activeKey).toBe("r4");
    expect(useTabsStore.getState().focusedGroupId).toBe("gw");
  });

  it("the destructive workspace chords (close subwindow, close all, hide) do nothing behind it", () => {
    seed();
    useTabsStore.setState({
      layout: { type: "split", id: "s", direction: "row", sizes: [50, 50], children: [group("gw", ["w1"], "w1"), group("gw2", ["w2"], "w2")] } as unknown as LayoutNode,
    });
    render(<Harness />);
    chord("closeSubwindow");
    chord("closeAllTabs");
    chord("hideSubwindow");
    expect(allGroups(useTabsStore.getState().layout)).toHaveLength(2);
    expect(wsKeys()).toEqual(["w1", "w2"]);
    expect(rootKeys()).toHaveLength(4);
  });
});

describe("with another view of the window in front", () => {
  beforeEach(() => useRootOverlayStore.setState({ open: true, view: "now" }));

  it("Ctrl+W and the stepping chords touch neither the workspace nor Root", () => {
    render(<Harness />);
    chord("closeTab");
    chord("nextTab");
    chord("cycleTabs");
    expect(wsKeys()).toEqual(["w1", "w2"]);
    expect(wsActive()).toBe("w1");
    expect(rootKeys()).toHaveLength(4);
    expect(rootActive()).toBe("r1");
  });

  it("a terminal inside the window does not hand the step chord over", () => {
    render(<Harness />);
    document.body.innerHTML =
      '<div class="modal-backdrop root-console-backdrop"><div class="root-overlay"><textarea class="xterm-helper-textarea" id="t"></textarea></div></div>';
    chord("nextTab", document.getElementById("t")!);
    expect(wsActive()).toBe("w1");
    expect(rootActive()).toBe("r1");
  });
});

describe("with the window shut", () => {
  beforeEach(() => useRootOverlayStore.setState({ open: false, view: "root" }));

  it("the chords are the workspace's, as before", () => {
    render(<Harness />);
    chord("nextTab");
    expect((useTabsStore.getState().layoutByScope.p as { activeKey: string }).activeKey).toBe("w2");
    expect(rootActive()).toBe("r1");
    chord("closeTab");
    expect(wsKeys()).toEqual(["w1"]);
    expect(rootKeys()).toHaveLength(4);
  });
});
