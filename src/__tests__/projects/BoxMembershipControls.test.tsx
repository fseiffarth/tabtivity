/**
 * The switcher's ordinary project controls become Box-membership controls
 * while a Box slice is selected. The selected slice, not the current project
 * scope, owns that mode so it survives opening a member project.
 */
import { act, fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectBox, ProjectEntry } from "../../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ startDragging: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: vi.fn().mockResolvedValue(false),
  open: vi.fn().mockResolvedValue(null),
}));

import { ProjectSwitcher } from "../../components/layout/ProjectSwitcher";
import { useBoxesStore } from "../../stores/boxes";
import { resetBoxSlice } from "../../stores/boxSlice";
import { useHeaderHoverMenuStore } from "../../stores/headerHoverMenu";
import { useProjectsStore } from "../../stores/projects";
import { useTabsStore } from "../../stores/tabs";

/** The store's own actions: several tests below swap one for a spy and leave it. */
const REAL_BOX_ACTIONS = (({ addToBox, removeFromBox, reorderBoxMembers }) => ({
  addToBox,
  removeFromBox,
  reorderBoxMembers,
}))(useBoxesStore.getState());

function project(
  id: string,
  position: number,
  extra: Partial<ProjectEntry> = {},
): ProjectEntry {
  return {
    id,
    name: id,
    status: "active",
    position,
    local_file: `/p/${id}/project.json`,
    ...extra,
  };
}

function box(memberIds: string[]): ProjectBox {
  return { id: "boxA", name: "Research", member_ids: memberIds, position: 0 };
}

function pill(container: HTMLElement, name: string): HTMLElement {
  return [...container.querySelectorAll<HTMLElement>(".project-pill")].find(
    (element) => element.querySelector(".project-pill-label")?.textContent === name,
  )!;
}

function pillNames(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".project-pill-label")].map(
    (element) => element.textContent ?? "",
  );
}

async function renderBoxSlice(projects: ProjectEntry[], memberIds: string[]) {
  useProjectsStore.setState({ projects, activeId: null, loaded: true });
  useBoxesStore.setState({ boxes: [box(memberIds)], loaded: true });
  useTabsStore.setState({ scope: "box:boxA" });
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<ProjectSwitcher open />));
  });
  return container;
}

function openAddMenu(container: HTMLElement): HTMLElement {
  fireEvent.click(container.querySelector(".project-switcher-add-btn")!);
  return container.querySelector(".project-switcher-add-menu") as HTMLElement;
}

beforeEach(() => {
  resetBoxSlice();
  useHeaderHoverMenuStore.setState({ openId: null });
  useProjectsStore.setState({ projects: [], activeId: null, loaded: true });
  useBoxesStore.setState({ boxes: [], loaded: true });
  useTabsStore.setState({ scope: "root" });
});

describe("Box membership controls", () => {
  it("leads with the box's member checklist (closed projects too) and keeps the project actions", async () => {
    const container = await renderBoxSlice(
      [
        project("member", 0),
        project("Alpha", 1),
        project("Beta", 2),
        project("inactive", 3, { status: "inactive" }),
      ],
      ["member"],
    );

    const menu = openAddMenu(container);
    expect(menu.classList.contains("box-membership")).toBe(true);
    const row = (id: string) => menu.querySelector<HTMLElement>(`[data-member-id="${id}"]`);
    // Every project is a row, ticked when it is a member; a closed one is listed.
    expect(row("member")?.getAttribute("aria-pressed")).toBe("true");
    expect(row("Alpha")?.getAttribute("aria-pressed")).toBe("false");
    expect(row("inactive")).toBeTruthy();
    // The project actions are still there inside a box.
    expect(menu.textContent).toContain("New Project");
    expect(menu.textContent).toContain("Import Project");
  });

  it("adds and removes members in place without closing the menu", async () => {
    const addToBox = useBoxesStore.getState().addToBox;
    const addSpy = vi.fn(addToBox);
    useBoxesStore.setState({ addToBox: addSpy });
    const container = await renderBoxSlice(
      [project("member", 0), project("first", 1), project("second", 2)],
      ["member"],
    );
    const menu = openAddMenu(container);

    await act(async () => {
      fireEvent.click(menu.querySelector('[data-member-id="first"]')!);
    });
    expect(addSpy).toHaveBeenCalledWith("first", "boxA");
    expect(container.querySelector(".project-switcher-add-menu")).toBe(menu);
    expect(menu.querySelector('[data-member-id="first"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(pillNames(container)).toEqual(["member", "first"]);

    await act(async () => {
      fireEvent.click(menu.querySelector('[data-member-id="second"]')!);
    });
    expect(pillNames(container)).toEqual(["member", "first", "second"]);
  });

  it("removes a member without deactivating it and keeps an open removed project visible", async () => {
    const deactivateProject = vi.fn().mockResolvedValue(undefined);
    useProjectsStore.setState({ deactivateProject });
    const container = await renderBoxSlice([project("member", 0)], ["member"]);

    await act(async () => {
      useTabsStore.setState({ scope: "member" });
    });
    const close = pill(container, "member").querySelector(".pill-close-btn") as HTMLElement;
    expect(close.title).toBe("Remove member from Research");
    await act(async () => {
      fireEvent.click(close);
    });

    expect(deactivateProject).not.toHaveBeenCalled();
    expect(useBoxesStore.getState().boxes[0].member_ids).toEqual([]);
    expect(pill(container, "member")).toBeTruthy();
    expect(pill(container, "member").querySelector(".pill-close-btn")).toBeNull();
    expect(pill(container, "member").querySelector(".project-pill-boxdot")).toBeNull();
  });

  it("hides × on the visible non-member exception", async () => {
    const container = await renderBoxSlice(
      [project("member", 0), project("open-non-member", 1)],
      ["member"],
    );
    await act(async () => {
      useTabsStore.setState({ scope: "open-non-member" });
    });

    expect(pill(container, "member").querySelector(".pill-close-btn")).toBeTruthy();
    expect(pill(container, "open-non-member").querySelector(".pill-close-btn")).toBeNull();
  });

  it("keeps a closed member's pill in the slice", async () => {
    // A member closed in the general strip stays open inside its box: openBox
    // restores its tabs box-locally, and the slice keeps showing its pill.
    const container = await renderBoxSlice(
      [project("member", 0), project("closed", 1, { status: "inactive" })],
      ["member", "closed"],
    );
    expect(pillNames(container)).toEqual(["member", "closed"]);
  });

  it("keeps a closed member out of the general strip (no slice selected)", async () => {
    useProjectsStore.setState({
      projects: [project("member", 0), project("closed", 1, { status: "inactive" })],
      activeId: null,
      loaded: true,
    });
    useBoxesStore.setState({ boxes: [box(["member", "closed"])], loaded: true });
    useTabsStore.setState({ scope: "root" });
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<ProjectSwitcher open />));
    });
    // Box-local reopening never adds the project here: it shows in the general
    // strip only if it was already open there.
    expect(pillNames(container)).toEqual(["member"]);
  });

  it("a closed member's pill menu offers the explicit Remove from the box", async () => {
    const removeFromBox = vi.fn().mockResolvedValue(undefined);
    useBoxesStore.setState({ removeFromBox });
    const container = await renderBoxSlice(
      [project("member", 0), project("closed", 1, { status: "inactive" })],
      ["member", "closed"],
    );
    await act(async () => {
      fireEvent.contextMenu(pill(container, "closed"));
    });
    const row = [...document.querySelectorAll(".context-menu button")].find((el) =>
      el.textContent?.includes("Remove closed from Research"),
    ) as HTMLElement;
    expect(row).toBeTruthy();
    await act(async () => {
      fireEvent.click(row);
    });
    expect(removeFromBox).toHaveBeenCalledWith("closed", "boxA");
  });

  it("retains ordinary + and × behavior outside a Box slice", async () => {
    const deactivateProject = vi.fn().mockResolvedValue(undefined);
    useProjectsStore.setState({
      projects: [project("ordinary", 0)],
      activeId: "ordinary",
      loaded: true,
      deactivateProject,
    });
    useBoxesStore.setState({ boxes: [box([])], loaded: true });

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<ProjectSwitcher open />));
    });
    const menu = openAddMenu(container);
    expect(menu.textContent).toContain("New Project");
    expect(menu.textContent).toContain("Import Project");

    fireEvent.click(pill(container, "ordinary").querySelector(".pill-close-btn")!);
    expect(deactivateProject).toHaveBeenCalledWith("ordinary");
  });

  it("shows a box's members in the box's own order, a non-member in scope last", async () => {
    const container = await renderBoxSlice(
      [project("a", 0), project("guest", 1), project("b", 2), project("c", 3)],
      ["c", "a", "b"],
    );
    // The order the side panel's sections stand in, not the general strip's.
    expect(pillNames(container)).toEqual(["c", "a", "b"]);
    await act(async () => {
      useTabsStore.setState({ scope: "guest" });
    });
    expect(pillNames(container)).toEqual(["c", "a", "b", "guest"]);
  });

  it("✕ offers Undo, which puts the project back at its place in the box", async () => {
    useBoxesStore.setState(REAL_BOX_ACTIONS);
    // `patch_box` answers the box as the file would hold it after the patch.
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd !== "patch_box") return null;
      const { patch } = args as { patch: { addMember?: string; removeMember?: string; order?: string[] } };
      const held = useBoxesStore.getState().boxes[0];
      let members = held.member_ids.filter((id) => id !== patch.removeMember);
      if (patch.addMember && !members.includes(patch.addMember)) members = [...members, patch.addMember];
      if (patch.order) members = patch.order.filter((id) => members.includes(id));
      return { ...held, member_ids: members };
    });
    const container = await renderBoxSlice(
      [project("a", 0), project("b", 1), project("c", 2)],
      ["a", "b", "c"],
    );
    await act(async () => {
      fireEvent.click(pill(container, "b").querySelector(".pill-close-btn")!);
    });
    expect(useBoxesStore.getState().boxes[0].member_ids).toEqual(["a", "c"]);
    const { switchToast, switchToastAction } = useProjectsStore.getState();
    expect(switchToast).toBe("Removed b from Research");
    expect(switchToastAction).toMatchObject({ text: switchToast, label: "Undo" });

    await act(async () => {
      switchToastAction!.run();
    });
    // Back between a and c, not appended after them.
    expect(useBoxesStore.getState().boxes[0].member_ids).toEqual(["a", "b", "c"]);
    expect(pillNames(container)).toEqual(["a", "b", "c"]);
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(null);
  });

  it("a toast set by anything else never inherits the Undo", () => {
    useProjectsStore.setState({
      switchToast: "Removed b from Research",
      switchToastAction: { text: "Removed b from Research", label: "Undo", run: vi.fn() },
    });
    useProjectsStore.setState({ switchToast: "switched" });
    const { switchToast, switchToastAction } = useProjectsStore.getState();
    // AppShell renders the button only while the action is bound to the text shown.
    expect(switchToastAction?.text === switchToast).toBe(false);
    useProjectsStore.getState().clearSwitchToast();
    expect(useProjectsStore.getState().switchToastAction).toBeNull();
  });
});

describe("leaving a box stops the closed members it reopened", () => {
  const TABS = [{ key: "a1", kind: "agent", cmd: "claude", label: "claude", cwd: "/p/closed" }];

  async function leaveWith(scope: string) {
    const { invoke } = await import("@tauri-apps/api/core");
    const calls: string[] = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      const scopeArg = (args as { scope?: string } | undefined)?.scope;
      calls.push(scopeArg ? `${cmd} ${scopeArg}` : cmd);
      return null;
    });
    useProjectsStore.setState({
      projects: [project("open", 0), project("closed", 1, { status: "inactive" })],
      activeId: null,
      loaded: true,
      switchToast: null,
    });
    useBoxesStore.setState({ boxes: [box(["open", "closed"])], loaded: true });
    useTabsStore.setState((state) => ({
      scope,
      tabsByScope: { ...state.tabsByScope, closed: TABS as never, open: TABS as never },
    }));
    const { useBoxSliceStore } = await import("../../stores/boxSlice");
    await act(async () => {
      useBoxSliceStore.getState().setSlice("boxA");
    });
    await act(async () => {
      useBoxSliceStore.getState().setSlice(null);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(null);
    return calls;
  }

  it("ends the closed member's terminals, drops its panes, keeps it closed and says so", async () => {
    const calls = await leaveWith("root");
    expect(calls).toContain("pty_kill_scope closed");
    expect(calls).not.toContain("pty_kill_scope open");
    const tabs = useTabsStore.getState().tabsByScope;
    expect(tabs.closed).toBeUndefined();
    expect(tabs.open).toBeDefined();
    expect(useProjectsStore.getState().projects.find((p) => p.id === "closed")?.status).toBe("inactive");
    expect(useProjectsStore.getState().switchToast).toBe("Closed again on leaving the box: closed");
    await useTabsStore.getState().unloadScope("open");
  });

  it("leaves the member on screen alone", async () => {
    const calls = await leaveWith("closed");
    expect(calls).not.toContain("pty_kill_scope closed");
    expect(useTabsStore.getState().tabsByScope.closed).toBeDefined();
    await useTabsStore.getState().unloadScope("closed");
    await useTabsStore.getState().unloadScope("open");
    useTabsStore.setState({ scope: "root" });
  });
});
