/**
 * Phase-3 box/unbox gestures (#41): the pill menu's Boxes group (the shared
 * membership checklist: additive rows that stay open and scroll, "New box with
 * ⟨project⟩…" through the quick-create name prompt, "Remove ⟨project⟩ from
 * ⟨box⟩" in a slice), Ctrl/Cmd-click multi-select ("Box these (N)…",
 * Escape/plain-click clears), and the box sheet's explicit, confirmed dissolve
 * (replacing the old silent one; the rest of the sheet is in BoxSheet.test).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, fireEvent, screen, within } from "@testing-library/react";
import type { ProjectBox, ProjectEntry } from "../../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn().mockResolvedValue(null) }));

import { ProjectSwitcher } from "../../components/layout/ProjectSwitcher";
import { BoxEditorDialog } from "../../components/projects/BoxEditorDialog";
import { useProjectsStore } from "../../stores/projects";
import { useBoxesStore } from "../../stores/boxes";
import { resetBoxSlice, useBoxSliceStore } from "../../stores/boxSlice";
import { useBoxEditorStore } from "../../stores/boxEditor";
import { usePillSelectionStore } from "../../stores/drag/pillSelection";
import { usePillDragStore } from "../../stores/drag/pillDrag";

function proj(id: string, position: number): ProjectEntry {
  return {
    id,
    name: id,
    status: "active",
    position,
    local_file: `/p/${id}/project.json`,
  };
}

function box(id: string, members: string[], position = 5): ProjectBox {
  return { id, name: id, member_ids: members, position };
}

function pointer(
  type: string,
  x: number,
  y: number,
  target: EventTarget,
  opts: { ctrlKey?: boolean } = {},
) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, { clientX: x, clientY: y, button: 0, pointerId: 1, ctrlKey: !!opts.ctrlKey });
  act(() => {
    target.dispatchEvent(ev);
  });
}

function findPill(container: HTMLElement, name: string): HTMLElement {
  return [...container.querySelectorAll(".project-pill:not(.is-box)")].find(
    (el) => el.querySelector(".project-pill-label")?.textContent === name,
  ) as HTMLElement;
}

function menuButton(text: string): HTMLElement | undefined {
  return [...document.querySelectorAll(".context-menu button")].find((el) =>
    el.textContent?.includes(text),
  ) as HTMLElement | undefined;
}

beforeEach(() => {
  resetBoxSlice();
  usePillDragStore.getState().end();
  usePillSelectionStore.getState().clear();
  useBoxEditorStore.getState().close();
  useProjectsStore.setState({ projects: [], activeId: null, loaded: true });
  useBoxesStore.setState({ boxes: [], loaded: true });
});

async function renderSwitcher() {
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<ProjectSwitcher open={true} />));
  });
  return container;
}

describe("pill menu — Boxes group (3a)", () => {
  it("clicking a non-member box row ADDS the project to it", async () => {
    const addToBox = vi.fn().mockResolvedValue(undefined);
    useBoxesStore.setState({ boxes: [box("boxA", [])], addToBox });
    useProjectsStore.setState({ projects: [proj("p1", 10)], activeId: null, loaded: true });

    const container = await renderSwitcher();
    await act(async () => {
      fireEvent.contextMenu(findPill(container, "p1"));
    });
    const row = menuButton("boxA")!;
    expect(row.querySelectorAll(".context-menu-checkmark svg path").length).toBe(0);
    await act(async () => {
      fireEvent.click(row);
    });
    expect(addToBox).toHaveBeenCalledWith("p1", "boxA");
    // The checklist stays open across toggles: adding to three boxes is three clicks.
    expect(menuButton("boxA")).toBeTruthy();
  });

  it("clicking a member box row (checked) REMOVES the project from that box", async () => {
    const removeFromBox = vi.fn().mockResolvedValue(undefined);
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"])], removeFromBox });
    useProjectsStore.setState({ projects: [proj("p1", 10)], activeId: null, loaded: true });

    const container = await renderSwitcher();
    await act(async () => {
      fireEvent.contextMenu(findPill(container, "p1"));
    });
    const row = menuButton("boxA")!;
    expect(row.querySelector(".context-menu-checkmark svg")).toBeTruthy();
    await act(async () => {
      fireEvent.click(row);
    });
    expect(removeFromBox).toHaveBeenCalledWith("p1", "boxA");
  });

  /** Answer the quick-create name prompt that a menu row opened. */
  async function nameTheBox(name: string): Promise<HTMLInputElement> {
    const field = (await screen.findByRole("textbox")) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(field, { target: { value: name } });
      fireEvent.keyDown(field, { key: "Enter" });
    });
    return field;
  }

  it("“New box with ⟨project⟩…” asks for a name, creates the box holding the project and enters it", async () => {
    const created = box("boxNew", ["p1"], 1);
    const createBoxQuick = vi.fn(async () => created);
    const openBox = vi.fn(async () => {});
    useBoxesStore.setState({ boxes: [], createBoxQuick, openBox });
    useProjectsStore.setState({ projects: [proj("p1", 10)], activeId: null, loaded: true });

    const container = await renderSwitcher();
    await act(async () => {
      fireEvent.contextMenu(findPill(container, "p1"));
    });
    await act(async () => {
      fireEvent.click(menuButton("New box with p1")!);
    });
    // Never the editor in create mode: the name prompt is the whole door.
    expect(useBoxEditorStore.getState().open).toBe(false);
    const field = (await screen.findByRole("textbox")) as HTMLInputElement;
    expect(field.value).toBe("Box 1");
    await nameTheBox("Thesis");
    expect(createBoxQuick).toHaveBeenCalledWith({ name: "Thesis", memberIds: ["p1"] });
    expect(openBox).toHaveBeenCalledWith("boxNew");
  });

  it("the group lists every box with no cap, scrolls, and has no Edit boxes… dead end", async () => {
    useBoxesStore.setState({
      boxes: Array.from({ length: 8 }, (_, i) => box(`b${i}`, [], i)),
    });
    useProjectsStore.setState({ projects: [proj("p1", 10)], activeId: null, loaded: true });

    const container = await renderSwitcher();
    await act(async () => {
      fireEvent.contextMenu(findPill(container, "p1"));
    });
    // The old 6-row cap is gone; all eight rows are there, in their own scroll region.
    expect(menuButton("b0")).toBeTruthy();
    expect(menuButton("b7")).toBeTruthy();
    expect(document.querySelector(".context-menu .box-member-list")).toBeTruthy();
    expect(menuButton("Edit boxes")).toBeUndefined();
    // Eight rows are not "past 8": no filter yet.
    expect(document.querySelector(".context-menu .box-member-filter")).toBeNull();
  });

  it("past 8 boxes a filter narrows the rows", async () => {
    useBoxesStore.setState({
      boxes: Array.from({ length: 10 }, (_, i) => box(`b${i}`, [], i)),
    });
    useProjectsStore.setState({ projects: [proj("p1", 10)], activeId: null, loaded: true });

    const container = await renderSwitcher();
    await act(async () => {
      fireEvent.contextMenu(findPill(container, "p1"));
    });
    const filter = document.querySelector(".context-menu .box-member-filter") as HTMLInputElement;
    expect(filter).toBeTruthy();
    fireEvent.change(filter, { target: { value: "b7" } });
    expect(menuButton("b7")).toBeTruthy();
    expect(menuButton("b3")).toBeUndefined();
    fireEvent.change(filter, { target: { value: "zzz" } });
    expect(document.querySelector(".context-menu .box-member-list")!.textContent).toContain("Nothing matches");
  });

  it("a ticked box row keeps its place: the list does not reorder under the pointer", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", [], 1), box("boxB", [], 2)], addToBox: vi.fn().mockResolvedValue(undefined) });
    useProjectsStore.setState({ projects: [proj("p1", 10)], activeId: null, loaded: true });
    const container = await renderSwitcher();
    await act(async () => {
      fireEvent.contextMenu(findPill(container, "p1"));
    });
    const names = () =>
      [...document.querySelectorAll(".context-menu .box-member-row .box-member-name")].map((e) => e.textContent);
    expect(names()).toEqual(["boxA", "boxB"]);
    await act(async () => {
      useBoxesStore.setState({ boxes: [box("boxA", [], 1), box("boxB", ["p1"], 2)] });
    });
    expect(names()).toEqual(["boxA", "boxB"]);
  });

  it("inside a box slice a member's menu offers an explicit “Remove ⟨project⟩ from ⟨box⟩”", async () => {
    const removeFromBox = vi.fn().mockResolvedValue(undefined);
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"])], removeFromBox });
    useProjectsStore.setState({ projects: [proj("p1", 10), proj("p2", 20)], activeId: null, loaded: true });
    useBoxSliceStore.setState({ sliceBoxId: "boxA" });

    const container = await renderSwitcher();
    await act(async () => {
      fireEvent.contextMenu(findPill(container, "p1"));
    });
    const row = menuButton("Remove p1 from boxA")!;
    expect(row).toBeTruthy();
    await act(async () => {
      fireEvent.click(row);
    });
    expect(removeFromBox).toHaveBeenCalledWith("p1", "boxA");
    // An explicit remove is an action, not a toggle: the menu is done.
    expect(menuButton("Remove p1 from boxA")).toBeUndefined();
  });

  it("outside a slice there is no Remove-from-box row", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"])] });
    useProjectsStore.setState({ projects: [proj("p1", 10)], activeId: null, loaded: true });
    const container = await renderSwitcher();
    await act(async () => {
      fireEvent.contextMenu(findPill(container, "p1"));
    });
    expect(menuButton("Remove p1 from")).toBeUndefined();
  });
});

describe("multi-select (3b)", () => {
  it("Ctrl-click toggles selection (ring class) without activating", async () => {
    const setActive = vi.fn().mockResolvedValue(undefined);
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: null,
      loaded: true,
      setActive,
    });

    const container = await renderSwitcher();
    pointer("pointerdown", 10, 10, findPill(container, "p1"), { ctrlKey: true });
    pointer("pointerdown", 10, 10, findPill(container, "p2"), { ctrlKey: true });
    expect(usePillSelectionStore.getState().selected).toEqual(["p1", "p2"]);
    expect(findPill(container, "p1").classList.contains("is-selected")).toBe(true);
    expect(findPill(container, "p2").classList.contains("is-selected")).toBe(true);
    expect(setActive).not.toHaveBeenCalled();

    // A second Ctrl-click deselects.
    pointer("pointerdown", 10, 10, findPill(container, "p1"), { ctrlKey: true });
    expect(usePillSelectionStore.getState().selected).toEqual(["p2"]);
  });

  it("right-click on a selected pill offers “Box these (N)…” through the name prompt", async () => {
    const created = box("boxNew", ["p1", "p2"], 1);
    const createBoxQuick = vi.fn(async () => created);
    useBoxesStore.setState({ boxes: [], createBoxQuick, openBox: vi.fn(async () => {}) });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: null,
      loaded: true,
    });

    const container = await renderSwitcher();
    pointer("pointerdown", 10, 10, findPill(container, "p1"), { ctrlKey: true });
    pointer("pointerdown", 10, 10, findPill(container, "p2"), { ctrlKey: true });
    await act(async () => {
      fireEvent.contextMenu(findPill(container, "p2"));
    });
    const row = menuButton("Box these (2)")!;
    expect(row).toBeTruthy();
    await act(async () => {
      fireEvent.click(row);
    });
    expect(useBoxEditorStore.getState().open).toBe(false);
    // The prompt names the members it will hold, and Enter creates the box.
    expect((await screen.findByRole("dialog")).textContent).toContain("p1, p2");
    const field = (await screen.findByRole("textbox")) as HTMLInputElement;
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    expect(createBoxQuick).toHaveBeenCalledWith({ name: "Box 1", memberIds: ["p1", "p2"] });
    // The selection is spent once the box exists.
    expect(usePillSelectionStore.getState().selected).toEqual([]);
  });

  it("Escape clears the selection", async () => {
    useProjectsStore.setState({ projects: [proj("p1", 10)], activeId: null, loaded: true });
    const container = await renderSwitcher();
    pointer("pointerdown", 10, 10, findPill(container, "p1"), { ctrlKey: true });
    expect(usePillSelectionStore.getState().selected).toEqual(["p1"]);
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(usePillSelectionStore.getState().selected).toEqual([]);
  });
});

describe("box sheet — dissolve (3c)", () => {
  it("dissolve asks for confirmation and states nothing on disk is deleted", async () => {
    const deleteBox = vi.fn().mockResolvedValue(undefined);
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"])], deleteBox });
    useProjectsStore.setState({ projects: [proj("p1", 10)], activeId: null, loaded: true });
    useBoxEditorStore.getState().openEditor("boxA");

    const onClose = vi.fn();
    await act(async () => {
      render(<BoxEditorDialog onClose={onClose} />);
    });
    const dialog = document.querySelector(".box-editor")!;
    const dissolve = [...dialog.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Dissolve"),
    )!;
    await act(async () => {
      fireEvent.click(dissolve);
    });
    // The app's own question (never `window.confirm`), over the editor.
    expect(deleteBox).not.toHaveBeenCalled();
    const question = await screen.findByRole("dialog", { name: "Dissolve box" });
    expect(question.textContent).toContain("stay on disk");
    await act(async () => {
      fireEvent.click(within(question).getByRole("button", { name: "Dissolve box" }));
    });
    expect(deleteBox).toHaveBeenCalledWith("boxA");
  });

  it("a declined confirm dissolves nothing", async () => {
    const deleteBox = vi.fn().mockResolvedValue(undefined);
    useBoxesStore.setState({ boxes: [box("boxA", [])], deleteBox });
    useBoxEditorStore.getState().openEditor("boxA");

    await act(async () => {
      render(<BoxEditorDialog onClose={vi.fn()} />);
    });
    const dissolve = [...document.querySelectorAll(".box-editor button")].find((b) =>
      b.textContent?.includes("Dissolve"),
    )!;
    await act(async () => {
      fireEvent.click(dissolve);
    });
    const question = await screen.findByRole("dialog", { name: "Dissolve box" });
    await act(async () => {
      fireEvent.click(within(question).getByRole("button", { name: "Cancel" }));
    });
    expect(screen.queryByRole("dialog", { name: "Dissolve box" })).toBeNull();
    expect(deleteBox).not.toHaveBeenCalled();
  });
});

describe("ghost + Box pill (AS2a)", () => {
  it("is the row's only box UI while there is no box, and goes once one exists", async () => {
    useProjectsStore.setState({ projects: [proj("p1", 10)], activeId: null, loaded: true });
    const container = await renderSwitcher();
    const ghost = container.querySelector(".box-ghost-pill");
    expect(ghost).toBeTruthy();
    expect(ghost!.textContent).toContain("Box");
    expect(container.querySelectorAll(".box-scope-pill")).toHaveLength(0);
    expect(container.querySelector(".box-fold-pill")).toBeNull();

    await act(async () => {
      useBoxesStore.setState({ boxes: [box("boxA", ["p1"])] });
    });
    expect(container.querySelector(".box-ghost-pill")).toBeNull();
    expect(container.querySelectorAll(".box-scope-pill")).toHaveLength(1);
  });

  it("asks for a name, creates the box through the quick-create door and enters it", async () => {
    const created = box("boxNew", [], 1);
    const createBoxQuick = vi.fn(async () => created);
    const openBox = vi.fn(async () => {});
    useBoxesStore.setState({ boxes: [], createBoxQuick, openBox });
    useProjectsStore.setState({ projects: [proj("p1", 10)], activeId: null, loaded: true });
    const container = await renderSwitcher();

    await act(async () => {
      fireEvent.click(container.querySelector(".box-ghost-pill .box-chip-main") as HTMLElement);
    });
    const field = (await screen.findByRole("textbox")) as HTMLInputElement;
    // Pre-filled with the next free default name, as every other door does.
    expect(field.value).toBe("Box 1");
    await act(async () => {
      fireEvent.change(field, { target: { value: "Thesis" } });
      fireEvent.keyDown(field, { key: "Enter" });
    });
    expect(createBoxQuick).toHaveBeenCalledWith({ name: "Thesis", memberIds: [] });
    expect(openBox).toHaveBeenCalledWith("boxNew");
  });
});

describe("empty box in the slice strip (AS5b)", () => {
  it("shows \"No projects yet\" with Add projects… for an empty sliced box, and the button opens the sheet", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", [])] });
    useProjectsStore.setState({ projects: [proj("p1", 10)], activeId: null, loaded: true });
    useBoxSliceStore.setState({ sliceBoxId: "boxA" });
    const container = await renderSwitcher();
    const line = container.querySelector(".box-empty-strip") as HTMLElement;
    expect(line.textContent).toContain("No projects yet");
    await act(async () => {
      fireEvent.click(line.querySelector(".box-empty-add")!);
    });
    expect(useBoxEditorStore.getState().open).toBe(true);
    expect(useBoxEditorStore.getState().boxId).toBe("boxA");
  });

  it("is absent for a box with members and with no slice", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"]), box("boxB", [])] });
    useProjectsStore.setState({ projects: [proj("p1", 10)], activeId: null, loaded: true });
    useBoxSliceStore.setState({ sliceBoxId: "boxA" });
    const container = await renderSwitcher();
    expect(container.querySelector(".box-empty-strip")).toBeNull();
    await act(async () => {
      useBoxSliceStore.setState({ sliceBoxId: null });
    });
    expect(container.querySelector(".box-empty-strip")).toBeNull();
  });
});
