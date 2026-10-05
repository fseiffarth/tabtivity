/**
 * #56 — SHIFT+right-click a tab enters inline rename mode (no menu, no prompt).
 * Plain right-click opens the tab context menu instead (which carries its own
 * "Rename" item routing back into the same inline editor).
 *
 * Renders the real TabBar and drives the contextmenu / keyboard path through
 * React's own event system to prove:
 *   - shift+contextmenu on a tab swaps the label for a focused, text-selected
 *     input and shows NO context menu;
 *   - a plain contextmenu opens the menu and does NOT start renaming;
 *   - typing + Enter commits the new label via renameTab;
 *   - Escape discards the edit, leaving the original label;
 *   - a pointerdown on the editing input does not start a tab drag.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue([]) }));

import { TabBar } from "../../components/tabs/TabBar";
import { allGroups, useTabsStore } from "../../stores/tabs";
import { useDragStore } from "../../stores/drag/drag";

function reset() {
  useTabsStore.setState({
    scope: "p",
    tabsByScope: {},
    layoutByScope: {},
    focusedGroupByScope: {},
    tabs: [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
  });
  useDragStore.setState({ drag: null });
}

function seedOneTab(label = "shell") {
  useTabsStore.getState().addTab({ label, cmd: "bash", cwd: "/p", kind: "shell" });
  const group = allGroups(useTabsStore.getState().layout)[0];
  const key = group.tabKeys[0];
  return { groupId: group.id, key };
}

describe("#56 inline tab rename", () => {
  beforeEach(() => {
    reset();
    cleanup();
  });

  it("shift+contextmenu shows an input (label selected) and no context menu", () => {
    const { groupId } = seedOneTab("shell");
    const { container } = render(
      <TabBar groupId={groupId} projectCwd="/p" showGroupClose={false} />,
    );
    const tab = container.querySelector(".tab")!;
    fireEvent.contextMenu(tab, { shiftKey: true });

    const input = container.querySelector("input.tab-label-edit") as HTMLInputElement | null;
    expect(input).toBeTruthy();
    expect(input!.value).toBe("shell");
    // The whole label is selected for a fast retype.
    expect(input!.selectionStart).toBe(0);
    expect(input!.selectionEnd).toBe("shell".length);
    // Shift goes STRAIGHT to rename — the menu is skipped entirely. (It portals
    // to document.body, so look there rather than in the container.)
    expect(document.querySelector(".tab-new-menu")).toBeNull();
    // The plain label span is gone while editing.
    expect(container.querySelector(".tab-label")).toBeNull();
  });

  it("plain contextmenu opens the tab menu and does NOT start renaming", () => {
    const { groupId } = seedOneTab("shell");
    const { container } = render(
      <TabBar groupId={groupId} projectCwd="/p" showGroupClose={false} />,
    );
    fireEvent.contextMenu(container.querySelector(".tab")!);

    expect(document.querySelector(".tab-new-menu")).toBeTruthy();
    expect(container.querySelector("input.tab-label-edit")).toBeNull();
    expect(container.querySelector(".tab-label")!.textContent).toBe("shell");
  });

  it("typing + Enter renames the tab and closes the editor", () => {
    const { groupId, key } = seedOneTab("old");
    const { container } = render(
      <TabBar groupId={groupId} projectCwd="/p" showGroupClose={false} />,
    );
    fireEvent.contextMenu(container.querySelector(".tab")!, { shiftKey: true });
    const input = container.querySelector("input.tab-label-edit") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(useTabsStore.getState().tabs.find((t) => t.key === key)!.label).toBe("renamed");
    expect(container.querySelector("input.tab-label-edit")).toBeNull();
    expect(container.querySelector(".tab-label")!.textContent).toBe("renamed");
  });

  it("a re-render while typing does not re-select the text (the next key would replace it)", () => {
    const { groupId } = seedOneTab("old");
    const { container, rerender } = render(
      <TabBar groupId={groupId} projectCwd="/p" showGroupClose={false} />,
    );
    fireEvent.contextMenu(container.querySelector(".tab")!, { shiftKey: true });
    const input = container.querySelector("input.tab-label-edit") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "ne" } });
    input.setSelectionRange(2, 2);
    // A status tick re-renders the bar mid-edit.
    rerender(<TabBar groupId={groupId} projectCwd="/p" showGroupClose={true} />);
    const after = container.querySelector("input.tab-label-edit") as HTMLInputElement;
    expect(after).toBe(input);
    expect([after.selectionStart, after.selectionEnd]).toEqual([2, 2]);
  });

  it("Escape discards the edit, label unchanged", () => {
    const { groupId, key } = seedOneTab("keepme");
    const { container } = render(
      <TabBar groupId={groupId} projectCwd="/p" showGroupClose={false} />,
    );
    fireEvent.contextMenu(container.querySelector(".tab")!, { shiftKey: true });
    const input = container.querySelector("input.tab-label-edit") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "discarded" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(useTabsStore.getState().tabs.find((t) => t.key === key)!.label).toBe("keepme");
    expect(container.querySelector("input.tab-label-edit")).toBeNull();
    expect(container.querySelector(".tab-label")!.textContent).toBe("keepme");
  });

  it("pointerdown on the editing input does not start a tab drag", () => {
    const { groupId } = seedOneTab("dragless");
    const { container } = render(
      <TabBar groupId={groupId} projectCwd="/p" showGroupClose={false} />,
    );
    fireEvent.contextMenu(container.querySelector(".tab")!, { shiftKey: true });
    const input = container.querySelector("input.tab-label-edit") as HTMLInputElement;
    fireEvent.pointerDown(input, { button: 0, clientX: 10, clientY: 10 });
    // Moving far would normally cross the drag threshold; the input's
    // stopPropagation + the editingKey guard mean no drag was ever seeded.
    expect(useDragStore.getState().drag).toBeNull();
  });
});
