/**
 * Phase-3 box/unbox gestures (#41): the pill menu's Boxes group (checkbox rows
 * toggling additive membership, "New box with ⟨project⟩…" into the editor),
 * Ctrl/Cmd-click multi-select ("Box these (N)…", Escape/plain-click clears),
 * and the Box editor dialog (save = rename + set members; explicit, confirmed
 * dissolve replacing the old silent one).
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

  it("“New box with ⟨project⟩…” opens the editor in create mode pre-checked", async () => {
    useProjectsStore.setState({ projects: [proj("p1", 10)], activeId: null, loaded: true });

    const container = await renderSwitcher();
    await act(async () => {
      fireEvent.contextMenu(findPill(container, "p1"));
    });
    await act(async () => {
      fireEvent.click(menuButton("New box with p1")!);
    });
    const editor = useBoxEditorStore.getState();
    expect(editor.open).toBe(true);
    expect(editor.boxId).toBeNull();
    expect(editor.initialMemberIds).toEqual(["p1"]);
  });

  it("past 6 boxes the group caps its rows and offers “Edit boxes…”", async () => {
    useBoxesStore.setState({
      boxes: Array.from({ length: 8 }, (_, i) => box(`b${i}`, [], i)),
    });
    useProjectsStore.setState({ projects: [proj("p1", 10)], activeId: null, loaded: true });

    const container = await renderSwitcher();
    await act(async () => {
      fireEvent.contextMenu(findPill(container, "p1"));
    });
    expect(menuButton("b5")).toBeTruthy();
    expect(menuButton("b6")).toBeUndefined();
    const editRow = menuButton("Edit boxes")!;
    await act(async () => {
      fireEvent.click(editRow);
    });
    expect(useBoxEditorStore.getState().open).toBe(true);
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

  it("right-click on a selected pill offers “Box these (N)…” into the editor", async () => {
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
    const editor = useBoxEditorStore.getState();
    expect(editor.open).toBe(true);
    expect(editor.initialMemberIds).toEqual(["p1", "p2"]);
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

describe("box editor dialog (3c)", () => {
  it("save in EDIT mode renames + sets the member list", async () => {
    const renameBox = vi.fn().mockResolvedValue(undefined);
    const setBoxMembers = vi.fn().mockResolvedValue(undefined);
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"])], renameBox, setBoxMembers });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: null,
      loaded: true,
    });
    useBoxEditorStore.getState().openEditor("boxA");

    const onClose = vi.fn();
    await act(async () => {
      render(<BoxEditorDialog onClose={onClose} />);
    });
    const dialog = document.querySelector(".box-editor")!;
    const nameInput = dialog.querySelector('input[type="text"]') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Renamed" } });
    // Tick p2 into the member list.
    const rows = [...dialog.querySelectorAll(".box-editor-member-row")];
    const p2Row = rows.find((r) => r.textContent?.includes("p2"))!;
    fireEvent.click(p2Row.querySelector("input")!);
    const save = [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Save")!;
    await act(async () => {
      fireEvent.click(save);
    });
    expect(renameBox).toHaveBeenCalledWith("boxA", "Renamed");
    expect(setBoxMembers).toHaveBeenCalledWith("boxA", ["p1", "p2"]);
    expect(onClose).toHaveBeenCalled();
  });

  it("save in CREATE mode commits via boxProjects with the checked members", async () => {
    const boxProjects = vi.fn().mockResolvedValue(box("new", ["p1"]));
    useBoxesStore.setState({ boxes: [], boxProjects });
    useProjectsStore.setState({ projects: [proj("p1", 10)], activeId: null, loaded: true });
    useBoxEditorStore.getState().openCreate(["p1"]);

    const onClose = vi.fn();
    await act(async () => {
      render(<BoxEditorDialog onClose={onClose} />);
    });
    const dialog = document.querySelector(".box-editor")!;
    const save = [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Save")!;
    await act(async () => {
      fireEvent.click(save);
    });
    expect(boxProjects).toHaveBeenCalledWith(["p1"], { name: "New box" });
    expect(onClose).toHaveBeenCalled();
  });

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
