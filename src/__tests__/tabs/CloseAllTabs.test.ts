/**
 * closeAllTabs — clears every tab/subwindow in a scope, leaving it empty.
 * Defaults to the current scope; a non-current scope is cleared in memory only
 * (callers persist it explicitly). See tabs.ts closeAllTabs.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

import { useTabsStore, type GroupNode, type TabEntry } from "../../stores/tabs";

function shellTab(key: string, scope: string): TabEntry {
  return { key, scope, label: key, cmd: "", cwd: `/p/${scope}`, kind: "shell" };
}
function group(id: string, tabKeys: string[]): GroupNode {
  return { type: "group", id, tabKeys, activeKey: tabKeys[0] ?? null };
}

describe("tabs store — closeAllTabs", () => {
  beforeEach(() => {
    useTabsStore.setState({
      scope: "a",
      tabs: [shellTab("a1", "a"), shellTab("a2", "a")],
      activeKey: "a1",
      layout: group("ga", ["a1", "a2"]),
      focusedGroupId: "ga",
      tabsByScope: { a: [shellTab("a1", "a"), shellTab("a2", "a")], b: [shellTab("b1", "b")] },
      layoutByScope: { a: group("ga", ["a1", "a2"]), b: group("gb", ["b1"]) },
      focusedGroupByScope: { a: "ga", b: "gb" },
    });
  });

  it("empties the current scope (tabs + layout + flat mirrors)", () => {
    useTabsStore.getState().closeAllTabs();
    const s = useTabsStore.getState();
    expect(s.tabsByScope.a).toEqual([]);
    expect(s.layoutByScope.a).toBeNull();
    expect(s.tabs).toEqual([]);
    expect(s.layout).toBeNull();
    expect(s.activeKey).toBeNull();
    // Other scopes are untouched.
    expect(s.tabsByScope.b).toHaveLength(1);
  });

  it("clears a non-current scope without changing the current one", () => {
    useTabsStore.getState().closeAllTabs("b");
    const s = useTabsStore.getState();
    expect(s.tabsByScope.b).toEqual([]);
    expect(s.layoutByScope.b).toBeNull();
    // Current scope 'a' and its flat mirrors are unaffected.
    expect(s.scope).toBe("a");
    expect(s.tabs).toHaveLength(2);
  });

  it("is a no-op for an empty/unknown scope", () => {
    const before = useTabsStore.getState().tabsByScope;
    useTabsStore.getState().closeAllTabs("does-not-exist");
    expect(useTabsStore.getState().tabsByScope).toBe(before);
  });

  it("unloads a scope without replacing its saved layout with an empty one", async () => {
    await useTabsStore.getState().unloadScope("b");
    const s = useTabsStore.getState();
    expect(s.tabsByScope.b).toBeUndefined();
    expect(s.layoutByScope.b).toBeUndefined();
    expect(s.focusedGroupByScope.b).toBeUndefined();
    expect(s.tabsByScope.a).toHaveLength(2);
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith(
      "workspace_sync",
      expect.anything(),
    );
  });
});
