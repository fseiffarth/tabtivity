/**
 * The per-project tab visit order (`stores/tabs/visitOrder`): closing or moving
 * the active tab lands on the tab visited before it, not the neighbour, and a
 * closed subwindow hands focus to the group of the most recently visited tab.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { useTabsStore, findGroupOfTab, type GroupNode } from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
import { resetTabVisits } from "../../stores/tabs/visitOrder";

function tab(label: string) {
  return { label, cmd: "bash", cwd: "/p", kind: "shell" as const };
}

function setScope(scope: string) {
  useTabsStore.setState((s) => ({
    scope,
    tabs: s.tabsByScope[scope] ?? [],
    layout: s.layoutByScope[scope] ?? null,
    focusedGroupId: s.focusedGroupByScope[scope] ?? null,
    activeKey: null,
  }));
}

beforeEach(() => {
  resetTabVisits();
  useSettingsStore.setState({ settings: { close_subwindow_on_last_tab: true } });
  useTabsStore.setState({
    scope: "p",
    tabsByScope: {},
    layoutByScope: {},
    focusedGroupByScope: {},
    detachedGroupsByScope: {},
    tabs: [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
  });
});

describe("tab visit order", () => {
  it("closing the active tab returns to the tab visited before it", () => {
    const st = () => useTabsStore.getState();
    const a = st().addTab(tab("a"));
    const b = st().addTab(tab("b"));
    const c = st().addTab(tab("c"));
    const d = st().addTab(tab("d"));
    st().setActive(a.key);
    st().setActive(c.key);
    // The neighbour of c would be b or d; a was visited last before c.
    st().removeTab(c.key);
    expect(st().activeKey).toBe(a.key);
    // Then the one before a (d, the last opened before the jumps).
    st().removeTab(a.key);
    expect(st().activeKey).toBe(d.key);
    expect(b.key).toBeTruthy();
  });

  it("closing a background tab leaves the active one alone", () => {
    const st = () => useTabsStore.getState();
    const a = st().addTab(tab("a"));
    const b = st().addTab(tab("b"));
    st().setActive(a.key);
    st().removeTab(b.key);
    expect(st().activeKey).toBe(a.key);
  });

  it("moving the active tab out of a group repicks the last visited one there", () => {
    const st = () => useTabsStore.getState();
    const a = st().addTab(tab("a"));
    const b = st().addTab(tab("b"));
    const c = st().addTab(tab("c"));
    st().setActive(c.key);
    st().setActive(a.key);
    const source = (st().layout as GroupNode).id;
    st().splitWithTab(a.key, source, "right");
    const left = findGroupOfTab(st().layout, b.key)!.group;
    // c was visited after b: the source group shows c, not b (its first tab
    // after a left).
    expect(left.activeKey).toBe(c.key);
  });

  it("closing a subwindow's last tab focuses the group of the last visited tab", () => {
    const st = () => useTabsStore.getState();
    const a = st().addTab(tab("a"));
    const b = st().addTab(tab("b"));
    const c = st().addTab(tab("c"));
    const root = (st().layout as GroupNode).id;
    st().splitWithTab(b.key, root, "right"); // [a c] | [b]
    st().splitWithTab(c.key, findGroupOfTab(st().layout, b.key)!.group.id, "right"); // [a] | [b] | [c]
    st().setActive(b.key);
    st().setActive(c.key);
    st().removeTab(c.key);
    // Without the visit order focus fell to the first group (a).
    expect(st().activeKey).toBe(b.key);
    expect(a.key).toBeTruthy();
  });

  it("keeps a separate order per project", () => {
    const st = () => useTabsStore.getState();
    const a = st().addTab(tab("a"));
    const b = st().addTab(tab("b"));
    st().addTab(tab("c"));
    st().setActive(a.key);
    st().setActive(b.key);

    setScope("q");
    const x = st().addTab(tab("x"));
    const y = st().addTab(tab("y"));
    st().addTab(tab("z"));
    st().setActive(x.key);
    st().setActive(y.key);
    // Visits in q do not disturb p's order, and vice versa.
    st().removeTab(y.key);
    expect(st().activeKey).toBe(x.key);

    setScope("p");
    st().removeTab(b.key);
    expect(st().activeKey).toBe(a.key);
  });
});
