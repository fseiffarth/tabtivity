/**
 * The tab member chip (box redesign, plan step 10): inside a box each shell,
 * agent and Files tab says which member it works in, derived from `tab.cwd`.
 * Covers the pure derivation (kinds, member / whole box / no chip, legacy and
 * renamed labels), the chip's markup, the main strip, the popout strip fed by
 * the seed, the narrow-bar attribute and the hover card's "member" row.
 */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/api/window", () => ({
  cursorPosition: vi.fn(() => Promise.resolve({ x: 0, y: 0 })),
  getCurrentWindow: () => ({
    label: "popout",
    innerPosition: () => Promise.resolve({ x: 0, y: 0 }),
    outerPosition: () => Promise.resolve({ x: 0, y: 0 }),
    outerSize: () => Promise.resolve({ width: 800, height: 600 }),
    scaleFactor: () => Promise.resolve(1),
    onMoved: () => Promise.resolve(() => {}),
  }),
}));
vi.mock("../../components/tabs/TabPane", () => ({ TabPane: () => <div /> }));
vi.mock("../../components/header/WindowControls", () => ({ WindowControls: () => null }));

import type { ProjectBox, ProjectEntry } from "../../types";
import { useTabsStore, type GroupNode, type TabEntry } from "../../stores/tabs";
import { useBoxesStore } from "../../stores/boxes";
import { useProjectsStore } from "../../stores/projects";
import { useDragStore } from "../../stores/drag/drag";
import { TabBar } from "../../components/tabs/TabBar";
import { DetachedCenterPanel } from "../../components/layout/DetachedCenterPanel";
import { TabHoverCard } from "../../components/tabs/TabHoverCard";
import {
  NARROW_BAR_PX,
  TabMemberChip,
  labelNamesMember,
  memberTableOf,
  tabMemberInfo,
} from "../../components/tabs/TabMemberChip";
import { boxColor, memberColor } from "../../lib/theme/boxColor";

const proj = (id: string, name: string, dir: string): ProjectEntry =>
  ({ id, name, status: "active", position: 1, local_file: `${dir}/project.json`, directory: dir }) as ProjectEntry;
const projects = [proj("api", "api", "/w/api"), proj("paper", "paper", "/w/paper"), proj("lone", "lone", "/w/lone")];
const box: ProjectBox = { id: "b1", name: "thesis", member_ids: ["api", "paper"], position: 1, folder: "/boxes/thesis" };
const SCOPE = "box:b1";
const table = memberTableOf(SCOPE, [box], projects)!;

const tab = (over: Partial<TabEntry>): TabEntry =>
  ({ key: "t", label: "Claude", cmd: "claude", cwd: "/w/api", kind: "agent", scope: SCOPE, ...over }) as TabEntry;

afterEach(() => cleanup());

describe("tabMemberInfo", () => {
  it("names the member whose root holds the tab's cwd, deepest first", () => {
    expect(tabMemberInfo(tab({ cwd: "/w/api" }), table)).toMatchObject({ kind: "member", id: "api", name: "api", color: memberColor("api") });
    expect(tabMemberInfo(tab({ cwd: "/w/paper/src/deep" }), table)).toMatchObject({ kind: "member", id: "paper" });
  });

  it("shows the box mark for a tab in the box folder", () => {
    expect(tabMemberInfo(tab({ cwd: "/boxes/thesis" }), table)).toEqual({ kind: "box", name: "thesis", color: boxColor(box) });
    expect(tabMemberInfo(tab({ cwd: "/boxes/thesis/api-link" }), table)).toMatchObject({ kind: "box" });
  });

  it("gives a directory under neither a member nor the box folder no chip", () => {
    expect(tabMemberInfo(tab({ cwd: "/w/lone" }), table)).toBeNull();
    expect(tabMemberInfo(tab({ cwd: "/w/apix" }), table)).toBeNull();
  });

  it("takes every other cwd for the whole box while the box has no folder yet", () => {
    const fresh = memberTableOf("box:b2", [{ id: "b2", name: "new", member_ids: [], position: 2 }], projects)!;
    expect(tabMemberInfo(tab({ cwd: "/anywhere" }), fresh)).toMatchObject({ kind: "box", name: "new" });
  });

  it("covers shell, agent, local agent, Files and project-files tabs only", () => {
    for (const kind of ["shell", "agent", "local_agent", "files", "projectfiles"] as const) {
      expect(tabMemberInfo(tab({ kind }), table), kind).not.toBeNull();
    }
    for (const kind of ["embed", "monitor", "network", "diskusage", "browser", "calendar", "printing"] as const) {
      expect(tabMemberInfo(tab({ kind }), table), kind).toBeNull();
    }
  });

  it("is null outside a box, without a table or without a cwd", () => {
    expect(tabMemberInfo(tab({}), null)).toBeNull();
    expect(memberTableOf("api", [box], projects)).toBeNull();
    expect(tabMemberInfo(tab({ cwd: "" }), table)).toBeNull();
  });

  it("survives a rename: the label is not an input", () => {
    expect(tabMemberInfo(tab({ label: "my notes" }), table)).toMatchObject({ id: "api" });
  });
});

describe("labelNamesMember", () => {
  it("recognises the old ' — name' suffix in any case, as a whole word", () => {
    expect(labelNamesMember("Claude — api", "api")).toBe(true);
    expect(labelNamesMember("Shell — API", "api")).toBe(true);
    expect(labelNamesMember("Files — my.paper", "my.paper")).toBe(true);
    expect(labelNamesMember("api notes", "api")).toBe(true);
  });

  it("does not take a substring or a different name for the member", () => {
    expect(labelNamesMember("Claude", "api")).toBe(false);
    expect(labelNamesMember("rapid fixes", "api")).toBe(false);
    expect(labelNamesMember("Claude — paper", "api")).toBe(false);
    expect(labelNamesMember("anything", "")).toBe(false);
  });
});

describe("TabMemberChip", () => {
  it("renders a round dot and the name for a member", () => {
    const { container } = render(<TabMemberChip info={tabMemberInfo(tab({}), table)} label="Claude" />);
    const chip = container.querySelector(".tab-member-chip")!;
    expect(chip.classList.contains("box")).toBe(false);
    expect(chip.getAttribute("aria-label")).toBe("api");
    expect(chip.querySelector(".tab-member-name")?.textContent).toBe("api");
    expect((chip.querySelector(".tab-member-mark") as HTMLElement).style.background).not.toBe("");
  });

  it("renders the box mark (a square, by class) for the whole box", () => {
    const { container } = render(<TabMemberChip info={tabMemberInfo(tab({ cwd: "/boxes/thesis" }), table)} label="Claude" />);
    const chip = container.querySelector(".tab-member-chip")!;
    expect(chip.classList.contains("box")).toBe(true);
    expect(chip.getAttribute("aria-label")).toBe("Whole box — thesis");
    expect(chip.querySelector(".tab-member-name")?.textContent).toBe("thesis");
  });

  it("keeps only the dot when the label already names the member", () => {
    const { container } = render(<TabMemberChip info={tabMemberInfo(tab({}), table)} label="Claude — api" />);
    expect(container.querySelector(".tab-member-mark")).not.toBeNull();
    expect(container.querySelector(".tab-member-name")).toBeNull();
  });

  it("renders nothing without info", () => {
    const { container } = render(<TabMemberChip info={null} label="Claude" />);
    expect(container.querySelector(".tab-member-chip")).toBeNull();
  });
});

describe("main tab strip", () => {
  const keys = ["a", "b", "c", "d", "e"];
  beforeEach(() => {
    useDragStore.setState({ drag: null });
    useBoxesStore.setState({ boxes: [box] });
    useProjectsStore.setState({ projects });
    const tabs: TabEntry[] = [
      tab({ key: "a", label: "Claude", cwd: "/w/api" }),
      tab({ key: "b", label: "Shell — paper", kind: "shell", cmd: "bash", cwd: "/w/paper" }),
      tab({ key: "c", label: "renamed", cwd: "/boxes/thesis" }),
      tab({ key: "d", label: "doc.pdf", kind: "embed", cmd: "", cwd: "/w/api" }),
      tab({ key: "e", label: "Files", kind: "files", cmd: "", cwd: "/boxes/thesis" }),
    ];
    const layout: GroupNode = { type: "group", id: "g1", tabKeys: keys, activeKey: "a" };
    useTabsStore.setState({
      scope: SCOPE,
      tabsByScope: { [SCOPE]: tabs },
      tabs,
      layoutByScope: { [SCOPE]: layout },
      layout,
      focusedGroupByScope: { [SCOPE]: "g1" },
      focusedGroupId: "g1",
      activeKey: "a",
    });
  });

  it("puts a chip on shell, agent and Files tabs from their cwd, none on a viewer", async () => {
    const { container } = render(<TabBar groupId="g1" projectCwd="/boxes/thesis" showGroupClose={false} />);
    await act(async () => {});
    const chipOf = (i: number) => container.querySelector(`.tab[data-tab-index="${i}"] .tab-member-chip`);
    expect(chipOf(0)?.querySelector(".tab-member-name")?.textContent).toBe("api");
    // Legacy label "Shell — paper": dot only, the name is not printed twice.
    expect(chipOf(1)?.getAttribute("aria-label")).toBe("paper");
    expect(chipOf(1)?.querySelector(".tab-member-name")).toBeNull();
    // A renamed tab keeps its chip, with the text back.
    expect(chipOf(2)?.classList.contains("box")).toBe(true);
    expect(chipOf(2)?.querySelector(".tab-member-name")?.textContent).toBe("thesis");
    expect(chipOf(3)).toBeNull();
    expect(chipOf(4)?.classList.contains("box")).toBe(true);
  });

  it("shows no chip outside a box scope", async () => {
    const tabs = [tab({ key: "a", scope: "api", cwd: "/w/api" })];
    const layout: GroupNode = { type: "group", id: "g1", tabKeys: ["a"], activeKey: "a" };
    useTabsStore.setState({
      scope: "api",
      tabsByScope: { api: tabs },
      tabs,
      layoutByScope: { api: layout },
      layout,
      focusedGroupByScope: { api: "g1" },
      focusedGroupId: "g1",
      activeKey: "a",
    });
    const { container } = render(<TabBar groupId="g1" projectCwd="/w/api" showGroupClose={false} />);
    await act(async () => {});
    expect(container.querySelector(".tab-member-chip")).toBeNull();
  });

  it("flags a narrow bar so the CSS keeps the dot only, and clears it on unmount", async () => {
    const observers: (() => void)[] = [];
    class FakeRO {
      constructor(cb: () => void) {
        observers.push(cb);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", FakeRO);
    try {
      const { container, unmount } = render(<TabBar groupId="g1" projectCwd="/boxes/thesis" showGroupClose={false} />);
      await act(async () => {});
      const bar = container.querySelector(".tab-bar") as HTMLElement;
      let width = NARROW_BAR_PX - 1;
      bar.getBoundingClientRect = () => ({ width }) as DOMRect;
      await act(async () => {
        observers.forEach((cb) => cb());
      });
      expect(bar.hasAttribute("data-narrow-chips")).toBe(true);
      width = NARROW_BAR_PX + 200;
      await act(async () => {
        observers.forEach((cb) => cb());
      });
      expect(bar.hasAttribute("data-narrow-chips")).toBe(false);
      unmount();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("popout strip", () => {
  it("renders the chips from the seed's box and members, with the card's row from the same table", async () => {
    const tabs: TabEntry[] = [
      tab({ key: "a", label: "Claude", cwd: "/w/paper" }),
      tab({ key: "b", label: "Files", kind: "files", cmd: "", cwd: "/boxes/thesis" }),
    ];
    const tree: GroupNode = { type: "group", id: "g", tabKeys: ["a", "b"], activeKey: "a" };
    const { container } = render(
      <DetachedCenterPanel
        scope={SCOPE}
        popoutId="popout"
        tree={tree}
        tabs={tabs}
        remoteInfo={{ box, boxMembers: [projects[0], projects[1]] }}
        onSplit={vi.fn()} onMove={vi.fn()} onReorder={vi.fn()}
        onActivate={vi.fn()} onClose={vi.fn()} onSetLocation={vi.fn()}
        onResize={vi.fn()} onAddTab={vi.fn()} onFiles={vi.fn()}
      />,
    );
    const chips = [...container.querySelectorAll(".tab .tab-member-chip")];
    expect(chips.map((c) => c.getAttribute("data-member-kind"))).toEqual(["member", "box"]);
    expect(chips[0].querySelector(".tab-member-name")?.textContent).toBe("paper");
    // Hovering opens the card, which reads the seeded table too (no stores in a popout).
    useBoxesStore.setState({ boxes: [] });
    await act(async () => {
      fireEvent.mouseEnter(container.querySelector(".tab")!);
    });
    expect(document.querySelector(".tab-popup")?.textContent).toContain("paper");
  });
});

describe("hover card member row", () => {
  const row = () =>
    [...document.querySelectorAll(".tab-popup .pill-popup-path-row")].find((r) =>
      r.querySelector(".pill-popup-path-label")?.textContent?.startsWith("member"),
    );

  it("names the member from the stores", () => {
    useBoxesStore.setState({ boxes: [box] });
    useProjectsStore.setState({ projects });
    render(<TabHoverCard tab={tab({ cwd: "/w/api/src" })} scope={SCOPE} anchorX={0} anchorY={0} />);
    expect(row()?.querySelector(".tab-popup-meta")?.textContent).toBe("api");
  });

  it("says whole box for a tab in the box folder", () => {
    render(<TabHoverCard tab={tab({ cwd: "/boxes/thesis" })} scope={SCOPE} memberTable={table} anchorX={0} anchorY={0} />);
    expect(row()?.querySelector(".tab-popup-meta")?.textContent).toBe("Whole box — thesis");
    expect(row()?.querySelector(".tab-member-mark.box")).not.toBeNull();
  });

  it("has no row for a viewer, or outside a box", () => {
    render(<TabHoverCard tab={tab({ kind: "embed" })} scope={SCOPE} memberTable={table} anchorX={0} anchorY={0} />);
    expect(row()).toBeUndefined();
    cleanup();
    useBoxesStore.setState({ boxes: [] });
    render(<TabHoverCard tab={tab({})} scope="api" anchorX={0} anchorY={0} />);
    expect(row()).toBeUndefined();
  });
});
