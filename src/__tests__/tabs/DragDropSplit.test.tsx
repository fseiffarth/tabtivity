/**
 * Integration test for the pointer-driven tab drag → edge-split drop pipeline,
 * exercising the REAL CenterPanel + Subwindow + TabBar wiring (not hand-fed store
 * calls like SplitLayout.test.ts). jsdom has no layout engine, so we stub the two
 * geometry primitives the pipeline relies on:
 *   - getBoundingClientRect (panel + each subwindow pane slot + each tab), so
 *     CenterPanel.measure() produces real groupRects and pickEdge sees a body.
 *   - document.elementFromPoint, so resolve() can decide what's under the pointer.
 *
 * A drag of tab b into the right half of the body must commit a `split` with b
 * carved off to the right. This is the path the live build regressed on
 * ("animation shows but split is not done").
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, cleanup } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(false)) }));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: { getByLabel: vi.fn(() => Promise.resolve({
    innerPosition: () => Promise.resolve({ x: 0, y: 0 }),
    outerPosition: () => Promise.resolve({ x: 0, y: 0 }),
    outerSize: () => Promise.resolve({ width: 800, height: 600 }),
    scaleFactor: () => Promise.resolve(1),
  })) },
}));

// CenterPanel installs detached-drag listeners and reads the window origin on
// mount; none of that is exercised here, so stub the Tauri window/event APIs.
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
  }),
  // A drag starts a 16ms cursor-position poll (coords.startCursorPoll); the mock
  // must export it or the polling timer throws a synchronous (uncatchable) error.
  cursorPosition: () => Promise.resolve({ x: 0, y: 0 }),
}));

// The pane contents are irrelevant to the drop pipeline and pull in xterm.js /
// FUSE-ish browser APIs jsdom lacks. Stub them with inert markers.
vi.mock("../../components/terminal/TerminalView", () => ({
  TerminalView: () => <div className="mock-terminal" />,
}));
vi.mock("../../components/files/FileBrowser", () => ({
  FileBrowser: () => <div className="mock-files" />,
}));

import { CenterPanel } from "../../components/layout/CenterPanel";
import { EMPTY_GROUP_ID, useTabsStore, type GroupNode, type SplitNode } from "../../stores/tabs";
import { NEW_TAB_SHORTCUT_EVENT, type NewTabShortcutDetail } from "../../lib/shortcuts/newTabChord";
import { useDragStore } from "../../stores/drag/drag";
import { useProjectsStore } from "../../stores/projects";
import * as coords from "../../lib/window/coords";

// Panel geometry the stubs project onto. Body sits below a 28px tab bar.
const PANEL = { left: 0, top: 0, width: 800, height: 600 };
const BAR_H = 28;
const BODY = { left: 0, top: BAR_H, width: 800, height: 600 - BAR_H };

function seedTwoTabs() {
  // CenterPanel derives its scope from the active project id (activeId ?? "root")
  // and its setScope effect would otherwise clobber a hand-set scope. Make the
  // active project id "p" so the component's scope matches our seeded tabs.
  useProjectsStore.setState({
    projects: [{ id: "p", name: "P", directory: "/p", local_file: "" } as never],
    activeId: "p",
  });
  useTabsStore.setState({
    scope: "p",
    tabsByScope: {},
    layoutByScope: {},
    focusedGroupByScope: {},
    tabs: [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
    detachedGroupsByScope: {},
  });
  useTabsStore.getState().setScope("p");
  const a = useTabsStore.getState().addTab({ label: "a", cmd: "bash", cwd: "/p", kind: "shell" });
  const b = useTabsStore.getState().addTab({ label: "b", cmd: "bash", cwd: "/p", kind: "shell" });
  return { a, b };
}

/**
 * Install geometry stubs. `getBoundingClientRect` is dispatched by element class:
 * the panel → PANEL, a `.subwindow-pane-slot` (the measured group body) → BODY,
 * a `.tab` → a slice of the bar. `elementFromPoint` returns the pane slot for any
 * point inside the body (so resolve() takes the edge-split branch, not tab-bar).
 */
function installGeometry(getContainer: () => HTMLElement) {
  const slot = () => getContainer().querySelector(".subwindow-pane-slot") as HTMLElement | null;

  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const rect = (r: typeof PANEL) =>
      ({ ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON() {} }) as DOMRect;
    if (this.classList.contains("center-panel")) return rect(PANEL);
    if (this.classList.contains("subwindow-pane-slot")) return rect(BODY);
    if (this.classList.contains("tab")) {
      const idx = Number(this.dataset.tabIndex ?? 0);
      return rect({ left: idx * 100, top: 0, width: 100, height: BAR_H });
    }
    // Tab bar spans the top strip; subwindow spans the whole panel.
    if (this.classList.contains("tab-bar")) return rect({ left: 0, top: 0, width: 800, height: BAR_H });
    return rect(PANEL);
  });

  document.elementFromPoint = ((_x: number, y: number) => {
    // A point in the tab-bar strip resolves to the bar; below it, the body slot.
    if (y < BAR_H) return getContainer().querySelector(".tab-bar");
    return slot();
  }) as typeof document.elementFromPoint;
}

function pointer(type: string, x: number, y: number, target: EventTarget) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, { clientX: x, clientY: y, button: 0, pointerId: 1 });
  act(() => {
    target.dispatchEvent(ev);
  });
  return ev;
}

async function flush() {
  // Let queued microtasks (TabBar's strand-fallback) and React effects settle.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("CenterPanel — pointer drag → edge split (integration)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    cleanup();
    useDragStore.getState().end();
  });

  /**
   * Mount CenterPanel with geometry stubbed and groupRects populated, returning
   * the live container and the seeded tab keys.
   */
  async function mountSeeded() {
    const { a, b } = seedTwoTabs();
    // Install geometry BEFORE render via a late-bound container holder, so the
    // very first measure() (in CenterPanel's mount layout-effect) reads real
    // rects and groupRects is populated for the group body.
    let containerEl: HTMLElement;
    installGeometry(() => containerEl);
    const r = render(<CenterPanel />);
    containerEl = r.container;
    // Nudge a real layout-effect re-run so measure() runs again now that the DOM
    // is mounted and the container holder is bound (toggle scope away and back).
    await act(async () => {
      useTabsStore.getState().setScope("root");
      useTabsStore.getState().setScope("p");
    });
    return { a, b, container: containerEl };
  }

  const RIGHT_X = 700; // right half of an 800-wide body
  const BODY_Y = BAR_H + 200;

  it("opens the empty scope's own new-tab menu from its full-body placeholder", async () => {
    useProjectsStore.setState({ projects: [], activeId: null, rootDir: "/r" });
    useTabsStore.setState({
      scope: "root", tabsByScope: { root: [] }, layoutByScope: { root: null },
      focusedGroupByScope: { root: null }, tabs: [], layout: null,
      focusedGroupId: null, activeKey: null, detachedGroupsByScope: {},
    });
    useTabsStore.getState().setScope("root");
    const requests: NewTabShortcutDetail[] = [];
    const onRequest = (event: Event) => requests.push((event as CustomEvent<NewTabShortcutDetail>).detail);
    window.addEventListener(NEW_TAB_SHORTCUT_EVENT, onRequest);
    try {
      const { container } = render(<CenterPanel />);
      await flush();
      expect(container.querySelector(".center-placeholder")).not.toBeNull();
      expect(container.querySelector(".center-placeholder")?.contains(container.querySelector(".center-placeholder-card"))).toBe(true);
      expect(container.querySelector(".tab-new-btn")?.getAttribute("aria-expanded")).toBe("false");
      await act(async () => {
        fireEvent.click(container.querySelector(".center-placeholder-action")!);
      });
      expect(requests).toEqual([{ request: { kind: "menu" }, groupId: EMPTY_GROUP_ID, besideActive: undefined }]);
      expect(container.querySelector(".tab-new-btn")?.getAttribute("aria-expanded")).toBe("true");
      expect(document.querySelector(".tab-add-menu")).not.toBeNull();
      expect(useTabsStore.getState().scope).toBe("root");
    } finally {
      window.removeEventListener(NEW_TAB_SHORTCUT_EVENT, onRequest);
    }
  });

  function expectSplitRight(aKey: string, bKey: string) {
    const layout = useTabsStore.getState().layout;
    expect(layout?.type).toBe("split");
    const split = layout as SplitNode;
    expect(split.dir).toBe("row");
    expect(split.children.length).toBe(2);
    const [first, second] = split.children as GroupNode[];
    expect(first.tabKeys).toEqual([aKey]); // original target keeps a
    expect(second.tabKeys).toEqual([bKey]); // b carved off to the right
    // Drag state fully cleared (no strand).
    expect(useDragStore.getState().drag).toBeNull();
  }

  it("SLOW drag: dropping tab b on the right half splits it off to the right", async () => {
    const { a, b, container } = await mountSeeded();
    const tabB = container.querySelector('.tab[data-tab-index="1"]') as HTMLElement;
    expect(tabB).toBeTruthy();

    pointer("pointerdown", 150, 14, tabB); // on tab b within the bar
    pointer("pointermove", 160, 24, window); // crosses 5px → start()
    await flush(); // let CenterPanel's dragging effect attach its listeners
    pointer("pointermove", RIGHT_X, BODY_Y, window); // resolve → right edge
    pointer("pointerup", RIGHT_X, BODY_Y, window); // commit
    await flush();

    expectSplitRight(a.key, b.key);
  });

  it("Wayland dummy coordinates never route a visible split into an existing popout", async () => {
    const { a, b, container } = await mountSeeded();
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockImplementation((cmd) => Promise.resolve(
      cmd === "detached_window_frontmost" ? true : false,
    ) as never);
    useTabsStore.setState({ detachedGroupsByScope: { p: [{
      id: "pop", label: "pop",
      subtree: { type: "group", id: "pop", tabKeys: [], activeKey: null },
    }] } });
    const dock = vi.spyOn(useTabsStore.getState(), "dockTabIntoDetached");
    pointer("pointerdown", 150, 14, container.querySelectorAll(".tab")[1]);
    pointer("pointermove", 160, 24, window);
    await flush();
    pointer("pointermove", RIGHT_X, BODY_Y, window);
    pointer("pointerup", RIGHT_X, BODY_Y, window);
    await flush();
    expectSplitRight(a.key, b.key);
    expect(dock).not.toHaveBeenCalled();
  });

  it.each(["occluded", "unavailable"])("keeps a visible split when popout stacking is %s", async (visibility) => {
    const { a, b, container } = await mountSeeded();
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockImplementation((cmd) => {
      if (cmd === "detached_window_frontmost" && visibility === "unavailable") {
        return Promise.reject(new Error("stacking unavailable"));
      }
      return Promise.resolve(false) as never;
    });
    vi.spyOn(coords, "desktopCursor").mockResolvedValue({ x: RIGHT_X, y: BODY_Y });
    vi.spyOn(coords, "snapshotFrame").mockResolvedValue({
      innerPhys: { x: 0, y: 0 }, outerPhys: { x: 0, y: 0 },
      outerSize: { w: 800, h: 600 }, scale: 1,
    });
    useTabsStore.setState({ detachedGroupsByScope: { p: [{
      id: "pop", label: "pop",
      subtree: { type: "group", id: "pop", tabKeys: [], activeKey: null },
    }] } });
    const dock = vi.spyOn(useTabsStore.getState(), "dockTabIntoDetached");
    pointer("pointerdown", 150, 14, container.querySelectorAll(".tab")[1]);
    pointer("pointermove", 160, 24, window);
    await flush();
    pointer("pointermove", RIGHT_X, BODY_Y, window);
    pointer("pointerup", RIGHT_X, BODY_Y, window);
    await flush();
    expect(invoke).toHaveBeenCalledWith("detached_window_frontmost", { registryId: "pop" });
    expectSplitRight(a.key, b.key);
    expect(dock).not.toHaveBeenCalled();
  });

  it("UP re-resolves to a tab bar: release still splits (uses last edge target)", async () => {
    // The live regression: the move resolves the right-edge target (animation
    // shows), but at the *release* document.elementFromPoint returns a `.tab-bar`
    // — e.g. the release lands a hair inside the bar strip, or WebKitGTK's
    // elementFromPoint hits the bar through the click-through panes. If onUp
    // re-resolves at the release point it overwrites the edge target with a
    // *reorder* target and commits a (no-op) reorder instead of the split. The
    // commit must honour the LAST edge target the user saw highlighted.
    const { a, b, container } = await mountSeeded();
    const tabB = container.querySelector('.tab[data-tab-index="1"]') as HTMLElement;
    expect(tabB).toBeTruthy();

    pointer("pointerdown", 150, 14, tabB);
    pointer("pointermove", 160, 24, window); // start()
    await flush(); // attach CenterPanel listeners
    pointer("pointermove", RIGHT_X, BODY_Y, window); // resolve → right edge (animation)

    // Force the *release* hit-test to land on the tab bar (model the bar
    // creeping under the release point). The last resolved target was the
    // right-edge split of g-1.
    const savedEFP = document.elementFromPoint;
    document.elementFromPoint = (() =>
      container.querySelector(".tab-bar")) as typeof document.elementFromPoint;
    pointer("pointerup", RIGHT_X, BODY_Y, window);
    document.elementFromPoint = savedEFP;
    await flush();

    expectSplitRight(a.key, b.key);
  });

  it("FAST drag: down→move→move→up in one frame (no effect flush) still splits", async () => {
    // The real-world regression: a quick flick fires pointerup BEFORE React has
    // a chance to attach CenterPanel's window listeners. The drop must still
    // commit (and not strand the drag). No `await flush()` until after the up.
    const { a, b, container } = await mountSeeded();
    const tabB = container.querySelector('.tab[data-tab-index="1"]') as HTMLElement;
    expect(tabB).toBeTruthy();

    pointer("pointerdown", 150, 14, tabB);
    pointer("pointermove", 160, 24, window); // start()
    pointer("pointermove", RIGHT_X, BODY_Y, window); // resolve → right edge
    pointer("pointerup", RIGHT_X, BODY_Y, window); // commit, before effects flush
    await flush();

    expectSplitRight(a.key, b.key);
  });

  it("within-bar reorder still commits (drag b left over the bar, drop before a)", async () => {
    // Guard the reverse: the fix commits the last resolved target, which over a
    // tab bar is a *reorder* target. Dragging b leftward over the bar to slot 0
    // must still reorder [a,b] → [b,a]. The release stays in the bar strip.
    const { a, b, container } = await mountSeeded();
    const tabB = container.querySelector('.tab[data-tab-index="1"]') as HTMLElement;
    expect(tabB).toBeTruthy();

    // Move within the bar (y < BAR_H) to a point left of tab a's midpoint (x<50)
    // so computeReorderIndex resolves slot 0.
    pointer("pointerdown", 150, 14, tabB);
    pointer("pointermove", 140, 14, window); // start()
    await flush();
    pointer("pointermove", 20, 14, window); // over bar, left half of tab a → slot 0
    pointer("pointerup", 20, 14, window);
    await flush();

    const layout = useTabsStore.getState().layout as GroupNode;
    expect(layout.type).toBe("group"); // no split — just a reorder
    expect(layout.tabKeys).toEqual([b.key, a.key]);
    expect(useDragStore.getState().drag).toBeNull();
  });

  it("WebKitGTK pointercancel ends the drag → still commits the split", async () => {
    // On WebKitGTK a mouse drag's release arrives as `pointercancel`, NOT
    // `pointerup` (the live build's actual failure: animation showed, but the
    // drop never committed because cancel was treated as an abort). A
    // pointercancel that is not an explicit Escape-abort must commit the drop.
    const { a, b, container } = await mountSeeded();
    const tabB = container.querySelector('.tab[data-tab-index="1"]') as HTMLElement;
    expect(tabB).toBeTruthy();

    pointer("pointerdown", 150, 14, tabB);
    pointer("pointermove", 160, 24, window); // start()
    await flush(); // attach CenterPanel listeners
    pointer("pointermove", RIGHT_X, BODY_Y, window); // resolve → right edge
    pointer("pointercancel", RIGHT_X, BODY_Y, window); // release arrives as cancel
    await flush();

    expectSplitRight(a.key, b.key);
  });

  it("Escape aborts: a following pointercancel does NOT commit a split", async () => {
    const { a, b, container } = await mountSeeded();
    const tabB = container.querySelector('.tab[data-tab-index="1"]') as HTMLElement;
    expect(tabB).toBeTruthy();

    pointer("pointerdown", 150, 14, tabB);
    pointer("pointermove", 160, 24, window); // start()
    await flush();
    pointer("pointermove", RIGHT_X, BODY_Y, window); // resolve → right edge
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    pointer("pointercancel", RIGHT_X, BODY_Y, window); // must NOT commit after abort
    await flush();

    const layout = useTabsStore.getState().layout as GroupNode;
    expect(layout.type).toBe("group"); // no split
    expect(layout.tabKeys.sort()).toEqual([a.key, b.key].sort());
    expect(useDragStore.getState().drag).toBeNull();
  });

  it("center drop merges into the target group (no split)", async () => {
    // A center-region drop resolves edge="center" → commitDrop calls moveTab, not
    // splitWithTab. With a single group [a,b] this is effectively a no-op merge
    // (b stays in g-1); assert it does NOT create a split and stays one group.
    const { a, b, container } = await mountSeeded();
    const tabB = container.querySelector('.tab[data-tab-index="1"]') as HTMLElement;
    expect(tabB).toBeTruthy();

    const centerX = BODY.left + BODY.width / 2;
    const centerY = BODY.top + BODY.height / 2;
    pointer("pointerdown", 150, 14, tabB);
    pointer("pointermove", 160, 24, window); // start()
    await flush();
    pointer("pointermove", centerX, centerY, window); // resolve → center
    expect(useDragStore.getState().drag?.edge).toBe("center");
    pointer("pointerup", centerX, centerY, window);
    await flush();

    const layout = useTabsStore.getState().layout as GroupNode;
    expect(layout.type).toBe("group");
    expect(layout.tabKeys.sort()).toEqual([a.key, b.key].sort());
    expect(useDragStore.getState().drag).toBeNull();
  });
});
