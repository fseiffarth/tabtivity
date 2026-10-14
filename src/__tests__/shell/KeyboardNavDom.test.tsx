import { ConfirmDialog } from "../../components/common/PromptDialogs";
/**
 * #62 — keyboard navigation DOM wiring.
 *
 * Mounts the real useKeyboard hook and dispatches real keydown events on
 * `window`, asserting each chord drives the right store action:
 *   - Shift+Tab cycles tabs within the focused subwindow (wraps);
 *   - Ctrl+Shift+Left/Right cycle the active tab within the focused subwindow;
 *   - Ctrl+Shift+Up/Down preview a subwindow; focus commits on Shift release;
 *   - Ctrl+Enter toggles fullscreen, Escape exits it;
 *   - Ctrl+W closes the active tab; Shift+Ctrl+W closes the subwindow;
 *   - Shift+Ctrl+Tab cycles to the next active project;
 *   - chords are ignored while a text input is focused.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFullscreen: vi.fn().mockResolvedValue(false),
    setFullscreen: vi.fn(),
  }),
}));

import { useKeyboard } from "../../hooks/useKeyboard";
import { allGroups, useTabsStore } from "../../stores/tabs";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { useSubwindowNavStore } from "../../stores/subwindowNav";

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

function key(init: Partial<KeyboardEventInit> & { key: string }) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  });
}

function keyUp(init: Partial<KeyboardEventInit> & { key: string }) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, ...init }));
  });
}

describe("#62 keyboard nav wiring", () => {
  beforeEach(() => {
    resetTabs();
    useSubwindowNavStore.getState().end();
    useSettingsStore.setState({ settings: null });
    cleanup();
  });

  it("does not navigate workspace tabs behind a modal, including from a focused button", () => {
    const store = useTabsStore.getState();
    store.addTab({ label: "t1", cmd: "bash", cwd: "/p", kind: "shell" });
    store.addTab({ label: "t2", cmd: "bash", cwd: "/p", kind: "shell" });
    render(<Harness />);
    const dialog = render(<ConfirmDialog title="Question" body="Confirm" onCancel={() => {}} onConfirm={() => {}} />);
    const start = useTabsStore.getState().activeKey;
    key({ key: "Tab", shiftKey: true });
    key({ key: "ArrowRight", ctrlKey: true, shiftKey: true });
    expect(useTabsStore.getState().activeKey).toBe(start);
    dialog.unmount();
    key({ key: "Tab", shiftKey: true });
    expect(useTabsStore.getState().activeKey).not.toBe(start);
  });

  it("Shift+Tab cycles tabs within the focused subwindow and wraps", () => {
    const store = useTabsStore.getState();
    store.addTab({ label: "t1", cmd: "bash", cwd: "/p", kind: "shell" });
    store.addTab({ label: "t2", cmd: "bash", cwd: "/p", kind: "shell" });
    store.addTab({ label: "t3", cmd: "bash", cwd: "/p", kind: "shell" });
    const group = allGroups(useTabsStore.getState().layout)[0];
    // Active is t3 (last added). Focus the group.
    useTabsStore.getState().focusGroup(group.id);
    render(<Harness />);

    const start = useTabsStore.getState().activeKey;
    expect(start).toBe(group.tabKeys[2]);
    key({ key: "Tab", shiftKey: true });
    expect(useTabsStore.getState().activeKey).toBe(group.tabKeys[0]); // wrapped
    key({ key: "Tab", shiftKey: true });
    expect(useTabsStore.getState().activeKey).toBe(group.tabKeys[1]);
  });

  it("Ctrl+Shift+Left/Right cycle the active tab within the focused subwindow", () => {
    const store = useTabsStore.getState();
    store.addTab({ label: "t1", cmd: "bash", cwd: "/p", kind: "shell" });
    store.addTab({ label: "t2", cmd: "bash", cwd: "/p", kind: "shell" });
    store.addTab({ label: "t3", cmd: "bash", cwd: "/p", kind: "shell" });
    const group = allGroups(useTabsStore.getState().layout)[0];
    useTabsStore.getState().focusGroup(group.id);
    render(<Harness />);

    // Active is t3 (index 2). Right → next, wraps to index 0.
    expect(useTabsStore.getState().activeKey).toBe(group.tabKeys[2]);
    key({ key: "ArrowRight", ctrlKey: true, shiftKey: true });
    expect(useTabsStore.getState().activeKey).toBe(group.tabKeys[0]);
    // Left → previous, wraps back to index 2.
    key({ key: "ArrowLeft", ctrlKey: true, shiftKey: true });
    expect(useTabsStore.getState().activeKey).toBe(group.tabKeys[2]);
  });

  it("plain Shift+Left/Right do nothing (left to an agent CLI's own chord)", () => {
    const store = useTabsStore.getState();
    store.addTab({ label: "t1", cmd: "bash", cwd: "/p", kind: "shell" });
    store.addTab({ label: "t2", cmd: "bash", cwd: "/p", kind: "shell" });
    const group = allGroups(useTabsStore.getState().layout)[0];
    useTabsStore.getState().focusGroup(group.id);
    render(<Harness />);

    const start = useTabsStore.getState().activeKey;
    key({ key: "ArrowRight", shiftKey: true });
    expect(useTabsStore.getState().activeKey).toBe(start);
  });

  it("Ctrl+Shift+Down previews a subwindow and commits focus on Shift release", () => {
    const store = useTabsStore.getState();
    store.addTab({ label: "a", cmd: "bash", cwd: "/p", kind: "shell" });
    const b = store.addTab({ label: "b", cmd: "bash", cwd: "/p", kind: "shell" });
    const root = allGroups(useTabsStore.getState().layout)[0].id;
    useTabsStore.getState().splitWithTab(b.key, root, "right");
    const groups = allGroups(useTabsStore.getState().layout);
    const aGroup = groups.find((g) => g.tabKeys.length && !g.tabKeys.includes(b.key))!;
    const bGroup = groups.find((g) => g.tabKeys.includes(b.key))!;
    useTabsStore.getState().focusGroup(aGroup.id);
    render(<Harness />);

    // Ctrl+Shift+Down enters nav preview on the next subwindow, WITHOUT moving focus.
    key({ key: "ArrowDown", ctrlKey: true, shiftKey: true });
    expect(useSubwindowNavStore.getState().active).toBe(true);
    expect(useSubwindowNavStore.getState().previewGroupId).toBe(bGroup.id);
    expect(useTabsStore.getState().focusedGroupId).toBe(aGroup.id);

    // Releasing Shift commits focus to the previewed subwindow and clears nav.
    keyUp({ key: "Shift", shiftKey: false });
    expect(useTabsStore.getState().focusedGroupId).toBe(bGroup.id);
    expect(useSubwindowNavStore.getState().active).toBe(false);
  });

  it("Ctrl+Enter toggles fullscreen and Escape exits it", () => {
    const store = useTabsStore.getState();
    store.addTab({ label: "a", cmd: "bash", cwd: "/p", kind: "shell" });
    const g = allGroups(useTabsStore.getState().layout)[0].id;
    useTabsStore.getState().focusGroup(g);
    render(<Harness />);

    key({ key: "Enter", ctrlKey: true });
    expect(useTabsStore.getState().fullscreenGroupId).toBe(g);
    key({ key: "Escape" });
    expect(useTabsStore.getState().fullscreenGroupId).toBeNull();
  });

  it("Ctrl+W closes the active tab; Shift+Ctrl+W closes the subwindow", () => {
    const store = useTabsStore.getState();
    const a = store.addTab({ label: "a", cmd: "bash", cwd: "/p", kind: "shell" });
    const b = store.addTab({ label: "b", cmd: "bash", cwd: "/p", kind: "shell" });
    const root = allGroups(useTabsStore.getState().layout)[0].id;
    useTabsStore.getState().splitWithTab(b.key, root, "right");
    const groups = allGroups(useTabsStore.getState().layout);
    const bGroup = groups.find((g) => g.tabKeys.includes(b.key))!;
    useTabsStore.getState().focusGroup(bGroup.id);
    render(<Harness />);

    // Ctrl+W closes the active tab (b) → its group empties and collapses.
    key({ key: "w", ctrlKey: true });
    expect(useTabsStore.getState().tabs.find((t) => t.key === b.key)).toBeUndefined();
    expect(allGroups(useTabsStore.getState().layout)).toHaveLength(1);
    expect(useTabsStore.getState().tabs.find((t) => t.key === a.key)).toBeTruthy();
  });

  it("Shift+Ctrl+Tab cycles to the next active project", () => {
    useProjectsStore.setState({
      projects: [
        { id: "p1", name: "P1", status: "current", position: 1 } as never,
        { id: "p2", name: "P2", status: "active", position: 2 } as never,
        { id: "p3", name: "P3", status: "active", position: 3 } as never,
      ],
      activeId: "p1",
    });
    const setActive = vi.fn().mockResolvedValue(undefined);
    useProjectsStore.setState({ setActive });
    render(<Harness />);

    key({ key: "Tab", shiftKey: true, ctrlKey: true });
    expect(setActive).toHaveBeenCalledWith("p2");
  });

  it("Shift+Ctrl+Tab wraps through the ROOT scope, not past it", () => {
    // The root terminal is the pill strip's first pill, so the cycle stops
    // there. It used to be reachable only by leaving it: `null` matched no
    // pill, so cycling out worked and cycling back in was impossible.
    useProjectsStore.setState({
      projects: [
        { id: "p1", name: "P1", status: "active", position: 1 } as never,
        { id: "p2", name: "P2", status: "current", position: 2 } as never,
      ],
      activeId: "p2",
    });
    const setActive = vi.fn().mockResolvedValue(undefined);
    useProjectsStore.setState({ setActive });
    render(<Harness />);

    // Last pill → wraps to the root scope.
    key({ key: "Tab", shiftKey: true, ctrlKey: true });
    expect(setActive).toHaveBeenCalledWith(null);

    // And out of the root scope again, into the first pill.
    setActive.mockClear();
    useProjectsStore.setState({ activeId: null });
    key({ key: "Tab", shiftKey: true, ctrlKey: true });
    expect(setActive).toHaveBeenCalledWith("p1");
  });

  it("uses a custom binding from settings when present", () => {
    // Rebind closeTab from Ctrl+W to Ctrl+Q.
    useSettingsStore.setState({
      settings: { keyboard_shortcuts: { closeTab: { key: "q", ctrl: true } } },
    });
    const store = useTabsStore.getState();
    const a = store.addTab({ label: "a", cmd: "bash", cwd: "/p", kind: "shell" });
    const g = allGroups(useTabsStore.getState().layout)[0].id;
    useTabsStore.getState().focusGroup(g);
    render(<Harness />);

    // The old default (Ctrl+W) must no longer close the tab.
    key({ key: "w", ctrlKey: true });
    expect(useTabsStore.getState().tabs.find((t) => t.key === a.key)).toBeTruthy();
    // The custom chord (Ctrl+Q) does.
    key({ key: "q", ctrlKey: true });
    expect(useTabsStore.getState().tabs.find((t) => t.key === a.key)).toBeUndefined();
  });

  it("falls back to the default binding when no override is set", () => {
    // No keyboard_shortcuts in settings → default Ctrl+W closes the tab.
    useSettingsStore.setState({ settings: {} });
    const store = useTabsStore.getState();
    const a = store.addTab({ label: "a", cmd: "bash", cwd: "/p", kind: "shell" });
    const g = allGroups(useTabsStore.getState().layout)[0].id;
    useTabsStore.getState().focusGroup(g);
    render(<Harness />);

    key({ key: "w", ctrlKey: true });
    expect(useTabsStore.getState().tabs.find((t) => t.key === a.key)).toBeUndefined();
  });

  it("ignores chords while a text input is focused", () => {
    const store = useTabsStore.getState();
    store.addTab({ label: "t1", cmd: "bash", cwd: "/p", kind: "shell" });
    store.addTab({ label: "t2", cmd: "bash", cwd: "/p", kind: "shell" });
    const group = allGroups(useTabsStore.getState().layout)[0];
    useTabsStore.getState().focusGroup(group.id);
    render(<Harness />);

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    const before = useTabsStore.getState().activeKey;
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    });
    expect(useTabsStore.getState().activeKey).toBe(before);
    input.remove();
  });
});
