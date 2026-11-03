/**
 * Component test for boxes in the project search (#41 Phase 2). A box matching
 * the query appears as a `.project-search-row.is-box` row in the popover; picking
 * it calls the box store's openBox (which ensures the box folder + activates a
 * box scope) rather than activating a project. Members stay independently
 * searchable (opt-in merge).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import type { ProjectBox, ProjectEntry } from "../../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn().mockResolvedValue(null) }));

import { ProjectSwitcher } from "../../components/layout/ProjectSwitcher";
import { useProjectsStore } from "../../stores/projects";
import { useBoxesStore } from "../../stores/boxes";
import { resetBoxSlice, useBoxSliceStore } from "../../stores/boxSlice";

function inactiveProj(id: string): ProjectEntry {
  return { id, name: id, status: "inactive", position: 10, local_file: `/p/${id}/project.json` };
}

function box(id: string, name: string, members: string[]): ProjectBox {
  return { id, name, member_ids: members, position: 5 };
}

beforeEach(() => {
  resetBoxSlice();
  useProjectsStore.setState({ projects: [], activeId: null, loaded: true });
  useBoxesStore.setState({ boxes: [], loaded: true });
});

describe("#41 box search results", () => {
  it("shows a box row with the is-box class and openBox fires on pick", async () => {
    const openBox = vi.fn().mockResolvedValue(undefined);
    const setActive = vi.fn().mockResolvedValue(undefined);
    useBoxesStore.setState({ boxes: [box("boxA", "PaperBox", ["p1"])], openBox });
    useProjectsStore.setState({
      projects: [inactiveProj("p1")],
      activeId: null,
      loaded: true,
      setActive,
    });

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<ProjectSwitcher open={true} />));
    });

    const input = container.querySelector(".project-search-entry") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "paper" } });
    });

    const boxRow = container.querySelector(".project-search-row.is-box") as HTMLElement;
    expect(boxRow).toBeTruthy();
    expect(boxRow.textContent).toContain("PaperBox");

    await act(async () => {
      fireEvent.click(boxRow);
    });

    expect(openBox).toHaveBeenCalledWith("boxA");
    expect(setActive).not.toHaveBeenCalled();
  });

  it("members remain independently searchable alongside their box", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", "PaperBox", ["paperdraft"])] });
    useProjectsStore.setState({
      projects: [inactiveProj("paperdraft")],
      activeId: null,
      loaded: true,
    });

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<ProjectSwitcher open={true} />));
    });

    const input = container.querySelector(".project-search-entry") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "paper" } });
    });

    // Both the box row and the member project row are present.
    expect(container.querySelector(".project-search-row.is-box")).toBeTruthy();
    const rows = [...container.querySelectorAll(".project-search-row")];
    expect(rows.some((r) => !r.classList.contains("is-box") && r.textContent?.includes("paperdraft"))).toBe(true);
  });

  it("navigates matching rows with arrows and opens the highlighted result", async () => {
    const openBox = vi.fn().mockResolvedValue(undefined);
    const setActive = vi.fn().mockResolvedValue(undefined);
    useBoxesStore.setState({ boxes: [box("boxA", "PaperBox", ["paperdraft"])], openBox });
    useProjectsStore.setState({
      projects: [inactiveProj("paperdraft")],
      activeId: null,
      loaded: true,
      setActive,
    });

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<ProjectSwitcher open={true} />));
    });

    const input = container.querySelector(".project-search-entry") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "paper" } });
      fireEvent.keyDown(input, { key: "ArrowDown" });
    });

    const rows = [...container.querySelectorAll(".project-search-row")];
    expect(rows[1].classList.contains("is-selected")).toBe(true);

    await act(async () => {
      fireEvent.keyDown(input, { key: "ArrowUp" });
    });
    expect(rows[0].classList.contains("is-selected")).toBe(true);

    await act(async () => {
      fireEvent.keyDown(input, { key: "ArrowDown" });
    });
    expect(rows[1].classList.contains("is-selected")).toBe(true);

    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    expect(setActive).toHaveBeenCalledWith("paperdraft");
    expect(openBox).not.toHaveBeenCalled();
  });
});

function activeProj(id: string, position = 1): ProjectEntry {
  return { id, name: id, status: "inactive", position, local_file: `/p/${id}/project.json` };
}

async function renderSwitcher() {
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<ProjectSwitcher open={true} />));
  });
  const input = container.querySelector(".project-search-entry") as HTMLInputElement;
  return { container, input };
}

describe("boxes on focus, member-name match and swatches", () => {
  it("lists the boxes the moment the field has focus, with a coloured swatch and the member names", async () => {
    const openBox = vi.fn().mockResolvedValue(undefined);
    useBoxesStore.setState({
      boxes: [{ ...box("boxA", "Thesis", ["alpha", "beta"]), color: "#ff0000" }, box("boxB", "Infra", [])],
      openBox,
    });
    useProjectsStore.setState({ projects: [inactiveProj("alpha"), inactiveProj("beta")], activeId: null, loaded: true });
    const { container, input } = await renderSwitcher();

    // Closed until the field is touched: nothing typed yet.
    expect(container.querySelector(".project-search-popover")).toBeNull();
    await act(async () => {
      fireEvent.focus(input);
    });

    const rows = [...container.querySelectorAll(".project-search-row.is-box")] as HTMLElement[];
    expect(rows.map((r) => r.querySelector(".project-search-name")?.textContent?.trim())).toEqual(["Thesis", "Infra"]);
    expect(container.querySelector(".project-search-group")?.textContent).toContain("Boxes");
    // The coloured BoxSwatch, not the plain hexagon icon.
    const swatch = rows[0].querySelector("svg.box-swatch") as SVGElement;
    expect(swatch).toBeTruthy();
    expect(swatch.style.color).toBe("rgb(255, 0, 0)");
    expect(rows[0].querySelector(".project-box-badge")).toBeNull();
    expect(rows[0].querySelector("small")?.textContent).toContain("alpha, beta");

    await act(async () => {
      fireEvent.click(rows[0]);
    });
    expect(openBox).toHaveBeenCalledWith("boxA");
    // A pick closes the list again.
    expect(container.querySelector(".project-search-popover")).toBeNull();
  });

  it("opens nothing on focus when there is no box to list", async () => {
    useProjectsStore.setState({ projects: [inactiveProj("alpha")], activeId: null, loaded: true });
    const { container, input } = await renderSwitcher();
    await act(async () => {
      fireEvent.focus(input);
    });
    expect(container.querySelector(".project-search-popover")).toBeNull();
  });

  it("matches a box by a member's name and the member stays a row of its own", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", "Thesis", ["zebra"]), box("boxB", "Infra", ["other"])] });
    useProjectsStore.setState({ projects: [inactiveProj("zebra"), inactiveProj("other")], activeId: null, loaded: true });
    const { container, input } = await renderSwitcher();
    await act(async () => {
      fireEvent.change(input, { target: { value: "zeb" } });
    });
    const boxRows = [...container.querySelectorAll(".project-search-row.is-box")];
    expect(boxRows).toHaveLength(1);
    expect(boxRows[0].textContent).toContain("Thesis");
    const all = [...container.querySelectorAll(".project-search-row")];
    expect(all.some((r) => !r.classList.contains("is-box") && r.textContent?.includes("zebra"))).toBe(true);
  });

  it("gives a project row the swatches of the boxes it belongs to", async () => {
    useBoxesStore.setState({
      boxes: [
        { ...box("boxA", "Thesis", ["alpha"]), color: "#00ff00" },
        { ...box("boxB", "Paper", ["alpha"]), position: 6, color: "#0000ff" },
        box("boxC", "Infra", ["beta"]),
      ],
    });
    useProjectsStore.setState({ projects: [inactiveProj("alpha"), inactiveProj("beta")], activeId: null, loaded: true });
    const { container, input } = await renderSwitcher();
    await act(async () => {
      fireEvent.change(input, { target: { value: "alpha" } });
    });
    const row = [...container.querySelectorAll(".project-search-row")].find(
      (r) => !r.classList.contains("is-box") && r.textContent?.includes("alpha"),
    ) as HTMLElement;
    const swatches = [...row.querySelectorAll(".project-search-boxes svg.box-swatch")] as SVGElement[];
    expect(swatches).toHaveLength(2);
    expect(swatches[0].style.color).toBe("rgb(0, 255, 0)");
    expect(swatches[1].style.color).toBe("rgb(0, 0, 255)");
    expect(row.querySelector(".project-search-boxes")?.getAttribute("title")).toBe("Thesis, Paper");
    // A project in no box wears none.
    await act(async () => {
      fireEvent.change(input, { target: { value: "beta" } });
    });
    const infra = [...container.querySelectorAll(".project-search-row:not(.is-box)")].find((r) =>
      r.textContent?.includes("beta"),
    ) as HTMLElement;
    expect(infra.querySelectorAll(".project-search-boxes svg").length).toBe(1);
  });

  it("leads with All projects while a box is sliced, and picking it clears the slice", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", "Thesis", ["alpha"]), box("boxB", "Infra", [])], openBox: vi.fn() });
    useProjectsStore.setState({ projects: [activeProj("alpha")], activeId: null, loaded: true });
    useBoxSliceStore.setState({ sliceBoxId: "boxA" });
    const { container, input } = await renderSwitcher();
    await act(async () => {
      fireEvent.focus(input);
    });
    const rows = [...container.querySelectorAll(".project-search-row")] as HTMLElement[];
    expect(rows[0].classList.contains("is-all")).toBe(true);
    expect(rows[0].textContent).toContain("All projects");
    expect(rows.slice(1).every((r) => r.classList.contains("is-box"))).toBe(true);

    await act(async () => {
      fireEvent.click(rows[0]);
    });
    expect(useBoxSliceStore.getState().sliceBoxId).toBeNull();
  });

  it("has no All projects row when nothing is sliced", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", "Thesis", [])] });
    const { container, input } = await renderSwitcher();
    await act(async () => {
      fireEvent.focus(input);
    });
    expect(container.querySelector(".project-search-row.is-all")).toBeNull();
  });
});
