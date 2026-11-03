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
  it("lists only active non-members and filters without project-management actions", async () => {
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
    expect(menu.querySelector('[data-project-id="member"]')).toBeNull();
    expect(menu.querySelector('[data-project-id="inactive"]')).toBeNull();
    expect(menu.querySelector('[data-project-id="Alpha"]')).toBeTruthy();
    expect(menu.querySelector('[data-project-id="Beta"]')).toBeTruthy();
    expect(menu.textContent).not.toContain("New Project");
    expect(menu.textContent).not.toContain("Import Project");

    fireEvent.change(menu.querySelector("input")!, { target: { value: "bet" } });
    expect(menu.querySelector('[data-project-id="Alpha"]')).toBeNull();
    expect(menu.querySelector('[data-project-id="Beta"]')).toBeTruthy();
  });

  it("adds several candidates in place and shows the empty state when exhausted", async () => {
    const addToBox = useBoxesStore.getState().addToBox;
    const addSpy = vi.fn(addToBox);
    useBoxesStore.setState({ addToBox: addSpy });
    const container = await renderBoxSlice(
      [project("member", 0), project("first", 1), project("second", 2)],
      ["member"],
    );
    const menu = openAddMenu(container);

    await act(async () => {
      fireEvent.click(menu.querySelector('[data-project-id="first"]')!);
    });
    expect(addSpy).toHaveBeenCalledWith("first", "boxA");
    expect(container.querySelector(".project-switcher-add-menu")).toBe(menu);
    expect(menu.querySelector('[data-project-id="first"]')).toBeNull();
    expect(pillNames(container)).toEqual(["member", "first"]);

    await act(async () => {
      fireEvent.click(menu.querySelector('[data-project-id="second"]')!);
    });
    expect(pillNames(container)).toEqual(["member", "first", "second"]);
    expect(menu.querySelector(".project-switcher-box-add-empty")?.textContent).toContain(
      "No active projects",
    );
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
});
