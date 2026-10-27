/**
 * The viewer-state stage seen from a viewer (`useViewerState`, performance
 * plan §3.1): a position written while the reader moves is staged, folded into
 * the tabs store when the pane leaves the screen or the viewer unmounts, and a
 * viewer mounting while something is staged seeds from the stage first — so a
 * sleeping PDF that wakes restores where the reader actually was.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("../../stores/windows", () => ({
  useWindowsStore: { getState: () => ({ openFile: () => Promise.resolve() }) },
}));
vi.mock("../../stores/settings", () => ({
  useSettingsStore: (sel: (s: unknown) => unknown) =>
    sel({ settings: { autosave: false, viewer_prefs: {} } }),
}));

import { useViewerState } from "../../components/embed/fileViewer/viewerState";
import { PaneVisibleContext } from "../../lib/files/fileAccess";
import { flushViewerState, pendingViewerState, useTabsStore } from "../../stores/tabs";

function addPdfTab() {
  const store = useTabsStore.getState();
  store.setScope("p");
  return store.addTab({
    label: "doc.pdf",
    cmd: "",
    cwd: "/p",
    kind: "embed",
    embedPath: "/p/doc.pdf",
    viewer: "pdf",
  });
}

const storedOf = (key: string) =>
  useTabsStore.getState().tabs.find((t) => t.key === key)?.viewerState;

function wrapperFor(visible: { current: boolean }) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <PaneVisibleContext.Provider value={visible.current}>{children}</PaneVisibleContext.Provider>;
  };
}

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

describe("useViewerState and the §3.1 stage", () => {
  it("folds the staged position into the store when the pane hides", () => {
    const tab = addPdfTab();
    const visible = { current: true };
    const hook = renderHook(() => useViewerState(tab.key), { wrapper: wrapperFor(visible) });
    act(() => hook.result.current.persist({ scrollTop: 1200, scale: 1.3 }));
    expect(storedOf(tab.key)).toBeUndefined();
    expect(pendingViewerState(tab.key)).toEqual({ scrollTop: 1200, scale: 1.3 });
    visible.current = false;
    hook.rerender();
    expect(storedOf(tab.key)).toEqual({ scrollTop: 1200, scale: 1.3 });
    expect(pendingViewerState(tab.key)).toBeUndefined();
  });

  it("folds the staged position into the store when the viewer unmounts", () => {
    const tab = addPdfTab();
    const hook = renderHook(() => useViewerState(tab.key));
    act(() => hook.result.current.persist({ scrollTop: 640 }));
    expect(storedOf(tab.key)).toBeUndefined();
    hook.unmount();
    expect(storedOf(tab.key)).toEqual({ scrollTop: 640 });
  });

  it("seeds a remount from the stage before the store", () => {
    const tab = addPdfTab();
    useTabsStore.getState().setViewerState(tab.key, { fontSize: 12 });
    const first = renderHook(() => useViewerState(tab.key));
    act(() => first.result.current.persist({ scrollTop: 300, scrollLeft: 4 }));
    // A second viewer of the tab mounts while the first's write is still staged
    // (the store says nothing about a position yet): it must see the stage.
    const second = renderHook(() => useViewerState(tab.key));
    expect(second.result.current.initial).toEqual({ fontSize: 12, scrollTop: 300, scrollLeft: 4 });
    // The seed is read once: a later write does not move it.
    act(() => first.result.current.persist({ scrollTop: 999 }));
    expect(second.result.current.initial?.scrollTop).toBe(300);
    first.unmount();
    second.unmount();
    expect(storedOf(tab.key)).toEqual({ fontSize: 12, scrollTop: 999, scrollLeft: 4 });
  });

  it("writes a per-tab setting through at once", () => {
    const tab = addPdfTab();
    const hook = renderHook(() => useViewerState(tab.key));
    act(() => hook.result.current.persist({ pdfAutosaveNotes: false }));
    expect(storedOf(tab.key)).toEqual({ pdfAutosaveNotes: false });
    expect(pendingViewerState(tab.key)).toBeUndefined();
  });
});
