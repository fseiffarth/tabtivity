/**
 * #62 — keyboard navigation primitives.
 *
 * The store-level `toggleFullscreen` state machine. The DOM wiring (chords →
 * store actions) is covered in KeyboardNavDom.test.tsx.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { allGroups, useTabsStore } from "../../stores/tabs";

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
    fullscreenGroupId: null,
  });
}

describe("#62 toggleFullscreen (store)", () => {
  beforeEach(reset);

  it("sets and clears fullscreenGroupId; toggling the same group clears it", () => {
    const store = useTabsStore.getState();
    store.addTab({ label: "a", cmd: "bash", cwd: "/p", kind: "shell" });
    const g = allGroups(useTabsStore.getState().layout)[0].id;

    useTabsStore.getState().toggleFullscreen(g);
    expect(useTabsStore.getState().fullscreenGroupId).toBe(g);

    // Same group toggles off.
    useTabsStore.getState().toggleFullscreen(g);
    expect(useTabsStore.getState().fullscreenGroupId).toBeNull();
  });

  it("toggleFullscreen(null) always clears", () => {
    const store = useTabsStore.getState();
    store.addTab({ label: "a", cmd: "bash", cwd: "/p", kind: "shell" });
    const g = allGroups(useTabsStore.getState().layout)[0].id;
    useTabsStore.getState().toggleFullscreen(g);
    useTabsStore.getState().toggleFullscreen(null);
    expect(useTabsStore.getState().fullscreenGroupId).toBeNull();
  });

  it("closing the fullscreened subwindow exits fullscreen", () => {
    const store = useTabsStore.getState();
    const a = store.addTab({ label: "a", cmd: "bash", cwd: "/p", kind: "shell" });
    const b = store.addTab({ label: "b", cmd: "bash", cwd: "/p", kind: "shell" });
    const rootGroup = allGroups(useTabsStore.getState().layout)[0].id;
    useTabsStore.getState().splitWithTab(b.key, rootGroup, "right");
    const groups = allGroups(useTabsStore.getState().layout);
    const bGroup = groups.find((g) => g.tabKeys.includes(b.key))!;

    useTabsStore.getState().toggleFullscreen(bGroup.id);
    expect(useTabsStore.getState().fullscreenGroupId).toBe(bGroup.id);

    // Close b's subwindow → its group collapses, fullscreen must clear.
    useTabsStore.getState().closeGroup(bGroup.id);
    expect(useTabsStore.getState().fullscreenGroupId).toBeNull();
    // a survives.
    expect(useTabsStore.getState().tabs.find((t) => t.key === a.key)).toBeTruthy();
  });

  it("switching scope clears a stale fullscreen group", () => {
    const store = useTabsStore.getState();
    store.addTab({ label: "a", cmd: "bash", cwd: "/p", kind: "shell" });
    const g = allGroups(useTabsStore.getState().layout)[0].id;
    useTabsStore.getState().toggleFullscreen(g);
    expect(useTabsStore.getState().fullscreenGroupId).toBe(g);

    useTabsStore.getState().setScope("other");
    expect(useTabsStore.getState().fullscreenGroupId).toBeNull();
  });
});
