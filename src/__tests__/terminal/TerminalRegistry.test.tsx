/**
 * One PTY, two live xterms in the window: its owning pane in CenterPanel's
 * keep-alive layer and an attach-only view (the Root window) drawing it.
 * `terminalFor` must answer the one on screen — steering's Work key focused
 * the hidden copy, and typing in the Root window went nowhere — and retiring
 * one view must leave the other registered.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ isFullscreen: vi.fn().mockResolvedValue(false), setFullscreen: vi.fn() }),
}));

import { registerTerminal, terminalFor, unregisterTerminal, watchTerminal } from "../../lib/terminal/terminalRegistry";
import { useKeyboard } from "../../hooks/useKeyboard";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import type { Settings } from "../../types";

const disposals: (() => void)[] = [];

/** A stand-in xterm: its helper textarea takes `focus()`; `shown` is whether
 *  its element has a box (jsdom has no layout). */
function fakeTerminal(shown: boolean): { term: Terminal; input: HTMLTextAreaElement } {
  const element = document.createElement("div");
  element.className = "xterm";
  element.getClientRects = () => (shown ? [{} as DOMRect] : []) as unknown as DOMRectList;
  const input = document.createElement("textarea");
  element.appendChild(input);
  document.body.appendChild(element);
  const term = { element, focus: () => input.focus() } as unknown as Terminal;
  return { term, input };
}
function register(id: string, term: Terminal) {
  registerTerminal(id, term);
  disposals.push(() => unregisterTerminal(id, term));
}

afterEach(() => {
  cleanup();
  for (const dispose of disposals.splice(0)) dispose();
  document.body.innerHTML = "";
});

describe("terminalFor with two views of one PTY", () => {
  it("answers the one on screen, whichever registered last", () => {
    const shown = fakeTerminal(true);
    const hidden = fakeTerminal(false);
    register("root:r1", shown.term);
    register("root:r1", hidden.term);
    expect(terminalFor("root:r1")).toBe(shown.term);
  });

  it("with none on screen, answers the one built last", () => {
    const a = fakeTerminal(false);
    const b = fakeTerminal(false);
    register("p:t", a.term);
    register("p:t", b.term);
    expect(terminalFor("p:t")).toBe(b.term);
  });

  it("retiring one view keeps the other, and tells the watchers", () => {
    const owner = fakeTerminal(false);
    const view = fakeTerminal(true);
    const seen = vi.fn();
    disposals.push(watchTerminal("root:r1", seen));
    register("root:r1", owner.term);
    registerTerminal("root:r1", view.term);
    unregisterTerminal("root:r1", view.term);
    expect(terminalFor("root:r1")).toBe(owner.term);
    expect(seen).toHaveBeenCalledTimes(3);
    unregisterTerminal("root:r1", owner.term);
    expect(terminalFor("root:r1")).toBeUndefined();
    // A stale retire (already gone) changes nothing and notifies no one.
    unregisterTerminal("root:r1", owner.term);
    expect(seen).toHaveBeenCalledTimes(4);
  });
});

function Harness() {
  useKeyboard({ onTogglePanels: () => {} });
  return null;
}
const shell = (key: string): TabEntry => ({ key, label: key, cmd: "bash", cwd: "/root", kind: "shell" });

describe("steering's Work key in the Root window", () => {
  beforeEach(() => {
    useSettingsStore.setState({ settings: {} as Settings });
    useTabsStore.setState({
      scope: "p", tabs: [], layout: null, focusedGroupId: null, activeKey: null, fullscreenGroupId: null,
      tabsByScope: { p: [], root: [shell("r1")] },
      layoutByScope: { root: { type: "group", id: "gr", tabKeys: ["r1"], activeKey: "r1" } },
      focusedGroupByScope: { root: "gr" },
    });
    useRootOverlayStore.setState({ open: true, view: "root" });
    useKeyboardSteeringStore.getState().exit();
  });

  it.each(["Enter", "Escape"])("%s hands the keyboard to the Root tab's visible terminal, not the hidden owner", (key) => {
    // The Root window's attach-only view was built first; the workspace's
    // keep-alive pane (hidden) re-registered after it.
    const shown = fakeTerminal(true);
    const hidden = fakeTerminal(false);
    register("root:r1", shown.term);
    register("root:r1", hidden.term);
    render(<Harness />);
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: " ", shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(useKeyboardSteeringStore.getState()).toMatchObject({ active: true, level: "tabs" });
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
    expect(useKeyboardSteeringStore.getState().active).toBe(false);
    expect(document.activeElement).toBe(shown.input);
  });
});
