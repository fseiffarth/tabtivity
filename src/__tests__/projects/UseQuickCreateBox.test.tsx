/**
 * `useQuickCreateBox`: name prompt -> create -> enter the box. The one door
 * every "new box" gesture will go through.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ProjectBox, ProjectEntry } from "../../types";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import { useQuickCreateBox } from "../../components/projects/useQuickCreateBox";
import { useBoxesStore } from "../../stores/boxes";
import { resetBoxSlice, useBoxSliceStore } from "../../stores/boxSlice";
import { useProjectsStore } from "../../stores/projects";
import { usePillSelectionStore } from "../../stores/drag/pillSelection";

const proj = (id: string): ProjectEntry => ({ id, name: `Proj ${id}`, status: "active", position: 10, local_file: `/p/${id}/project.json` });
const box = (id: string, name: string, members: string[] = []): ProjectBox => ({ id, name, member_ids: members, position: 1 });

let result: Promise<ProjectBox | null> | null = null;

function Host({ members }: { members?: string[] }) {
  const { quickCreateBox, dialogs } = useQuickCreateBox();
  return (
    <>
      <button onClick={() => (result = quickCreateBox(members))}>go</button>
      {dialogs}
    </>
  );
}

const openBox = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  cleanup();
  result = null;
  invoke.mockReset();
  invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) =>
    cmd === "create_box" ? Promise.resolve(box("new1", args?.name as string, (args?.memberIds as string[]) ?? [])) : Promise.resolve(undefined),
  );
  openBox.mockClear();
  resetBoxSlice();
  useBoxesStore.setState({ boxes: [box("a", "Box 1"), box("b", "Thesis")], loaded: true, openBox });
  useProjectsStore.setState({ projects: [proj("p1"), proj("p2")] });
  usePillSelectionStore.setState({ selected: [] });
});

const field = () => screen.getByRole("textbox") as HTMLInputElement;

describe("useQuickCreateBox", () => {
  it("pre-fills the next free Box N, creates on Enter and enters the new box", async () => {
    render(<Host />);
    fireEvent.click(screen.getByText("go"));
    await waitFor(() => expect(field().value).toBe("Box 2"));
    await act(async () => {
      fireEvent.keyDown(field(), { key: "Enter" });
    });
    const made = await result;
    expect(invoke).toHaveBeenCalledWith("create_box", { name: "Box 2" });
    expect(made?.id).toBe("new1");
    expect(openBox).toHaveBeenCalledWith("new1");
    expect(useBoxSliceStore.getState().sliceBoxId).toBe("new1");
  });

  it("creates the box holding the given projects, names them in the prompt and clears the pill selection", async () => {
    usePillSelectionStore.setState({ selected: ["p1", "p2"] });
    render(<Host members={["p1", "p2"]} />);
    fireEvent.click(screen.getByText("go"));
    await waitFor(() => screen.getByText(/Proj p1, Proj p2/));
    fireEvent.change(field(), { target: { value: "  Pair " } });
    await act(async () => {
      fireEvent.keyDown(field(), { key: "Enter" });
    });
    await result;
    expect(invoke).toHaveBeenCalledWith("create_box", { name: "Pair", memberIds: ["p1", "p2"] });
    expect(usePillSelectionStore.getState().selected).toEqual([]);
  });

  it("keeps the prompt open with the reason for a taken name, and creates nothing", async () => {
    render(<Host />);
    fireEvent.click(screen.getByText("go"));
    await waitFor(() => field());
    fireEvent.change(field(), { target: { value: "thesis" } });
    await act(async () => {
      fireEvent.keyDown(field(), { key: "Enter" });
    });
    expect(screen.getByRole("alert").textContent).toMatch(/already exists/i);
    expect(invoke).not.toHaveBeenCalled();
    expect(openBox).not.toHaveBeenCalled();
  });

  it("keeps the prompt open when the write fails", async () => {
    invoke.mockRejectedValue("disk full");
    render(<Host />);
    fireEvent.click(screen.getByText("go"));
    await waitFor(() => field());
    await act(async () => {
      fireEvent.keyDown(field(), { key: "Enter" });
    });
    expect(screen.getByRole("alert").textContent).toMatch(/disk full/);
    expect(openBox).not.toHaveBeenCalled();
  });

  it("resolves null when the prompt is dismissed", async () => {
    render(<Host />);
    fireEvent.click(screen.getByText("go"));
    await waitFor(() => field());
    await act(async () => {
      fireEvent.click(screen.getByText("Cancel"));
    });
    expect(await result).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });
});
