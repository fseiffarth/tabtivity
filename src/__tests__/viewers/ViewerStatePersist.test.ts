/**
 * In-app viewer embeds remember the reader's scroll/zoom/pan (ViewerState) so
 * reopening a file — or restarting Tabtivity — restores the position instead of
 * jumping back to the top/default zoom. The viewer panes call setViewerState as
 * the reader scrolls/zooms; the value travels with the embed tab through
 * saveLayout → project.json and back via loadFromLayout. These tests lock that
 * round-trip and the merge/dedup behaviour of setViewerState.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import {
  flushViewerState,
  pendingViewerState,
  useTabsStore,
  VIEWER_STATE_FLUSH_MS,
  type SavedLayoutTree,
} from "../../stores/tabs";

const invokeMock = vi.mocked(invoke);

function resetStore() {
  flushViewerState();
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
}

describe("setViewerState", () => {
  beforeEach(resetStore);

  it("merges patches into the tab's viewerState", () => {
    const store = useTabsStore.getState();
    store.setScope("p");
    const tab = store.addTab({
      label: "doc.pdf",
      cmd: "",
      cwd: "/p",
      kind: "embed",
      embedPath: "/p/doc.pdf",
      viewer: "pdf",
    });

    useTabsStore.getState().setViewerState(tab.key, { scale: 1.5 });
    useTabsStore.getState().setViewerState(tab.key, { scrollTop: 240 });

    // Positions are staged (§3.1), not written: the store is untouched until a
    // flush, and the stage merges the patches.
    expect(useTabsStore.getState().tabs.find((t) => t.key === tab.key)?.viewerState).toBeUndefined();
    expect(pendingViewerState(tab.key)).toEqual({ scale: 1.5, scrollTop: 240 });
    flushViewerState(tab.key);
    const stored = useTabsStore.getState().tabs.find((t) => t.key === tab.key);
    // The second patch merges with (doesn't replace) the first.
    expect(stored?.viewerState).toEqual({ scale: 1.5, scrollTop: 240 });
    expect(pendingViewerState(tab.key)).toBeUndefined();
  });

  it("stages 50 scroll pauses without touching the shell, then folds them in once", () => {
    vi.useFakeTimers();
    try {
      const store = useTabsStore.getState();
      store.setScope("p");
      const tab = store.addTab({
        label: "doc.pdf",
        cmd: "",
        cwd: "/p",
        kind: "embed",
        embedPath: "/p/doc.pdf",
        viewer: "pdf",
      });
      // A sibling tab in a split, so the layout is a real tree.
      const other = store.addTab({ label: "sh", cmd: "bash", cwd: "/p", kind: "shell" });
      const rootGroup = useTabsStore.getState().layout;
      if (rootGroup?.type !== "group") throw new Error("expected a root group");
      useTabsStore.getState().splitWithTab(other.key, rootGroup.id, "right");
      expect(useTabsStore.getState().layout?.type).toBe("split");
      const before = useTabsStore.getState();
      let writes = 0;
      const unsub = useTabsStore.subscribe((s, prev) => {
        if (s.tabsByScope !== prev.tabsByScope || s.layoutByScope !== prev.layoutByScope) writes += 1;
      });
      for (let i = 1; i <= 50; i++) {
        useTabsStore.getState().setViewerState(tab.key, { scrollTop: i * 10 });
      }
      const after = useTabsStore.getState();
      // The whole shell's inputs are identical: nothing re-rendered, nothing persisted.
      expect(after.tabs).toBe(before.tabs);
      expect(after.tabsByScope).toBe(before.tabsByScope);
      expect(after.layout).toBe(before.layout);
      expect(after.layoutByScope).toBe(before.layoutByScope);
      expect(writes).toBe(0);
      // The flush interval folds the LATEST position in with one write.
      vi.advanceTimersByTime(VIEWER_STATE_FLUSH_MS);
      expect(writes).toBe(1);
      const stored = useTabsStore.getState().tabs.find((t) => t.key === tab.key);
      expect(stored?.viewerState).toEqual({ scrollTop: 500 });
      // The layout tree itself was not rebuilt by the fold either.
      expect(useTabsStore.getState().layout).toBe(before.layout);
      expect(useTabsStore.getState().layoutByScope).toBe(before.layoutByScope);
      unsub();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the layout tree's identity for a payload-only write", () => {
    const store = useTabsStore.getState();
    store.setScope("p");
    const tab = store.addTab({
      label: "notes.md",
      cmd: "",
      cwd: "/p",
      kind: "embed",
      embedPath: "/p/notes.md",
      viewer: "markdown",
    });
    const before = useTabsStore.getState();
    // A per-tab setting writes through (the shell reads it reactively)…
    useTabsStore.getState().setViewerState(tab.key, { fontSize: 15 });
    const after = useTabsStore.getState();
    expect(after.tabs.find((t) => t.key === tab.key)?.viewerState).toEqual({ fontSize: 15 });
    expect(after.tabs).not.toBe(before.tabs);
    // …but the group/split tree was not rebuilt for it.
    expect(after.layout).toBe(before.layout);
    expect(after.layoutByScope).toBe(before.layoutByScope);
    expect(after.focusedGroupByScope).toBe(before.focusedGroupByScope);
  });

  it("still yields a new tree for every genuine layout change", () => {
    // Identity preservation (§3.1) must not swallow a real change: each of these
    // edits re-renders the shell, so each must hand it a new tree.
    const store = useTabsStore.getState();
    store.setScope("p");
    const a = store.addTab({ label: "a", cmd: "bash", cwd: "/p", kind: "shell" });
    const b = store.addTab({ label: "b", cmd: "bash", cwd: "/p", kind: "shell" });
    const c = store.addTab({ label: "c", cmd: "bash", cwd: "/p", kind: "shell" });
    const snap = () => {
      const s = useTabsStore.getState();
      return { layout: s.layout, byScope: s.layoutByScope, focus: s.focusedGroupByScope };
    };
    const changed = (before: ReturnType<typeof snap>) => {
      const after = snap();
      expect(after.layout).not.toBe(before.layout);
      expect(after.byScope).not.toBe(before.byScope);
    };
    const rootGroup = () => {
      const l = useTabsStore.getState().layout;
      if (l?.type !== "group") throw new Error("expected a root group");
      return l;
    };

    // Active tab.
    let before = snap();
    useTabsStore.getState().setActive(a.key);
    changed(before);
    expect(rootGroup().activeKey).toBe(a.key);

    // Tab order (a reorder within the group).
    before = snap();
    useTabsStore.getState().moveTab(c.key, rootGroup().id, 0);
    changed(before);
    expect(rootGroup().tabKeys).toEqual([c.key, a.key, b.key]);

    // A group added (split).
    before = snap();
    useTabsStore.getState().splitWithTab(b.key, rootGroup().id, "right");
    changed(before);
    const split = useTabsStore.getState().layout;
    if (split?.type !== "split") throw new Error("expected a split");
    expect(split.children).toHaveLength(2);

    // Split ratio.
    before = snap();
    useTabsStore.getState().resizeSplit(split.id, 0, 0.3);
    changed(before);
    const resized = useTabsStore.getState().layout;
    if (resized?.type !== "split") throw new Error("expected a split");
    expect(resized.sizes[0]).toBeCloseTo(0.3);
    expect(resized.sizes[1]).toBeCloseTo(0.7);

    // Focused group: the split left the focus on b's new group; activating a
    // tab of the other group moves it (and activating b again would not).
    const aGroup = resized.children.find((n) => n.type === "group" && n.tabKeys.includes(a.key));
    if (aGroup?.type !== "group") throw new Error("expected a's group");
    before = snap();
    useTabsStore.getState().setActive(a.key);
    expect(snap().focus).not.toBe(before.focus);
    expect(useTabsStore.getState().focusedGroupId).toBe(aGroup.id);
    before = snap();
    useTabsStore.getState().setActive(a.key);
    expect(snap().focus).toBe(before.focus);

    // A group removed (its last tab closed collapses the split).
    before = snap();
    useTabsStore.getState().removeTab(b.key);
    changed(before);
    expect(useTabsStore.getState().layout?.type).toBe("group");
    expect(rootGroup().tabKeys).toEqual([c.key, a.key]);
  });

  it("drops a staged position whose tab was closed", () => {
    const store = useTabsStore.getState();
    store.setScope("p");
    const tab = store.addTab({
      label: "doc.pdf",
      cmd: "",
      cwd: "/p",
      kind: "embed",
      embedPath: "/p/doc.pdf",
      viewer: "pdf",
    });
    useTabsStore.getState().setViewerState(tab.key, { scrollTop: 99 });
    useTabsStore.getState().removeTab(tab.key);
    const before = useTabsStore.getState();
    flushViewerState();
    expect(pendingViewerState(tab.key)).toBeUndefined();
    expect(useTabsStore.getState().tabsByScope).toBe(before.tabsByScope);
  });

  it("does not churn the tabs array when nothing changes", () => {
    const store = useTabsStore.getState();
    store.setScope("p");
    const tab = store.addTab({
      label: "pic.png",
      cmd: "",
      cwd: "/p",
      kind: "embed",
      embedPath: "/p/pic.png",
      viewer: "image",
    });
    useTabsStore.getState().setViewerState(tab.key, { scale: 2, offsetX: 10, offsetY: 5 });
    const before = useTabsStore.getState().tabs;
    // Re-persisting identical values is a no-op (same array reference), so the
    // debounced saveLayout effect isn't woken for nothing.
    useTabsStore.getState().setViewerState(tab.key, { scale: 2, offsetX: 10, offsetY: 5 });
    expect(useTabsStore.getState().tabs).toBe(before);
  });

  it("stores a patch touching only fields outside the old equality list", () => {
    // Regression: the no-op guard used to be a hand-maintained field list, so a
    // patch touching only an unlisted ViewerState field (yamlCollapsed,
    // delimiter, bibSort, breakpoints, …) merged, compared equal on the listed
    // fields, and was silently dropped. The guard is a generic shallow compare
    // over the union of keys now — any field difference must get through.
    const store = useTabsStore.getState();
    store.setScope("p");
    const tab = store.addTab({
      label: "data.csv",
      cmd: "",
      cwd: "/p",
      kind: "embed",
      embedPath: "/p/data.csv",
      viewer: "table",
    });

    useTabsStore.getState().setViewerState(tab.key, { delimiter: ";" });
    useTabsStore.getState().setViewerState(tab.key, { bibSort: "year", bibSortDesc: true });
    const collapsed = ["intro"];
    useTabsStore.getState().setViewerState(tab.key, { yamlCollapsed: collapsed });

    const stored = useTabsStore.getState().tabs.find((t) => t.key === tab.key);
    expect(stored?.viewerState).toEqual({
      delimiter: ";",
      bibSort: "year",
      bibSortDesc: true,
      yamlCollapsed: collapsed,
    });

    // Same-reference array patch is still deduped (compare-by-ref).
    const before = useTabsStore.getState().tabs;
    useTabsStore.getState().setViewerState(tab.key, { yamlCollapsed: collapsed });
    expect(useTabsStore.getState().tabs).toBe(before);
  });
});

describe("viewerState round-trips through save/load", () => {
  beforeEach(() => {
    invokeMock.mockClear();
    resetStore();
  });

  it("persists viewerState in the saved tab layout", async () => {
    const store = useTabsStore.getState();
    store.setScope("p");
    const tab = store.addTab({
      label: "doc.pdf",
      cmd: "",
      cwd: "/p",
      kind: "embed",
      embedPath: "/p/doc.pdf",
      viewer: "pdf",
    });
    useTabsStore.getState().setViewerState(tab.key, { scale: 1.8, scrollTop: 320, scrollLeft: 12 });

    // The quit path saves without a flush: the staged position must be in it.
    expect(useTabsStore.getState().tabs.find((t) => t.key === tab.key)?.viewerState).toBeUndefined();
    await useTabsStore.getState().saveLayout("/p/project.json");

    const call = invokeMock.mock.calls.find((c) => c[0] === "workspace_sync");
    expect(call).toBeTruthy();
    const arg = call![1] as {
      tabs: { label: string; viewerState?: Record<string, number> }[];
      groups: SavedLayoutTree | null;
    };
    const saved = arg.tabs.find((t) => t.label === "doc.pdf");
    expect(saved?.viewerState).toEqual({ scale: 1.8, scrollTop: 320, scrollLeft: 12 });
  });

  it("restores viewerState onto the rebuilt tab", () => {
    useTabsStore.getState().loadFromLayout(
      [
        {
          key: "embed-3",
          label: "doc.pdf",
          cmd: "",
          cwd: "/p",
          kind: "embed",
          embedPath: "/p/doc.pdf",
          viewer: "pdf",
          viewerState: { scale: 1.8, scrollTop: 320 },
        },
      ],
      "/p",
      "p",
    );
    const tabs = useTabsStore.getState().tabsByScope["p"];
    expect(tabs).toHaveLength(1);
    expect(tabs[0].viewerState).toEqual({ scale: 1.8, scrollTop: 320 });
  });

  it("round-trips the TeX workspace layout fields (active file, sidebar width)", async () => {
    const store = useTabsStore.getState();
    store.setScope("p");
    const tab = store.addTab({
      label: "paper.tex",
      cmd: "",
      cwd: "/p",
      kind: "embed",
      embedPath: "/p/paper.tex",
      viewer: "texworkspace",
    });
    useTabsStore.getState().setViewerState(tab.key, {
      texActivePath: "/p/chap.tex",
      texSidebarWidth: 260,
    });

    // A no-op re-write of the same workspace fields keeps the array identity
    // (the debounced saveLayout isn't woken for nothing).
    const before = useTabsStore.getState().tabs;
    useTabsStore.getState().setViewerState(tab.key, {
      texActivePath: "/p/chap.tex",
      texSidebarWidth: 260,
    });
    expect(useTabsStore.getState().tabs).toBe(before);

    await useTabsStore.getState().saveLayout("/p/project.json");
    const call = invokeMock.mock.calls.find((c) => c[0] === "workspace_sync");
    const arg = call![1] as {
      tabs: { label: string; viewerState?: Record<string, unknown> }[];
    };
    const saved = arg.tabs.find((t) => t.label === "paper.tex");
    expect(saved?.viewerState).toEqual({
      texActivePath: "/p/chap.tex",
      texSidebarWidth: 260,
    });

    // …and they come back on the rebuilt tab.
    useTabsStore.getState().loadFromLayout(
      [
        {
          key: "embed-9",
          label: "paper.tex",
          cmd: "",
          cwd: "/p",
          kind: "embed",
          embedPath: "/p/paper.tex",
          viewer: "texworkspace",
          viewerState: {
            texActivePath: "/p/chap.tex",
            texSidebarWidth: 260,
          },
        },
      ],
      "/p2",
      "p2",
    );
    const restored = useTabsStore.getState().tabsByScope["p2"];
    expect(restored).toHaveLength(1);
    expect(restored[0].viewer).toBe("texworkspace");
    expect(restored[0].viewerState).toEqual({
      texActivePath: "/p/chap.tex",
      texSidebarWidth: 260,
    });
  });
});
