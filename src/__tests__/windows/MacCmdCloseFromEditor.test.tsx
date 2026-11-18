/**
 * macOS: ⌘W closes a tab even while a terminal (xterm's helper textarea) or
 * another editor has focus.
 *
 * The keyboard hook normally leaves every key of a focused field alone. On a
 * Mac that let ⌘W fall through to the default menu's Close Window, which closed
 * the main window — the whole app — for a "close tab". ⌘ is never text editing
 * on a Mac, so the close family is admitted there; ⌃W (readline's delete-word)
 * and every other chord still belong to the field.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

vi.mock("../../lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/platform")>()),
  IS_MAC: true,
  IS_WINDOWS: false,
  IS_LINUX: false,
  PLATFORM: "macos",
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFullscreen: vi.fn().mockResolvedValue(false),
    setFullscreen: vi.fn(),
  }),
}));

import { editorMayTakeChord, useKeyboard } from "../../hooks/useKeyboard";
import { allGroups, useTabsStore } from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";

function Harness() {
  useKeyboard({ onTogglePanels: () => {} });
  return null;
}

function resetTabs() {
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
}

function terminalTextarea(): HTMLTextAreaElement {
  const ta = document.createElement("textarea");
  ta.className = "xterm-helper-textarea";
  document.body.appendChild(ta);
  return ta;
}

function press(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(ev);
  });
  return ev;
}

function twoTabs() {
  const store = useTabsStore.getState();
  store.addTab({ label: "a", cmd: "bash", cwd: "/p", kind: "shell" });
  store.addTab({ label: "b", cmd: "bash", cwd: "/p", kind: "shell" });
  useTabsStore.getState().focusGroup(allGroups(useTabsStore.getState().layout)[0].id);
}

describe("⌘W from a focused editor on macOS", () => {
  beforeEach(() => {
    cleanup();
    document.body.innerHTML = "";
    resetTabs();
    useSettingsStore.setState({ settings: null });
  });

  it("closes the active tab from a terminal and claims the key", () => {
    twoTabs();
    render(<Harness />);
    const ev = press(terminalTextarea(), { key: "w", metaKey: true });
    expect(useTabsStore.getState().tabs).toHaveLength(1);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("leaves ⌃W to the terminal (readline delete-word)", () => {
    twoTabs();
    render(<Harness />);
    const ev = press(terminalTextarea(), { key: "w", ctrlKey: true });
    expect(useTabsStore.getState().tabs).toHaveLength(2);
    expect(ev.defaultPrevented).toBe(false);
  });

  it("does not let any non-close ⌘ chord out of an editor", () => {
    // Shift+⌘Tab is prevProjectTab's chord on a Mac; from a field it stays there.
    const ev = new KeyboardEvent("keydown", { key: "Tab", metaKey: true, shiftKey: true });
    expect(editorMayTakeChord("prevProjectTab", ev)).toBe(false);
    expect(editorMayTakeChord("toggleFullscreen", ev)).toBe(false);
    const cmdW = new KeyboardEvent("keydown", { key: "w", metaKey: true });
    expect(editorMayTakeChord("closeTab", cmdW)).toBe(true);
    expect(editorMayTakeChord("closeSubwindow", cmdW)).toBe(true);
    expect(editorMayTakeChord("closeAllTabs", cmdW)).toBe(true);
    const both = new KeyboardEvent("keydown", { key: "w", metaKey: true, ctrlKey: true });
    expect(editorMayTakeChord("closeTab", both)).toBe(false);
  });
});
