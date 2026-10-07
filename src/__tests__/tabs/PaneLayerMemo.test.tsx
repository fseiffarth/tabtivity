/**
 * The flat pane layer with many tabs (performance plan §5.1): the per-tab
 * derivation lives in a memoised `PaneSlot`, so a `groupRects` measure
 * re-renders the positioned boxes only (no slot), a change to one tab's entry
 * re-renders that one slot, and a redundant `setActive` on the already-active
 * tab writes nothing to the store (no layout rebuild to re-render from).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(undefined)) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    scaleFactor: () => Promise.resolve(1),
    innerPosition: () => Promise.resolve({ toLogical: () => ({ x: 0, y: 0 }) }),
    onMoved: () => Promise.resolve(() => {}),
    onResized: () => Promise.resolve(() => {}),
    onFocusChanged: () => Promise.resolve(() => {}),
  }),
}));
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// A plain (un-memoised) stand-in: every render of a `PaneSlot` renders it once,
// so its per-key count is the slot's render count.
const renders = new Map<string, number>();
vi.mock("../../components/tabs/TabPane", () => ({
  TabPane: (props: { tab: { key: string }; visible: boolean }) => {
    renders.set(props.tab.key, (renders.get(props.tab.key) ?? 0) + 1);
    return <div data-testid={`pane-${props.tab.key}`} data-visible={String(props.visible)} />;
  },
}));

import { CenterPanel } from "../../components/layout/CenterPanel";
import { ROOT_SCOPE, useTabsStore, type TabEntry } from "../../stores/tabs";
import { useProjectsStore } from "../../stores/projects";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { useOverlayAgentStore } from "../../stores/overlayAgent";

const N = 60;
let keys: string[];

const total = () => [...renders.values()].reduce((a, b) => a + b, 0);

function rect(w: number, h: number): DOMRect {
  return { left: 0, top: 0, right: w, bottom: h, width: w, height: h, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
}

beforeEach(() => {
  cleanup();
  renders.clear();
  localStorage.clear();
  useProjectsStore.setState({ projects: [], activeId: null, rootDir: "/r" });
  useTabsStore.setState({
    scope: ROOT_SCOPE,
    tabsByScope: { [ROOT_SCOPE]: [] },
    layoutByScope: { [ROOT_SCOPE]: null },
    focusedGroupByScope: { [ROOT_SCOPE]: null },
    detachedGroupsByScope: {},
    fullscreenGroupId: null,
  });
  useTabsStore.getState().setScope(ROOT_SCOPE);
  const s = useTabsStore.getState();
  keys = [];
  for (let i = 0; i < N; i++) {
    const tab: TabEntry = s.addTabToScope(ROOT_SCOPE, {
      label: `Shell ${i}`,
      cmd: "bash",
      cwd: "",
      kind: "shell",
    });
    keys.push(tab.key);
  }
  useRootOverlayStore.setState({ open: false, installTabs: {} });
  useOverlayAgentStore.setState({ shownKeys: new Set() });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pane layer memoisation (60 tabs)", () => {
  it("re-renders no PaneSlot on a groupRects change", async () => {
    render(<CenterPanel />);
    await act(async () => {});
    expect(renders.size).toBe(N);
    const before = total();

    // The layer measures group bodies off `getBoundingClientRect`; jsdom's is
    // all zeros, so a non-zero answer + the window-resize bridge is a real
    // rect change.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => rect(800, 600));
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
    const shown = document.querySelector<HTMLElement>(".center-pane[style*='display: flex']");
    expect(shown?.style.width).toBe("800px");
    expect(total()).toBe(before);
  });

  it("re-renders exactly one PaneSlot when one tab's entry changes", async () => {
    render(<CenterPanel />);
    await act(async () => {});
    const before = new Map(renders);
    const target = keys[17];

    await act(async () => {
      useTabsStore.getState().renameTab(target, "Renamed");
    });
    for (const k of keys) {
      expect(renders.get(k), k).toBe((before.get(k) ?? 0) + (k === target ? 1 : 0));
    }
  });

  it("setActive on the already-active tab of the focused group writes nothing", async () => {
    render(<CenterPanel />);
    await act(async () => {});
    const st = useTabsStore.getState();
    const active = st.layout?.type === "group" ? st.layout.activeKey : null;
    expect(active).toBe(keys[N - 1]);
    const layoutBefore = st.layoutByScope;
    const tabsBefore = st.tabsByScope;
    const renderedBefore = total();

    await act(async () => {
      useTabsStore.getState().setActive(active!);
    });
    expect(useTabsStore.getState().layoutByScope).toBe(layoutBefore);
    expect(useTabsStore.getState().tabsByScope).toBe(tabsBefore);
    expect(total()).toBe(renderedBefore);

    // A real activation still goes through (and re-renders the two slots whose
    // visibility flips).
    await act(async () => {
      useTabsStore.getState().setActive(keys[0]);
    });
    expect(useTabsStore.getState().layoutByScope).not.toBe(layoutBefore);
    const after = useTabsStore.getState().layout;
    expect(after?.type === "group" ? after.activeKey : null).toBe(keys[0]);
    expect(total()).toBe(renderedBefore + 2);
  });
});
