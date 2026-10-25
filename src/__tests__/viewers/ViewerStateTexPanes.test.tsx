/**
 * A TeX workspace's sub-panes (a child `.tex`, a graphic, a PDF in the centre)
 * write their view state under `<tab key>#<path>`. That key names no tab, so
 * until the store learnt it the position was staged, then dropped at the
 * flush: a wake from sleep, a popout dock-back or S3's hidden-PDF release
 * reopened the pane at the default position. The store now keeps it in the
 * workspace tab's `texPanes[path]`, through the same §3.1 stage, and keeps at
 * most `TEX_PANES_CAP` of them.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("../../stores/windows", () => ({
  useWindowsStore: { getState: () => ({ openFile: () => Promise.resolve() }) },
}));
vi.mock("../../stores/settings", () => {
  const state = { settings: { autosave: false, viewer_prefs: {} } };
  return {
    useSettingsStore: Object.assign((sel: (s: unknown) => unknown) => sel(state), {
      getState: () => state,
    }),
  };
});

import { useViewerState } from "../../components/embed/FileViewerPane";
import {
  TEX_PANES_CAP,
  flushViewerState,
  pendingViewerState,
  persistedViewerState,
  toSavedTabEntry,
  useTabsStore,
} from "../../stores/tabs";

function addWorkspaceTab() {
  const store = useTabsStore.getState();
  store.setScope("p");
  return store.addTab({
    label: "thesis.tex",
    cmd: "",
    cwd: "/p",
    kind: "embed",
    embedPath: "/p/thesis.tex",
    viewer: "texworkspace",
  });
}

const tabOf = (key: string) => useTabsStore.getState().tabs.find((t) => t.key === key);

beforeEach(() => {
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
});
afterEach(() => {
  cleanup();
});

describe("TeX workspace sub-pane view state", () => {
  it("a sub-pane's position survives its viewer unmounting and seeds the next mount (a wake)", () => {
    const tab = addWorkspaceTab();
    const sub = `${tab.key}#/p/chapters/intro.tex`;
    const first = renderHook(() => useViewerState(sub));
    act(() => first.result.current.persist({ scrollTop: 840 }));
    first.unmount();
    expect(pendingViewerState(sub)).toBeUndefined();
    expect(tabOf(tab.key)?.viewerState?.texPanes?.["/p/chapters/intro.tex"]).toEqual({ scrollTop: 840 });
    // The tab's own fields are untouched: the main document's pane uses those.
    expect(tabOf(tab.key)?.viewerState?.scrollTop).toBeUndefined();

    const woken = renderHook(() => useViewerState(sub));
    expect(woken.result.current.initial).toEqual({ scrollTop: 840 });
  });

  it("a PDF centre's zoom and scroll persist, staged until the flush", () => {
    const tab = addWorkspaceTab();
    const sub = `${tab.key}#/p/thesis.pdf`;
    useTabsStore.getState().setViewerState(sub, { scale: 1.6, scrollTop: 2400, pdfFitted: false });
    // Staged, not written: but a save made now carries it.
    expect(tabOf(tab.key)?.viewerState).toBeUndefined();
    expect(toSavedTabEntry(tabOf(tab.key)!).viewerState?.texPanes?.["/p/thesis.pdf"]).toEqual({
      scale: 1.6,
      scrollTop: 2400,
      pdfFitted: false,
    });
    flushViewerState();
    expect(persistedViewerState(useTabsStore.getState(), sub)).toEqual({ scale: 1.6, scrollTop: 2400, pdfFitted: false });
  });

  it("a sub-pane's per-tab setting writes through into its entry", () => {
    const tab = addWorkspaceTab();
    const sub = `${tab.key}#/p/chapters/intro.tex`;
    useTabsStore.getState().setViewerState(sub, { fontSize: 16 });
    expect(tabOf(tab.key)?.viewerState?.texPanes?.["/p/chapters/intro.tex"]).toEqual({ fontSize: 16 });
  });

  it(`keeps at most ${TEX_PANES_CAP} paths, dropping the least recently written`, () => {
    const tab = addWorkspaceTab();
    const store = useTabsStore.getState();
    for (let i = 0; i < TEX_PANES_CAP + 8; i++) store.setViewerState(`${tab.key}#/p/c${i}.tex`, { fontSize: 10 + i });
    let panes = tabOf(tab.key)?.viewerState?.texPanes ?? {};
    expect(Object.keys(panes)).toHaveLength(TEX_PANES_CAP);
    expect(panes["/p/c7.tex"]).toBeUndefined();
    expect(panes["/p/c8.tex"]).toEqual({ fontSize: 18 });
    // Re-writing the oldest kept one makes it the most recent, so the next
    // new path drops the one after it instead.
    store.setViewerState(`${tab.key}#/p/c8.tex`, { fontSize: 99 });
    store.setViewerState(`${tab.key}#/p/new.tex`, { fontSize: 12 });
    panes = tabOf(tab.key)?.viewerState?.texPanes ?? {};
    const paths = Object.keys(panes);
    expect(paths).toHaveLength(TEX_PANES_CAP);
    expect(paths.slice(-2)).toEqual(["/p/c8.tex", "/p/new.tex"]);
    expect(panes["/p/c8.tex"]).toEqual({ fontSize: 99 });
    expect(panes["/p/c9.tex"]).toBeUndefined();
  });

  it("goes with the workspace tab when it closes", () => {
    const tab = addWorkspaceTab();
    const sub = `${tab.key}#/p/chapters/intro.tex`;
    useTabsStore.getState().setViewerState(sub, { scrollTop: 300 });
    useTabsStore.getState().removeTab(tab.key);
    flushViewerState();
    expect(pendingViewerState(sub)).toBeUndefined();
    expect(persistedViewerState(useTabsStore.getState(), sub)).toBeUndefined();
  });
});
