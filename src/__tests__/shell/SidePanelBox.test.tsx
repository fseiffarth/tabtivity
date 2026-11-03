/**
 * When the current tab scope is a box scope (`box:<id>`), the side panel shows
 * a multi-root file view: one collapsible section (`.file-root`) for the box
 * folder plus one per member project root (#41 Phase 3).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, fireEvent, cleanup } from "@testing-library/react";
import { storageKey } from "../../lib/brand";
import { SPRING_LOAD_MS } from "../../components/files/fileTreeDrag";
import type { ProjectBox, ProjectEntry } from "../../types";

const { mockInvoke } = vi.hoisted(() => ({
  // Listing commands resolve to []; git_repo_root returns a path string or null,
  // so the blanket [] would leak a non-string into ProjectFilesView's norm().
  // `set_box_members` answers with the box it just wrote, as the real command
  // does — the store puts the reply straight back into `boxes`.
  mockInvoke: vi.fn((cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "git_repo_root") return Promise.resolve(null);
    if (cmd === "set_box_members") {
      return Promise.resolve({
        id: args?.boxId,
        name: args?.boxId,
        member_ids: args?.memberIds,
        position: 10,
        folder: `/b/${args?.boxId}`,
      });
    }
    return Promise.resolve([]);
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import { SidePanel } from "../../components/layout/SidePanel";
import { useProjectsStore } from "../../stores/projects";
import { useBoxesStore } from "../../stores/boxes";
import { useTabsStore } from "../../stores/tabs";
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import { useFileSourcePrefStore } from "../../stores/remote/fileSourcePref";
import { useBoxAccordionStore, resetBoxAccordion } from "../../stores/boxAccordion";
import { useGitDirtyStore } from "../../stores/gitDirty";
import { useDragStore } from "../../stores/drag/drag";
import type { TabEntry } from "../../stores/tabs";

function proj(id: string, _boxId?: string): ProjectEntry {
  // Membership is member_ids-only now; the second arg is kept so call sites read
  // as "member of that box" without carrying a stale box_id field.
  return {
    id,
    name: id,
    status: "active",
    position: 10,
    local_file: `/p/${id}/project.json`,
  };
}

function box(id: string, members: string[]): ProjectBox {
  return { id, name: id, member_ids: members, position: 10, folder: `/b/${id}` };
}

beforeEach(() => {
  mockInvoke.mockClear();
  useProjectsStore.setState({ projects: [], activeId: null, loaded: true });
  useBoxesStore.setState({ boxes: [], loaded: true });
  useTabsStore.setState({ scope: "root" });
  useRemoteStatusStore.setState({ byProject: {}, byHost: {} });
  useFileSourcePrefStore.setState({ byProject: {}, byViewer: {} });
  resetBoxAccordion();
  useGitDirtyStore.setState({ byId: {} });
  useTabsStore.setState({ tabs: [], activeKey: null });
});

describe("SidePanel multi-root box view", () => {
  it("renders a file-root section for the box folder + each member root", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", ["p1", "p2"])] });
    useProjectsStore.setState({
      projects: [proj("p1", "boxA"), proj("p2", "boxA")],
      activeId: null,
      loaded: true,
    });
    useTabsStore.setState({ scope: "box:boxA" });

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<SidePanel open={true} />));
    });

    const headers = [...container.querySelectorAll(".file-root-header .file-root-name")].map(
      (el) => el.textContent,
    );
    // Box folder root + the two member roots.
    expect(headers).toEqual(["boxA", "p1", "p2"]);
  });

  it("gates a disconnected remote member's REMOTE side behind a connect prompt", async () => {
    // p2 is a remote (SSH) member whose pool is down and whose chosen side is
    // Remote: its section must show the connect prompt instead of mounting the
    // SFTP-backed tree (whose synchronous probes would freeze a real window) —
    // but the Remote/Local switch must STAY up, so the mirror remains one click
    // away while offline. p1 stays a local member with a tree.
    useBoxesStore.setState({ boxes: [box("boxA", ["p1", "p2"])] });
    const remoteMember = {
      ...proj("p2", "boxA"),
      remote: { host: "h", user: "u", remote_path: "/srv/p2" },
    } as ProjectEntry;
    useProjectsStore.setState({
      projects: [proj("p1", "boxA"), remoteMember],
      activeId: null,
      loaded: true,
    });
    useRemoteStatusStore.setState({ byProject: { p2: { ssh: "off", vpn: "off" } } });
    useFileSourcePrefStore.setState({ byProject: { p2: "remote" }, byViewer: {} });
    useTabsStore.setState({ scope: "box:boxA" });
    // One member is expanded at a time: the remote one, so its prompt shows.
    useBoxAccordionStore.getState().setOpen("boxA", "p2");

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<SidePanel open={true} />));
    });

    const sections = [...container.querySelectorAll(".file-root")];
    expect(sections).toHaveLength(3);
    // The remote member's section carries the prompt, not a tree body.
    const p2Section = sections.find((el) =>
      el.querySelector(".file-root-name")?.textContent?.includes("p2"),
    )!;
    expect(p2Section.querySelector(".file-root-body")).toBeNull();
    expect(p2Section.textContent).toContain("Disconnected");
    expect(p2Section.querySelector(".dialog-connect-btn")).not.toBeNull();
    // The escape hatch out of the prompt: the member's own source switch.
    expect(p2Section.querySelector(".side-panel-source-switch")).not.toBeNull();
    // The local member keeps its ordinary tree body (and, not being remote,
    // gets no source switch).
    const p1Section = sections.find((el) =>
      el.querySelector(".file-root-name")?.textContent?.includes("p1"),
    )!;
    expect(p1Section.querySelector(".file-root-body")).toBeNull();
    expect(p1Section.classList.contains("is-collapsed")).toBe(true);
    // Opening p1 shows its ordinary tree (no switch, no prompt) and folds p2.
    await act(async () => {
      fireEvent.click(p1Section.querySelector(".file-root-header")!);
    });
    expect(p1Section.querySelector(".file-root-body")).not.toBeNull();
    expect(p1Section.querySelector(".dialog-connect-btn")).toBeNull();
    expect(p1Section.querySelector(".side-panel-source-switch")).toBeNull();
    expect(p2Section.querySelector(".dialog-connect-btn")).toBeNull();
  });

  it("shows a disconnected remote member's LOCAL mirror by default", async () => {
    // With no stored side, a disconnected member auto-latches Local (same rule
    // as the single-project view) and browses the offline mirror — the box view
    // used to have no switch at all, stranding remote members on a dead
    // Connect prompt.
    useBoxesStore.setState({ boxes: [box("boxA", ["p2"])] });
    const remoteMember = {
      ...proj("p2", "boxA"),
      remote: { host: "h", user: "u", remote_path: "/srv/p2" },
    } as ProjectEntry;
    useProjectsStore.setState({ projects: [remoteMember], activeId: null, loaded: true });
    useRemoteStatusStore.setState({ byProject: { p2: { ssh: "off", vpn: "off" } } });
    useTabsStore.setState({ scope: "box:boxA" });

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<SidePanel open={true} />));
    });

    const p2Section = [...container.querySelectorAll(".file-root")].find((el) =>
      el.querySelector(".file-root-name")?.textContent?.includes("p2"),
    )!;
    expect(p2Section.querySelector(".file-root-body")).not.toBeNull();
    expect(p2Section.querySelector(".dialog-connect-btn")).toBeNull();
    expect(p2Section.querySelector(".side-panel-source-switch")).not.toBeNull();
  });

  it("mounts a connected remote member's tree", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", ["p2"])] });
    const remoteMember = {
      ...proj("p2", "boxA"),
      remote: { host: "h", user: "u", remote_path: "/srv/p2" },
    } as ProjectEntry;
    useProjectsStore.setState({ projects: [remoteMember], activeId: null, loaded: true });
    useRemoteStatusStore.setState({ byProject: { p2: { ssh: "connected", vpn: "off" } } });
    useTabsStore.setState({ scope: "box:boxA" });

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<SidePanel open={true} />));
    });

    const p2Section = [...container.querySelectorAll(".file-root")].find((el) =>
      el.querySelector(".file-root-name")?.textContent?.includes("p2"),
    )!;
    expect(p2Section.querySelector(".file-root-body")).not.toBeNull();
    expect(p2Section.querySelector(".dialog-connect-btn")).toBeNull();
  });

  it("falls back to the single project tree when no box scope is active", async () => {
    useProjectsStore.setState({
      projects: [proj("p1")],
      activeId: "p1",
      loaded: true,
    });
    useTabsStore.setState({ scope: "p1" });

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<SidePanel open={true} />));
    });

    expect(container.querySelector(".file-root")).toBeNull();
  });
});

/**
 * Member roots reorder by dragging their grips — the box's member order is the
 * order this panel (and the box's agent-doc link block) lists them in, and it
 * had no gesture at all before.
 */
describe("box member reorder", () => {
  /** Give each member's header band a real rect: jsdom measures everything as
   *  zero, and the drop slot is decided by which header midpoints the cursor
   *  has passed. */
  function layOutHeaders(container: HTMLElement, tops: number[]) {
    const rows = [...container.querySelectorAll(".file-root--member .file-root-headrow")];
    rows.forEach((row, i) => {
      (row as HTMLElement).getBoundingClientRect = () =>
        ({ top: tops[i], height: 20, bottom: tops[i] + 20, left: 0, right: 0, width: 100, x: 0, y: tops[i], toJSON: () => ({}) }) as DOMRect;
    });
    return rows;
  }

  function grips(container: HTMLElement) {
    return [...container.querySelectorAll(".file-root-grip")] as HTMLElement[];
  }

  beforeEach(() => {
    // jsdom implements neither side of a pointer capture; the gesture only
    // needs the events to keep arriving at the grip, which they do here.
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
    useBoxesStore.setState({ boxes: [box("boxA", ["p1", "p2", "p3"])] });
    useProjectsStore.setState({
      projects: [proj("p1"), proj("p2"), proj("p3")],
      activeId: null,
      loaded: true,
    });
    useTabsStore.setState({ scope: "box:boxA" });
  });

  async function renderBox() {
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<SidePanel open={true} />));
    });
    return container;
  }

  it("gives every member root a grip, and the box folder root none", async () => {
    const container = await renderBox();
    expect(container.querySelectorAll(".file-root").length).toBe(4);
    expect(grips(container)).toHaveLength(3);
    expect(
      container.querySelector(".file-root--box")?.querySelector(".file-root-grip"),
    ).toBeNull();
  });

  it("commits a drag past the last member as a new member order", async () => {
    const container = await renderBox();
    layOutHeaders(container, [0, 100, 200]);
    const [p1Grip] = grips(container);

    await act(async () => {
      fireEvent.pointerDown(p1Grip, { button: 0, clientY: 5, pointerId: 1 });
      fireEvent.pointerMove(p1Grip, { clientY: 230, pointerId: 1 });
      fireEvent.pointerUp(p1Grip, { clientY: 230, pointerId: 1 });
    });

    expect(mockInvoke).toHaveBeenCalledWith("set_box_members", {
      boxId: "boxA",
      memberIds: ["p2", "p3", "p1"],
    });
  });

  it("cancelling the drag writes nothing", async () => {
    const container = await renderBox();
    layOutHeaders(container, [0, 100, 200]);
    const [p1Grip] = grips(container);

    await act(async () => {
      fireEvent.pointerDown(p1Grip, { button: 0, clientY: 5, pointerId: 1 });
      fireEvent.pointerMove(p1Grip, { clientY: 230, pointerId: 1 });
      fireEvent.pointerCancel(p1Grip, { clientY: 230, pointerId: 1 });
    });

    expect(mockInvoke).not.toHaveBeenCalledWith("set_box_members", expect.anything());
  });

  it("nudges a member with the keyboard, so the reorder is not pointer-only", async () => {
    const container = await renderBox();
    const [, p2Grip] = grips(container);

    await act(async () => {
      fireEvent.keyDown(p2Grip, { key: "ArrowUp" });
    });

    expect(mockInvoke).toHaveBeenCalledWith("set_box_members", {
      boxId: "boxA",
      memberIds: ["p2", "p1", "p3"],
    });
  });

  it("leaves member ids the view shows no root for where they are", async () => {
    // `ghost` is a member with no project behind it: it renders nothing, so a
    // drag never addresses it — and must not drop or reshuffle it either.
    useBoxesStore.setState({ boxes: [box("boxA", ["p1", "ghost", "p2", "p3"])] });
    const container = await renderBox();
    layOutHeaders(container, [0, 100, 200]);
    const [p1Grip] = grips(container);

    await act(async () => {
      fireEvent.pointerDown(p1Grip, { button: 0, clientY: 5, pointerId: 1 });
      fireEvent.pointerUp(p1Grip, { clientY: 230, pointerId: 1 });
    });

    // The three visible ids are rewritten into their new order; "ghost" keeps
    // the slot it held.
    expect(mockInvoke).toHaveBeenCalledWith("set_box_members", {
      boxId: "boxA",
      memberIds: ["p2", "ghost", "p3", "p1"],
    });
  });
});

/**
 * The accordion: one member section expanded at a time, one-line headers with
 * the member's facts, the choice remembered per box.
 */
describe("box side panel accordion", () => {
  function agentTab(key: string, cwd: string, kind: "agent" | "shell" = "agent"): TabEntry {
    return { key, kind, label: key, cwd } as unknown as TabEntry;
  }

  beforeEach(() => {
    useBoxesStore.setState({ boxes: [box("boxA", ["p1", "p2", "p3"])] });
    useProjectsStore.setState({
      projects: [proj("p1"), proj("p2"), proj("p3")],
      activeId: null,
      loaded: true,
    });
    useTabsStore.setState({ scope: "box:boxA" });
  });

  async function renderBox() {
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<SidePanel open={true} />));
    });
    return container;
  }

  function section(container: HTMLElement, name: string): HTMLElement {
    return [...container.querySelectorAll<HTMLElement>(".file-root")].find(
      (el) => el.querySelector(".file-root-name")?.textContent === name,
    )!;
  }

  function open(container: HTMLElement): string[] {
    return [...container.querySelectorAll(".file-root--member:not(.is-collapsed) .file-root-name")].map(
      (el) => el.textContent ?? "",
    );
  }

  it("opens the first member when nothing says otherwise, and folds the rest", async () => {
    const container = await renderBox();
    expect(open(container)).toEqual(["p1"]);
    expect(section(container, "p2").querySelector(".file-root-body")).toBeNull();
    // The box folder's own section is independent and open.
    expect(section(container, "boxA").classList.contains("is-collapsed")).toBe(false);
  });

  it("opens the active tab's member", async () => {
    useTabsStore.setState({ tabs: [agentTab("t1", "/p/p3/src", "shell")], activeKey: "t1" });
    useProjectsStore.setState({
      projects: ["p1", "p2", "p3"].map((id) => ({ ...proj(id), directory: `/p/${id}` }) as ProjectEntry),
    });
    const container = await renderBox();
    expect(open(container)).toEqual(["p3"]);
  });

  it("follows the active tab to another member, but not on mount", async () => {
    useProjectsStore.setState({
      projects: ["p1", "p2", "p3"].map((id) => ({ ...proj(id), directory: `/p/${id}` }) as ProjectEntry),
    });
    useBoxAccordionStore.getState().setOpen("boxA", "p1");
    useTabsStore.setState({ tabs: [agentTab("t1", "/p/p2", "shell")], activeKey: "t1" });
    const container = await renderBox();
    // The remembered click wins at mount ...
    expect(open(container)).toEqual(["p1"]);
    // ... and the active tab moving to another member opens that one.
    await act(async () => {
      useTabsStore.setState({
        tabs: [agentTab("t1", "/p/p2", "shell"), agentTab("t2", "/p/p3", "shell")],
        activeKey: "t2",
      });
    });
    expect(open(container)).toEqual(["p3"]);
  });

  it("keeps the remembered choice when the scope's tabs only load after the mount", async () => {
    // A first visit to a box scope: `setScope` runs first and the tabs are
    // hydrated from disk a moment later, so the pane mounts with no tab at all.
    // The tabs arriving is not "the active tab moved to another member".
    useProjectsStore.setState({
      projects: ["p1", "p2", "p3"].map((id) => ({ ...proj(id), directory: `/p/${id}` }) as ProjectEntry),
    });
    useBoxAccordionStore.getState().setOpen("boxA", "p1");
    const container = await renderBox();
    expect(open(container)).toEqual(["p1"]);
    await act(async () => {
      useTabsStore.setState({ tabs: [agentTab("t1", "/p/p2", "shell")], activeKey: "t1" });
    });
    expect(open(container)).toEqual(["p1"]);
    expect(useBoxAccordionStore.getState().byBox.boxA?.open).toBe("p1");
    // Once a tab is active, moving to another member's tab still follows it.
    await act(async () => {
      useTabsStore.setState({
        tabs: [agentTab("t1", "/p/p2", "shell"), agentTab("t2", "/p/p3", "shell")],
        activeKey: "t2",
      });
    });
    expect(open(container)).toEqual(["p3"]);
  });

  it("a click opens that member and folds the one before; a second click folds all", async () => {
    const container = await renderBox();
    await act(async () => {
      fireEvent.click(section(container, "p2").querySelector(".file-root-header")!);
    });
    expect(open(container)).toEqual(["p2"]);
    expect(useBoxAccordionStore.getState().byBox.boxA?.open).toBe("p2");
    await act(async () => {
      fireEvent.click(section(container, "p2").querySelector(".file-root-header")!);
    });
    expect(open(container)).toEqual([]);
    expect(useBoxAccordionStore.getState().byBox.boxA?.open).toBeNull();
  });

  it("remembers the choice across a remount and writes it to localStorage", async () => {
    const first = await renderBox();
    await act(async () => {
      fireEvent.click(section(first, "p3").querySelector(".file-root-header")!);
    });
    const stored = JSON.parse(localStorage.getItem(`${storageKey("boxAccordion")}`) ?? "{}");
    expect(stored.boxA.open).toBe("p3");
    cleanup();
    // A fresh store read (as after a relaunch) sees the stored row.
    useBoxAccordionStore.setState({ byBox: {} });
    useBoxAccordionStore.setState({
      byBox: JSON.parse(localStorage.getItem(storageKey("boxAccordion")) ?? "{}"),
    });
    const second = await renderBox();
    expect(open(second)).toEqual(["p3"]);
  });

  it("renders without localStorage", async () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    try {
      const container = await renderBox();
      await act(async () => {
        fireEvent.click(section(container, "p2").querySelector(".file-root-header")!);
      });
      expect(open(container)).toEqual(["p2"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("shows the colour dot, the git dot and the agent count in the header", async () => {
    useProjectsStore.setState({
      projects: ["p1", "p2", "p3"].map((id) => ({ ...proj(id), directory: `/p/${id}` }) as ProjectEntry),
    });
    useGitDirtyStore.setState({ byId: { p1: "dirty", p2: "clean" } });
    useTabsStore.setState({
      tabs: [agentTab("a", "/p/p2/x"), agentTab("b", "/p/p2"), agentTab("c", "/p/p1", "shell")],
      activeKey: null,
    });
    const container = await renderBox();
    const p1 = section(container, "p1");
    const p2 = section(container, "p2");
    const p3 = section(container, "p3");
    expect(p1.querySelector(".file-root-dot")).not.toBeNull();
    expect(p1.querySelector(".file-root-dirty.git-dirty")).not.toBeNull();
    // Clean and unprobed are omitted, never drawn as zero.
    expect(p2.querySelector(".file-root-dirty")).toBeNull();
    expect(p3.querySelector(".file-root-dirty")).toBeNull();
    expect(p2.querySelector(".file-root-agents")?.textContent).toBe("✦2");
    // A shell tab is not an agent; no agents, no count.
    expect(p1.querySelector(".file-root-agents")).toBeNull();
  });

  it("omits the git dot for a remote member and never probes it", async () => {
    const remoteMember = {
      ...proj("p2"),
      remote: { host: "h", user: "u", remote_path: "/srv/p2" },
    } as ProjectEntry;
    useProjectsStore.setState({ projects: [proj("p1"), remoteMember, proj("p3")] });
    useGitDirtyStore.setState({ byId: { p2: "dirty" } });
    const container = await renderBox();
    expect(section(container, "p2").querySelector(".file-root-dirty")).toBeNull();
    expect(mockInvoke).not.toHaveBeenCalledWith("git_dirty_probe", expect.objectContaining({ projectDir: expect.stringContaining("srv") }));
  });

  it("the rail takes the member colour", async () => {
    const container = await renderBox();
    expect(section(container, "p1").style.getPropertyValue("--file-root-accent")).toMatch(/^hsl\(/);
  });

  describe("a collapsed section still takes a drop", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });
    afterEach(() => {
      vi.useRealTimers();
      useDragStore.setState({ drag: null });
      // @ts-expect-error restore jsdom's missing implementation
      delete document.elementFromPoint;
    });

    it("carries the move-target attributes of its root", async () => {
      const container = await renderBox();
      const head = section(container, "p2").querySelector<HTMLElement>(".file-root-headrow")!;
      expect(head.getAttribute("data-move-rel")).toBe("");
      expect(head.getAttribute("data-move-root")).toBeTruthy();
      // The open section's header is not a target: its tree is.
      const open1 = section(container, "p1").querySelector<HTMLElement>(".file-root-headrow")!;
      expect(open1.getAttribute("data-move-rel")).toBeNull();
    });

    it("opens after the dwell, keeps the source section mounted, and settles on release", async () => {
      const container = await renderBox();
      const head = section(container, "p2").querySelector<HTMLElement>(".file-root-headrow")!;
      document.elementFromPoint = () => head;
      await act(async () => {
        useDragStore.getState().startFileDrag({
          label: "a.txt",
          pointerX: 5,
          pointerY: 5,
          filePath: "/p/p1/a.txt",
          fileName: "a.txt",
        });
        useDragStore.getState().move(6, 6);
      });
      expect(section(container, "p2").classList.contains("is-spring-armed")).toBe(true);
      await act(async () => {
        vi.advanceTimersByTime(SPRING_LOAD_MS - 1);
      });
      expect(section(container, "p2").classList.contains("is-collapsed")).toBe(true);
      await act(async () => {
        vi.advanceTimersByTime(2);
      });
      // Both open while the drag runs: the section the file came from stays mounted.
      expect(open(container)).toEqual(["p1", "p2"]);
      await act(async () => {
        useDragStore.getState().end();
      });
      expect(open(container)).toEqual(["p2"]);
      expect(useBoxAccordionStore.getState().byBox.boxA?.open).toBe("p2");
    });

    it("a sweep that never dwells opens nothing", async () => {
      const container = await renderBox();
      const head = section(container, "p2").querySelector<HTMLElement>(".file-root-headrow")!;
      document.elementFromPoint = () => head;
      await act(async () => {
        useDragStore.getState().startFileDrag({
          label: "a.txt",
          pointerX: 5,
          pointerY: 5,
          filePath: "/p/p1/a.txt",
          fileName: "a.txt",
        });
        useDragStore.getState().move(6, 6);
        vi.advanceTimersByTime(300);
        document.elementFromPoint = () => null;
        useDragStore.getState().move(30, 30);
        vi.advanceTimersByTime(1000);
        useDragStore.getState().end();
      });
      expect(open(container)).toEqual(["p1"]);
    });
  });
});

/**
 * The `⋯` menu on each member header and the one shared search field.
 */
describe("box side panel member menu and shared search", () => {
  beforeEach(() => {
    useBoxesStore.setState({ boxes: [box("boxA", ["p1", "p2"])] });
    useProjectsStore.setState({
      projects: [proj("p1"), proj("p2")],
      activeId: null,
      loaded: true,
    });
    useTabsStore.setState({ scope: "box:boxA" });
  });

  async function renderBox() {
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<SidePanel open={true} />));
    });
    return container;
  }

  function section(container: HTMLElement, name: string): HTMLElement {
    return [...container.querySelectorAll<HTMLElement>(".file-root")].find(
      (el) => el.querySelector(".file-root-name")?.textContent === name,
    )!;
  }

  async function openMenu(container: HTMLElement, name: string) {
    await act(async () => {
      fireEvent.click(section(container, name).querySelector(".file-root-more")!);
    });
  }

  function menuRows(): string[] {
    return [...document.querySelectorAll(".context-menu-portal button")].map(
      (b) => b.textContent?.replace(/\s+/g, " ").trim() ?? "",
    );
  }

  it("puts a ⋯ on every member header and none on the box folder's", async () => {
    const container = await renderBox();
    expect(container.querySelectorAll(".file-root-more")).toHaveLength(2);
    expect(section(container, "boxA").querySelector(".file-root-more")).toBeNull();
  });

  it("the ⋯ menu holds Files/Git, the folder, settings and Open as tab (no Remote/Local for a local member)", async () => {
    const container = await renderBox();
    await openMenu(container, "p1");
    const rows = menuRows();
    expect(rows[0]).toBe("Files");
    expect(rows[1]).toBe("Git");
    expect(rows.some((r) => r.startsWith("Open folder in file manager"))).toBe(true);
    expect(rows.some((r) => r.startsWith("Project settings"))).toBe(true);
    expect(rows.some((r) => r.startsWith("Open as tab"))).toBe(true);
    expect(rows).not.toContain("Remote");
    expect(rows).not.toContain("Local");
  });

  it("the body keeps the Files/Git segmented control, but only inside the expanded section", async () => {
    const container = await renderBox();
    expect(section(container, "p1").querySelectorAll(".side-panel-toolbar--box-root .toolbar-btn")).toHaveLength(2);
    expect(section(container, "p2").querySelector(".side-panel-toolbar--box-root")).toBeNull();
    // The folder and settings buttons moved into the menu.
    expect(section(container, "p1").querySelector(".toolbar-btn--sm")).toBeNull();
  });

  it("Git from the menu of a collapsed member expands it on the Git view", async () => {
    const container = await renderBox();
    await openMenu(container, "p2");
    await act(async () => {
      fireEvent.click(
        [...document.querySelectorAll<HTMLElement>(".context-menu-portal button")].find(
          (b) => b.textContent === "Git",
        )!,
      );
    });
    const row = useBoxAccordionStore.getState().byBox.boxA;
    expect(row?.open).toBe("p2");
    expect(row?.views?.p2).toBe("git");
    expect(section(container, "p2").classList.contains("is-collapsed")).toBe(false);
    expect(document.querySelector(".context-menu-portal")).toBeNull();
  });

  it("Open as tab opens the member's Files (Project) tab in its root", async () => {
    const container = await renderBox();
    await openMenu(container, "p2");
    await act(async () => {
      fireEvent.click(
        [...document.querySelectorAll<HTMLElement>(".context-menu-portal button")].find((b) =>
          b.textContent?.startsWith("Open as tab"),
        )!,
      );
    });
    const tab = useTabsStore.getState().tabs.find((t) => t.kind === "projectfiles");
    expect(tab?.cwd).toBe("/p/p2");
  });

  it("Open folder in file manager asks for the member's folder", async () => {
    const container = await renderBox();
    await openMenu(container, "p1");
    await act(async () => {
      fireEvent.click(
        [...document.querySelectorAll<HTMLElement>(".context-menu-portal button")].find((b) =>
          b.textContent?.startsWith("Open folder in file manager"),
        )!,
      );
    });
    expect(mockInvoke).toHaveBeenCalledWith("open_in_file_manager", { path: "/p/p1" });
  });

  it("a remote member's menu carries Remote/Local, and picking one switches the side", async () => {
    const remoteMember = {
      ...proj("p2"),
      remote: { host: "h", user: "u", remote_path: "/srv/p2" },
    } as ProjectEntry;
    useProjectsStore.setState({ projects: [proj("p1"), remoteMember] });
    useRemoteStatusStore.setState({ byProject: { p2: { ssh: "connected", vpn: "off" } } });
    useFileSourcePrefStore.setState({ byProject: { p2: "remote" }, byViewer: {} });
    const container = await renderBox();
    await openMenu(container, "p2");
    expect(menuRows()).toEqual(expect.arrayContaining(["Local", "Remote"]));
    await act(async () => {
      fireEvent.click(
        [...document.querySelectorAll<HTMLElement>(".context-menu-portal button")].find(
          (b) => b.textContent === "Local",
        )!,
      );
    });
    expect(useFileSourcePrefStore.getState().byProject.p2).toBe("local");
  });

  describe("shared search", () => {
    async function openSearch(container: HTMLElement) {
      await act(async () => {
        fireEvent.click(container.querySelector<HTMLElement>('button[aria-label="Show search"]')!);
      });
    }

    it("draws one field above the sections instead of one per tree", async () => {
      const container = await renderBox();
      expect(container.querySelector(".box-shared-search")).toBeNull();
      await openSearch(container);
      expect(container.querySelectorAll(".box-shared-search")).toHaveLength(1);
      // The trees draw no box of their own.
      expect(container.querySelectorAll(".file-tree-search-input")).toHaveLength(1);
      expect(container.querySelector(".file-root .file-tree-search")).toBeNull();
      // The placeholder names the expanded member.
      expect(
        (container.querySelector(".box-shared-search input") as HTMLInputElement).placeholder,
      ).toContain("p1");
    });

    it("searches the expanded member only, and follows the expansion", async () => {
      const container = await renderBox();
      await openSearch(container);
      const input = () => container.querySelector(".box-shared-search input") as HTMLInputElement;
      await act(async () => {
        fireEvent.change(input(), { target: { value: "needle" } });
      });
      const pathCalls = () =>
        mockInvoke.mock.calls.filter((c) => c[0] === "list_project_paths").map((c) => (c[1] as { projectDir: string }).projectDir);
      expect(pathCalls()).toEqual(["/p/p1"]);
      // Opening another member clears the query and searches the new one.
      await act(async () => {
        fireEvent.click(section(container, "p2").querySelector(".file-root-header")!);
      });
      expect(input().value).toBe("");
      expect(input().placeholder).toContain("p2");
      await act(async () => {
        fireEvent.change(input(), { target: { value: "other" } });
      });
      expect(pathCalls()).toContain("/p/p2");
    });

    it("closing the toolbar toggle clears the query and removes the field", async () => {
      const container = await renderBox();
      await openSearch(container);
      await act(async () => {
        fireEvent.change(container.querySelector(".box-shared-search input")!, { target: { value: "x" } });
      });
      await act(async () => {
        fireEvent.click(container.querySelector<HTMLElement>('button[aria-label="Hide search"]')!);
      });
      expect(container.querySelector(".box-shared-search")).toBeNull();
    });

    it("a remote member on its Remote side cannot be searched, and says so", async () => {
      const remoteMember = {
        ...proj("p1"),
        remote: { host: "h", user: "u", remote_path: "/srv/p1" },
      } as ProjectEntry;
      useProjectsStore.setState({ projects: [remoteMember, proj("p2")] });
      useRemoteStatusStore.setState({ byProject: { p1: { ssh: "connected", vpn: "off" } } });
      useFileSourcePrefStore.setState({ byProject: { p1: "remote" }, byViewer: {} });
      const container = await renderBox();
      await openSearch(container);
      const input = container.querySelector(".box-shared-search input") as HTMLInputElement;
      expect(input.disabled).toBe(true);
      expect(input.placeholder).toContain("Local");
    });
  });
});
