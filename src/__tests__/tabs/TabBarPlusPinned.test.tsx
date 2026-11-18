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
import { useBoxesStore } from "../../stores/boxes";
import type { ProjectBox, ProjectEntry } from "../../types";

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

// The box "+" menu (box redesign step 11): "Start in…" on the Agents, Shell and
// Files rows instead of the old "Box members" group, and a first line naming
// where a plain pick starts. Outside a box nothing of it exists.
describe("the + menu in a box", () => {
  const member = (id: string): ProjectEntry => ({
    id,
    name: id,
    status: "active",
    position: 1,
    local_file: `/w/${id}/project.json`,
    directory: `/w/${id}`,
  });
  const box: ProjectBox = { id: "b1", name: "thesis", member_ids: ["api", "paper"], position: 1, folder: "/boxes/thesis" };

  beforeEach(() => {
    // jsdom has no layout; the menu scrolls the highlighted search hit into view.
    Element.prototype.scrollIntoView = vi.fn();
  });

  async function openBoxMenu(activeCwd: string | null): Promise<void> {
    useProjectsStore.setState({ projects: [member("api"), member("paper")], activeId: "api", loaded: true });
    useBoxesStore.setState({ boxes: [box] });
    useTabsStore.getState().setScope("box:b1");
    if (activeCwd) {
      useTabsStore.getState().addTab({ label: "first", cmd: "", args: [], env: {}, cwd: activeCwd, kind: "shell" });
    }
    const groupId = useTabsStore.getState().focusedGroupId!;
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<TabBar groupId={groupId} projectCwd="/boxes/thesis" showGroupClose={false} />));
    });
    await act(async () => {
      fireEvent.click(container.querySelector(".tab-new-btn")!);
    });
  }
  /** A row's own label: the text after its dot (the untested pill is a later sibling). */
  const labelOf = (el: Element) => el.querySelector(".tab-new-menu-dot")?.nextSibling?.textContent ?? "";
  const labels = () => [...document.querySelectorAll(".tab-new-menu-item")].map(labelOf);
  const rowOf = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>(".tab-new-menu-item")].find(
      (el) => el.querySelector(".tab-new-menu-dot")?.nextSibling?.textContent === label,
    )!;
  /** Open the ▾ beside the row called `label`. */
  const openFlyout = async (label: string) => {
    const caret = rowOf(label).parentElement!.querySelector<HTMLButtonElement>(".tab-new-menu-split-caret")!;
    await act(async () => {
      fireEvent.click(caret);
    });
  };
  const newest = () => useTabsStore.getState().tabs[useTabsStore.getState().tabs.length - 1];

  it("names the member of the active tab in its first line, and drops the Box members group", async () => {
    await openBoxMenu("/w/api");
    expect(document.querySelector(".tab-new-menu-target")?.textContent).toContain("New tab in api");
    expect(document.querySelector(".tab-new-menu-target .tab-member-mark.box")).toBeNull();
    expect(document.body.textContent).not.toContain("Box members");
    expect(labels().some((l) => l.includes("Files — api") || l.includes("Shell — api"))).toBe(false);
  });

  it("names the whole box after a tab in the box folder, or with no tab at all", async () => {
    await openBoxMenu("/boxes/thesis");
    expect(document.querySelector(".tab-new-menu-target")?.textContent).toContain("New tab in thesis (whole box)");
    expect(document.querySelector(".tab-new-menu-target .tab-member-mark.box")).not.toBeNull();
    cleanup();
    useTabsStore.setState({ tabsByScope: {}, layoutByScope: {}, focusedGroupByScope: {}, tabs: [], layout: null });
    await openBoxMenu(null);
    expect(document.querySelector(".tab-new-menu-target")?.textContent).toContain("(whole box)");
  });

  it("opens Start in… on Agents, Shell and Files: the whole box, then every member", async () => {
    await openBoxMenu("/w/api");
    for (const row of ["Claude", "Shell", "Files"]) {
      expect(rowOf(row).parentElement?.classList.contains("tab-new-menu-split"), row).toBe(true);
    }
    await openFlyout("Claude");
    const flyout = [...document.querySelectorAll(".tab-new-menu-more .tab-new-menu-item")].map(labelOf);
    expect(flyout).toEqual(["Claude in the whole box", "Claude in api", "Claude in paper"]);
    expect(document.querySelector(".tab-new-menu-more .tab-new-menu-group-label")?.textContent).toBe("Start Claude in…");
  });

  it("starts an agent in another member under the plain label, with no name suffix", async () => {
    await openBoxMenu("/w/api");
    await openFlyout("Claude");
    const entry = [...document.querySelectorAll<HTMLButtonElement>(".tab-new-menu-more .tab-new-menu-item")].find((el) =>
      labelOf(el) === "Claude in paper",
    )!;
    await act(async () => {
      fireEvent.click(entry);
    });
    expect(newest()).toMatchObject({ kind: "agent", cmd: "claude", cwd: "/w/paper", label: "Claude" });
  });

  it("starts a shell in the whole box, and a plain Shell click follows the member", async () => {
    await openBoxMenu("/w/api");
    await act(async () => {
      fireEvent.click(rowOf("Shell"));
    });
    expect(newest()).toMatchObject({ kind: "shell", cwd: "/w/api", label: "Shell" });
    await act(async () => {
      fireEvent.click(document.querySelector(".tab-new-btn")!);
    });
    await openFlyout("Shell");
    const entry = [...document.querySelectorAll<HTMLButtonElement>(".tab-new-menu-more .tab-new-menu-item")].find((el) =>
      labelOf(el) === "Shell in the whole box",
    )!;
    await act(async () => {
      fireEvent.click(entry);
    });
    expect(newest()).toMatchObject({ kind: "shell", cwd: "/boxes/thesis", label: "Shell" });
  });

  it("maps Files: a member's is the project-files tab, the whole box's the plain one", async () => {
    await openBoxMenu("/w/api");
    await act(async () => {
      fireEvent.click(rowOf("Files"));
    });
    expect(newest()).toMatchObject({ kind: "projectfiles", cwd: "/w/api", label: "Files" });
    await act(async () => {
      fireEvent.click(document.querySelector(".tab-new-btn")!);
    });
    await openFlyout("Files");
    const entry = [...document.querySelectorAll<HTMLButtonElement>(".tab-new-menu-more .tab-new-menu-item")].find((el) =>
      labelOf(el) === "Files in the whole box",
    )!;
    await act(async () => {
      fireEvent.click(entry);
    });
    expect(newest()).toMatchObject({ kind: "files", cwd: "/boxes/thesis", label: "Files" });
  });

  it("finds a member by name in the search box, under its full label", async () => {
    await openBoxMenu("/w/api");
    const search = document.querySelector<HTMLInputElement>(".tab-new-menu-search")!;
    await act(async () => {
      fireEvent.change(search, { target: { value: "claude in paper" } });
    });
    expect(labels().filter((l) => l.includes(" in "))).toEqual(["Claude in paper"]);
    await act(async () => {
      fireEvent.change(search, { target: { value: "paper" } });
    });
    expect(labels().filter((l) => l.includes(" in paper"))).toEqual([
      "Claude in paper",
      "Shell in paper",
      "Files in paper",
    ]);
    await act(async () => {
      fireEvent.keyDown(search, { key: "Enter" });
    });
    expect(newest()).toMatchObject({ kind: "agent", cwd: "/w/paper" });
  });

  it("has no first line and no Start in… outside a box", async () => {
    const container = await renderBar(1);
    await act(async () => {
      fireEvent.click(container.querySelector(".tab-new-btn")!);
    });
    expect(document.querySelector(".tab-new-menu-target")).toBeNull();
    expect(document.querySelector(".tab-new-menu-split")).toBeNull();
  });
});
