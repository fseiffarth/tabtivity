/**
 * The command palette: what it lists, in what order, and what a pick does. The
 * doors are the chord, Quick open's chord on the `#` filter, and the window
 * event the menus fire. It must leave Ctrl+K to a focused field or terminal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (cmd: string) =>
    cmd === "list_project_paths" ? [{ path: "src/main.rs", is_dir: false }, { path: "src", is_dir: true }] : null,
  ),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("../../lib/shortcuts/tabJump", () => ({ jumpToTab: vi.fn() }));
vi.mock("../../components/embed/fileViewer/openLinked", () => ({
  openLinkedFile: vi.fn(),
  viewerForPath: () => "code",
}));

import { CommandPalette, OPEN_PALETTE_EVENT } from "../../components/layout/CommandPalette";
import { QuickOpen } from "../../components/files/QuickOpen";
import { openLinkedFile } from "../../components/embed/fileViewer/openLinked";
import { jumpToTab } from "../../lib/shortcuts/tabJump";
import { useProjectsStore } from "../../stores/projects";
import { useTabsStore } from "../../stores/tabs";
import { useBoxesStore } from "../../stores/boxes";
import { resetBoxSlice, useBoxSliceStore } from "../../stores/boxSlice";
import type { TabEntry } from "../../stores/tabs/types";

const tab = (key: string, label: string): TabEntry => ({ key, label, cmd: "", cwd: "/p", kind: "shell", scope: "p1" });

const openPalette = (detail?: { filter: string }) =>
  act(async () => {
    window.dispatchEvent(new CustomEvent(OPEN_PALETTE_EVENT, { detail }));
  });
const groups = () => [...document.querySelectorAll(".command-palette-group")].map((el) => el.textContent);
const rows = () => [...document.querySelectorAll(".command-palette-row")];
const type = (value: string) => fireEvent.change(screen.getByRole("textbox"), { target: { value } });

beforeEach(() => {
  resetBoxSlice();
  useBoxesStore.setState({ boxes: [], loaded: true });
  useProjectsStore.setState({
    projects: [{ id: "p1", name: "Alpha", directory: "/p" } as never, { id: "p2", name: "Beta", directory: "/q" } as never],
    activeId: "p1",
    loaded: true,
  });
  useTabsStore.setState({ scope: "p1", tabs: [tab("t1", "build log")], tabsByScope: { p1: [tab("t1", "build log")] } });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CommandPalette", () => {
  it("lists its groups in order, with settings only once something is typed", async () => {
    render(<CommandPalette />);
    await openPalette();
    expect(groups()).toEqual(["Tabs", "Projects", "Files in Alpha", "Actions"]);
    type("theme");
    expect(groups()).toContain("Settings");
  });

  it("opens on the file filter from Quick open's chord and lists files alone", async () => {
    render(<QuickOpen />);
    await act(async () => {
      fireEvent.keyDown(window, { key: "p", ctrlKey: true });
    });
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("#");
    expect(groups()).toEqual(["Files in Alpha"]);
    expect(rows().map((row) => row.textContent)).toEqual(["src/main.rs"]);
  });

  it("opens the file a filtered Enter lands on, and closes", async () => {
    render(<CommandPalette />);
    await openPalette({ filter: "#main" });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(openLinkedFile).toHaveBeenCalledWith(
      undefined,
      "/p",
      expect.objectContaining({ label: "main.rs" }),
    );
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("jumps to a tab across scopes", async () => {
    useTabsStore.setState({ tabsByScope: { p1: [tab("t1", "build log")], p2: [tab("t2", "deploy log")] } });
    render(<CommandPalette />);
    await openPalette();
    type("deploy");
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(jumpToTab).toHaveBeenCalledWith("p2", "t2");
  });

  it("shows an action's live chord from the shortcut table", async () => {
    render(<CommandPalette />);
    await openPalette();
    type("close tab");
    const row = rows().find((el) => el.textContent?.includes("Close"));
    expect(row?.querySelector("kbd")?.textContent).toMatch(/W$/i);
  });

  it("takes the chord from the page, and leaves it to a focused field", async () => {
    render(
      <>
        <CommandPalette />
        <textarea data-testid="field" />
      </>,
    );
    fireEvent.keyDown(screen.getByTestId("field"), { key: "k", ctrlKey: true });
    expect(document.querySelector(".command-palette")).toBeNull();
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    });
    expect(document.querySelector(".command-palette")).toBeTruthy();
  });

  it("closes on Escape", async () => {
    render(<CommandPalette />);
    await openPalette();
    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(document.querySelector(".command-palette")).toBeNull();
  });

  it("in a popout lists that window's tabs alone and activates there", async () => {
    const activate = vi.fn();
    render(<CommandPalette local={{ tabs: [tab("t9", "popout shell")], scope: "p1", activate }} />);
    await openPalette();
    expect(groups()).toEqual(["Tabs"]);
    expect(invokeMock).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(activate).toHaveBeenCalledWith("t9");
  });
});

describe("CommandPalette boxes", () => {
  const box = (id: string, name: string, members: string[], position = 1) => ({ id, name, member_ids: members, position });

  it("lists the boxes in a group of their own, after the projects", async () => {
    useBoxesStore.setState({ boxes: [box("b1", "Thesis", ["p1", "p2"]), box("b2", "Infra", ["p2"], 2)] });
    render(<CommandPalette />);
    await openPalette();
    expect(groups()).toEqual(["Tabs", "Projects", "Boxes", "Files in Alpha", "Actions"]);
    const boxRows = rows().filter((r) => r.querySelector(".box-swatch"));
    expect(boxRows.map((r) => r.querySelector(".command-palette-label")?.textContent)).toEqual(["Thesis", "Infra"]);
    expect(boxRows[0].querySelector(".command-palette-detail")?.textContent).toBe("Box · 2 members");
  });

  it("opens a box with Enter: slices the strip and enters its scope", async () => {
    const openBox = vi.fn().mockResolvedValue(undefined);
    useBoxesStore.setState({ boxes: [box("b1", "Thesis", ["p1"])], openBox });
    render(<CommandPalette />);
    await openPalette();
    type("thesis");
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    });
    expect(openBox).toHaveBeenCalledWith("b1");
    expect(useBoxSliceStore.getState().sliceBoxId).toBe("b1");
    expect(document.querySelector(".command-palette")).toBeNull();
  });

  it("offers New box… and asks for a name once picked", async () => {
    render(<CommandPalette />);
    await openPalette();
    type("new box");
    const row = rows().find((r) => r.textContent?.includes("New box…"));
    expect(row).toBeTruthy();
    await act(async () => {
      fireEvent.mouseDown(row as Element);
    });
    expect(document.querySelector(".command-palette")).toBeNull();
    // The name prompt outlives the palette and is pre-filled with the next free name.
    await vi.waitFor(() => expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("Box 1"));
  });

  it("offers Show all projects only while a box is sliced, and it leaves the box", async () => {
    useBoxesStore.setState({ boxes: [box("b1", "Thesis", ["p1"])] });
    render(<CommandPalette />);
    await openPalette();
    type("show all");
    expect(rows().some((r) => r.textContent?.includes("Show all projects"))).toBe(false);
    cleanup();

    useBoxSliceStore.setState({ sliceBoxId: "b1" });
    render(<CommandPalette />);
    await openPalette();
    type("show all");
    const row = rows().find((r) => r.textContent?.includes("Show all projects"));
    expect(row).toBeTruthy();
    await act(async () => {
      fireEvent.mouseDown(row as Element);
    });
    expect(useBoxSliceStore.getState().sliceBoxId).toBeNull();
  });

  it("adds the current project to a box it is not in, once something is typed", async () => {
    const addToBox = vi.fn().mockResolvedValue(undefined);
    useBoxesStore.setState({ boxes: [box("b1", "Thesis", ["p2"]), box("b2", "Infra", ["p1"], 2)], addToBox });
    render(<CommandPalette />);
    await openPalette();
    // Blank: no per-box rows crowding the list.
    expect(rows().some((r) => r.textContent?.includes("Add Alpha to"))).toBe(false);
    type("add alpha");
    const adds = rows().filter((r) => r.textContent?.includes("Add Alpha to"));
    // Alpha is already in Infra: only Thesis is offered.
    expect(adds.map((r) => r.textContent)).toEqual(["Add Alpha to Thesis"]);
    await act(async () => {
      fireEvent.mouseDown(adds[0]);
    });
    expect(addToBox).toHaveBeenCalledWith("p1", "b1");
  });

  it("names the box on a box-scope tab row", async () => {
    useBoxesStore.setState({ boxes: [box("b1", "Thesis", ["p1"])] });
    useTabsStore.setState({
      tabsByScope: { p1: [tab("t1", "build log")], "box:b1": [{ ...tab("t3", "box shell"), scope: "box:b1" }] },
    });
    render(<CommandPalette />);
    await openPalette();
    type("box shell");
    const row = rows().find((r) => r.textContent?.includes("box shell"));
    expect(row?.querySelector(".command-palette-detail")?.textContent).toBe("Thesis");
  });
});
