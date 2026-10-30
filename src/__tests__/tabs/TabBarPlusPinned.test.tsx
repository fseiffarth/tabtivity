/**
 * The subwindow "+" is pinned, not scrolled away.
 *
 * The new-tab button used to be the last child of `.tab-strip` — the
 * horizontally scrolling container holding the tabs — so a subwindow too narrow
 * for its tabs scrolled the one control that adds a tab out of view. It now
 * lives beside the strip, with the drag grip, the chevrons and the ◫/–/×
 * cluster, all of which sit outside the strip for the same reason.
 *
 * This is a structural test on purpose: jsdom lays nothing out, so "does it
 * overflow" is unobservable here. What IS observable — and what the regression
 * would consist of — is the + being a descendant of the scrolling strip again.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup, fireEvent } from "@testing-library/react";
// @ts-expect-error node:fs has no type declarations in this project (no @types/node)
import { readFileSync } from "node:fs";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
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
  cursorPosition: () => Promise.resolve({ x: 0, y: 0 }),
}));

import { TabBar } from "../../components/tabs/TabBar";
import { useTabsStore } from "../../stores/tabs";
import { useProjectsStore } from "../../stores/projects";

beforeEach(() => {
  vi.clearAllMocks();
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "list_agents") {
      return Promise.resolve([{ id: "claude", bin: "claude", installed: true }]);
    }
    if (cmd === "list_dir") return Promise.resolve([]);
    return Promise.resolve(null);
  });
  useProjectsStore.setState({ projects: [], activeId: null, loaded: true });
  useTabsStore.setState({
    scope: "root",
    tabsByScope: {},
    layoutByScope: {},
    focusedGroupByScope: {},
    tabs: [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
  });
});
afterEach(() => cleanup());

async function renderBar(tabCount: number): Promise<HTMLElement> {
  useTabsStore.getState().setScope("root");
  for (let i = 0; i < tabCount; i++) {
    useTabsStore.getState().addTab({
      label: `t${i}`,
      cmd: "bash",
      args: [],
      env: {},
      cwd: "/tmp",
      kind: "shell",
    });
  }
  const groupId = useTabsStore.getState().focusedGroupId!;
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(
      <TabBar groupId={groupId} projectCwd="/tmp" showGroupClose={false} />,
    ));
  });
  return container;
}

describe("the + menu's agent list", () => {
  it("is read again on each opening: an install in a terminal tab sends no event", async () => {
    const container = await renderBar(1);
    const reads = () => mockInvoke.mock.calls.filter(([cmd]) => cmd === "list_agents").length;
    const before = reads();
    await act(async () => {
      fireEvent.click(container.querySelector(".tab-new-btn")!);
    });
    expect(reads()).toBe(before + 1);
  });
});

describe("the subwindow + is outside the scrolling tab strip", () => {
  it("renders the + as a direct child of the bar, never inside the strip", async () => {
    const container = await renderBar(6);
    expect(container.querySelector(".tab-new-btn")).not.toBeNull();
    // The regression: the + back inside the strip, scrolling away with the tabs.
    expect(container.querySelector(".tab-strip .tab-new-btn")).toBeNull();
    expect(container.querySelector(".tab-bar > .tab-new-wrap")).not.toBeNull();
  });

  it("keeps the + on the pane side of the ◫/–/× cluster", async () => {
    const container = await renderBar(3);
    const bar = container.querySelector(".tab-bar")!;
    const kids = [...bar.children];
    const plus = kids.findIndex((el) => el.classList.contains("tab-new-wrap"));
    const controls = kids.findIndex((el) => el.classList.contains("tab-controls"));
    expect(plus).toBeGreaterThanOrEqual(0);
    expect(controls).toBeGreaterThanOrEqual(0);
    expect(plus).toBeLessThan(controls);
  });

  it("still shows the + (pulsing) for a group with no tabs", async () => {
    const container = await renderBar(0);
    const plus = container.querySelector(".tab-new-btn");
    expect(plus).not.toBeNull();
    expect(plus!.classList.contains("empty-hint")).toBe(true);
    expect(container.querySelector(".tab-strip .tab-new-btn")).toBeNull();
  });

  it("keeps the popout's own + outside its strip too", () => {
    // `DetachedCenterPanel` hand-rolls the same bar (separate React root,
    // separate store), so it has its own copy of the + and its own way to put it
    // back inside the strip: passing it as a child of `<ScrollingTabStrip>`,
    // which is what wraps its children in `.tab-strip`. Rendering that panel
    // needs a whole popout's worth of state, so the drift is caught at the
    // source instead.
    const src: string = readFileSync(
      "src/components/layout/DetachedCenterPanel.tsx",
      "utf8",
    );
    const open = src.indexOf("<ScrollingTabStrip");
    const close = src.indexOf("</ScrollingTabStrip>");
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    expect(src.slice(open, close)).not.toContain("tab-new-wrap");
    expect(src).toContain("tab-new-wrap");
  });
});
