/**
 * A project switch keeps the main window's `TabBar` (the layout tree isn't
 * keyed by scope), strip and all: the new project's active tab must still end
 * up in view, even when the last project's strip sat pinned at its far end.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue([]) }));

import { TabBar } from "../../components/tabs/TabBar";
import { allGroups, useTabsStore } from "../../stores/tabs";

const TAB_W = 100;
const VIEW = 300;

const tabsOf = (strip: Element) =>
  Array.from(strip.children).filter((el) => el.classList.contains("tab")) as HTMLElement[];

function rect(left: number, width: number): DOMRect {
  return { left, width, right: left + width, top: 0, bottom: 30, height: 30, x: left, y: 0, toJSON: () => ({}) };
}

/** Fixed-width tabs in a 300px strip whose scrollLeft clamps like a browser's. */
function fakeLayout(strip: HTMLElement) {
  const content = () => tabsOf(strip).length * TAB_W;
  let raw = 0;
  Object.defineProperty(strip, "scrollLeft", {
    configurable: true,
    get: () => Math.min(raw, Math.max(0, content() - VIEW)),
    set: (v: number) => { raw = Math.max(0, v); },
  });
  Object.defineProperty(strip, "scrollWidth", { configurable: true, get: content });
  Object.defineProperty(strip, "clientWidth", { configurable: true, get: () => VIEW });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this === strip) return rect(0, VIEW);
    const i = tabsOf(strip).indexOf(this as HTMLElement);
    return i >= 0 ? rect(i * TAB_W - strip.scrollLeft, TAB_W) : rect(0, 0);
  });
}

function seedScope(scope: string, count: number) {
  useTabsStore.setState({ scope, tabs: [], layout: null, focusedGroupId: null, activeKey: null });
  for (let i = 0; i < count; i++) {
    useTabsStore.getState().addTab({ label: `${scope}${i}`, cmd: "bash", cwd: `/${scope}`, kind: "shell" });
  }
  const s = useTabsStore.getState();
  return { tabs: s.tabs, layout: s.layout, group: allGroups(s.layout)[0] };
}

describe("TabBar across a project switch", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("brings the new project's active tab into view", async () => {
    useTabsStore.setState({ tabsByScope: {}, layoutByScope: {}, focusedGroupByScope: {} });
    const b = seedScope("b", 8);
    useTabsStore.getState().setGroupActive(b.group.id, b.tabs[1].key);
    const bLayout = useTabsStore.getState().layout;
    const a = seedScope("a", 8);

    const view = render(<TabBar groupId={a.group.id} projectCwd="/a" showGroupClose={false} />);
    const strip = view.container.querySelector<HTMLElement>(".tab-strip")!;
    fakeLayout(strip);
    // Project A's strip sits at its far end (its last tab is active).
    strip.scrollLeft = strip.scrollWidth;
    expect(strip.scrollLeft).toBe(8 * TAB_W - VIEW);

    await act(async () => {
      useTabsStore.setState({ scope: "b", tabs: b.tabs, layout: bLayout });
      view.rerender(<TabBar groupId={b.group.id} projectCwd="/b" showGroupClose={false} />);
    });

    const active = strip.querySelector<HTMLElement>(".tab.active")!;
    expect(tabsOf(strip).indexOf(active)).toBe(1);
    const r = active.getBoundingClientRect();
    expect(r.left).toBeGreaterThanOrEqual(0);
    expect(r.right).toBeLessThanOrEqual(VIEW);
  });
});
