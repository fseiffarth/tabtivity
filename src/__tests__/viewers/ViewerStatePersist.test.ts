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

import { useTabsStore, type SavedLayoutTree } from "../../stores/tabs";

const invokeMock = vi.mocked(invoke);

function resetStore() {
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

    const stored = useTabsStore.getState().tabs.find((t) => t.key === tab.key);
    // The second patch merges with (doesn't replace) the first.
    expect(stored?.viewerState).toEqual({ scale: 1.5, scrollTop: 240 });
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
