/**
 * Steering's jump key: `/` opens the jump box (`SteeringProjectJump`) — a
 * search field in the window's middle. Before a letter is typed the ring holds
 * the open projects, most recently used first, then recently used inactive
 * ones, never the active one. Ten results or fewer sit on a ring, each on a
 * digit (1–9, then 0) that opens it at once; more are a list. A pick switches
 * or activates, and steering comes back on the level the jump started from. The
 * header's `ProjectSearch` keeps the ordinary search over the same rows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFullscreen: vi.fn().mockResolvedValue(false),
    setFullscreen: vi.fn(),
  }),
}));

import { useKeyboard } from "../../hooks/useKeyboard";
import { ProjectSearch } from "../../components/projects/ProjectSearch";
import { SteeringProjectJump } from "../../components/layout/SteeringProjectJump";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { useSettingsStore } from "../../stores/settings";
import { useProjectsStore } from "../../stores/projects";
import { useBoxesStore } from "../../stores/boxes";
import { useBoxSliceStore } from "../../stores/boxSlice";
import { noteProjectUsed } from "../../lib/projects/projectRecency";
import { jumpStartRows } from "../../lib/projects/projectSearchRows";
import type { ProjectBox, ProjectEntry } from "../../types";

function Harness() {
  useKeyboard({ onTogglePanels: () => {} });
  return null;
}

function press(init: Partial<KeyboardEventInit> & { key: string }) {
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  });
}

const steering = () => useKeyboardSteeringStore.getState();

const PROJECTS = [
  { id: "alpha", name: "Alpha", status: "current", position: 0, local_file: "/alpha/project.json" },
  { id: "beta", name: "Beta", status: "active", position: 1, local_file: "/beta/project.json" },
  { id: "bench", name: "Bench", status: "inactive", position: 2, local_file: "/bench/project.json" },
] as unknown as ProjectEntry[];

const BOXES = [
  { id: "lab", name: "Beta Box", position: 0, member_ids: ["alpha"] },
] as unknown as ProjectBox[];

/** Twelve inactive projects: "p" matches all of them, past the ring's ten. */
const MANY = Array.from({ length: 12 }, (_, i) => ({
  id: `p${i}`,
  name: `Proj ${String.fromCharCode(65 + i)}`,
  status: "inactive",
  position: 10 + i,
  local_file: `/p${i}/project.json`,
})) as unknown as ProjectEntry[];

function renderJump(projects: ProjectEntry[] = PROJECTS, boxes: ProjectBox[] = []) {
  const setActive = vi.fn().mockResolvedValue(undefined);
  const selectBox = vi.fn().mockResolvedValue(undefined);
  useProjectsStore.setState({ projects, setActive, activeId: projects.find((p) => p.status === "current")?.id ?? null });
  useBoxesStore.setState({ boxes });
  useBoxSliceStore.setState({ sliceBoxId: null, selectBox });
  render(
    <>
      <Harness />
      <SteeringProjectJump />
    </>,
  );
  return { setActive, selectBox };
}

const field = () => document.querySelector<HTMLInputElement>(".steering-jump-input");
const slots = () =>
  Array.from(document.querySelectorAll<HTMLElement>(".steering-jump-slot")).map((el) => el.textContent);
const typeQuery = (value: string) => fireEvent.change(field()!, { target: { value } });
const key = (k: string) => fireEvent.keyDown(field()!, { key: k });

function openJump(level: "projects" | "panes" | "tabs" = "tabs") {
  act(() => {
    steering().enter();
    if (level !== "tabs") steering().setLevel(level);
  });
  press({ key: "/" });
}

const ORIGINAL = {
  projects: useProjectsStore.getState(),
  boxes: useBoxesStore.getState(),
  slice: useBoxSliceStore.getState(),
};

beforeEach(() => {
  localStorage.clear();
  useSettingsStore.setState({ settings: null });
  useKeyboardSteeringStore.getState().exit();
});

afterEach(() => {
  cleanup();
  useProjectsStore.setState(ORIGINAL.projects, true);
  useBoxesStore.setState(ORIGINAL.boxes, true);
  useBoxSliceStore.setState(ORIGINAL.slice, true);
  vi.restoreAllMocks();
});

describe("steering project jump", () => {
  it("opens the box with the field focused and the other open projects on the ring", () => {
    renderJump();
    openJump("projects");
    expect(steering().active).toBe(false);
    expect(document.activeElement).toBe(field());
    // Nothing typed yet: the open projects but the active one; an inactive
    // project never used stays out.
    expect(slots()).toEqual(["1Beta"]);
    expect(document.querySelector(".steering-jump-stage.is-ring")).not.toBeNull();
  });

  it("rings recently used projects before a letter is typed, newest first", () => {
    const projects = [
      ...PROJECTS,
      { id: "gamma", name: "Gamma", status: "active", position: 3, local_file: "/gamma/project.json" },
      { id: "old", name: "Old", status: "inactive", position: 4, local_file: "/old/project.json" },
    ] as unknown as ProjectEntry[];
    noteProjectUsed("beta");
    noteProjectUsed("bench");
    noteProjectUsed("gamma");
    renderJump(projects);
    // Mounting records the active project as the newest.
    openJump();
    // Open ones first (Gamma used after Beta), then the inactive Bench that was
    // used; Old, never used, waits for a letter.
    expect(slots()).toEqual(["1Gamma", "2Beta", "3Bench"]);
  });

  it("caps the start ring at ten, open projects before recent inactive ones", () => {
    const rows = jumpStartRows({
      projects: [...MANY, ...PROJECTS],
      recentIds: ["p0", "p1", "beta"],
      activeId: "alpha",
      limit: 10,
    });
    expect(rows.map((row) => (row.kind === "project" ? row.project.id : row.kind))).toEqual(["beta", "p0", "p1"]);
  });

  it("a digit opens its slot at once and lands on the new project's tabs", () => {
    const { setActive } = renderJump();
    openJump("projects");
    key("1");
    expect(setActive).toHaveBeenCalledWith("beta");
    expect(field()).toBeNull();
    expect(steering()).toMatchObject({ active: true, level: "tabs" });
  });

  it("numbers the ring 1–9 then 0, and 0 opens the tenth", () => {
    const { setActive } = renderJump(MANY.slice(0, 10));
    openJump();
    typeQuery("proj");
    expect(slots().map((text) => text?.[0])).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]);
    key("0");
    expect(setActive).toHaveBeenCalledWith("p9");
  });

  it("a digit with no slot behind it is left to the field", () => {
    const { setActive } = renderJump();
    openJump();
    const event = new KeyboardEvent("keydown", { key: "7", bubbles: true, cancelable: true });
    act(() => {
      field()!.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(setActive).not.toHaveBeenCalled();
  });

  it("more than ten results are a list, where digits type and Enter picks", () => {
    const { setActive } = renderJump(MANY);
    openJump();
    typeQuery("proj");
    expect(document.querySelector(".steering-jump-stage.is-ring")).toBeNull();
    expect(slots()).toEqual([]);
    expect(screen.getAllByRole("option")).toHaveLength(12);
    const event = new KeyboardEvent("keydown", { key: "1", bubbles: true, cancelable: true });
    act(() => {
      field()!.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    // The field survives the ring → list switch with its focus.
    expect(document.activeElement).toBe(field());
    key("ArrowDown");
    key("Enter");
    expect(setActive).toHaveBeenCalledWith("p1");
  });

  it("activates an inactive pick by name and Enter", () => {
    const { setActive } = renderJump();
    openJump("projects");
    typeQuery("be");
    expect(slots()).toEqual(["1Beta", "2Bench"]);
    key("ArrowDown");
    key("Enter");
    expect(setActive).toHaveBeenCalledWith("bench");
    expect(steering()).toMatchObject({ active: true, level: "tabs" });
  });

  it("picking the current project switches nothing and returns to the level it came from", () => {
    const { setActive } = renderJump();
    openJump("projects");
    typeQuery("alpha");
    key("Enter");
    expect(setActive).not.toHaveBeenCalled();
    expect(steering()).toMatchObject({ active: true, level: "projects" });
  });

  it("a box on the ring slices it", () => {
    const { selectBox, setActive } = renderJump(PROJECTS, BOXES);
    openJump();
    typeQuery("beta");
    expect(slots()).toEqual(["1Beta", "2Beta Box"]);
    key("2");
    expect(selectBox).toHaveBeenCalledWith("lab");
    expect(setActive).not.toHaveBeenCalled();
  });

  it("Escape goes back to steering without switching", () => {
    const { setActive } = renderJump();
    openJump("panes");
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(field()).toBeNull();
    expect(setActive).not.toHaveBeenCalled();
    expect(steering()).toMatchObject({ active: true, level: "panes" });
  });

  it("stays in steering when no jump box is mounted", () => {
    render(<Harness />);
    act(() => steering().enter());
    press({ key: "/" });
    expect(steering()).toMatchObject({ active: true, level: "tabs" });
  });
});

describe("header project search", () => {
  function renderSearch(boxes: ProjectBox[] = []) {
    const onActivateProject = vi.fn();
    const onOpenBox = vi.fn();
    render(<ProjectSearch projects={PROJECTS} boxes={boxes} onActivateProject={onActivateProject} onOpenBox={onOpenBox} />);
    return { onActivateProject, onOpenBox, input: document.querySelector<HTMLInputElement>(".project-search-entry")! };
  }
  const rowNames = () =>
    Array.from(document.querySelectorAll(".project-search-row .project-search-name")).map(
      (el) => el.firstChild?.textContent,
    );

  it("keeps an empty ordinary query closed and orders open projects, boxes, then inactive projects", () => {
    const { input, onActivateProject, onOpenBox } = renderSearch(BOXES);
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("[role=listbox]")).toBeNull();

    fireEvent.change(input, { target: { value: "be" } });
    expect(input.getAttribute("aria-expanded")).toBe("true");
    const listbox = screen.getByRole("listbox");
    const options = Array.from(listbox.querySelectorAll<HTMLElement>("[role=option]"));
    expect(options.map((option) => option.textContent?.trim())).toEqual([
      expect.stringContaining("Beta"),
      expect.stringContaining("Beta Box"),
      expect.stringContaining("Bench"),
    ]);
    expect(rowNames()).toEqual(["Beta", "Bench"]);
    expect(screen.getByText("open")).toBeTruthy();
    expect(input.getAttribute("aria-controls")).toBe(listbox.id);
    expect(input.getAttribute("aria-activedescendant")).toBe(options[0].id);
    expect(options.map((option) => option.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe(options[1].id);
    expect(screen.getByRole("status").textContent).toContain("Beta Box");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpenBox).toHaveBeenCalledWith("lab");
    expect(onActivateProject).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-expanded")).toBe("false");
  });

});
