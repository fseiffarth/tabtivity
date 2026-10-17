/**
 * Steering's jump key: `/` hands the keyboard to the header project search in
 * jump mode, which lists the open projects too (first, and all of them before
 * anything is typed); a pick switches or activates, and steering comes back on
 * the level the jump started from.
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
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { useSettingsStore } from "../../stores/settings";
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

function renderSearch(boxes: ProjectBox[] = []) {
  const onActivateProject = vi.fn();
  const onOpenBox = vi.fn();
  render(
    <>
      <Harness />
      <ProjectSearch projects={PROJECTS} boxes={boxes} onActivateProject={onActivateProject} onOpenBox={onOpenBox} />
    </>,
  );
  return { onActivateProject, onOpenBox, input: document.querySelector<HTMLInputElement>(".project-search-entry")! };
}

const rowNames = () =>
  Array.from(document.querySelectorAll(".project-search-row .project-search-name")).map(
    (el) => el.firstChild?.textContent,
  );

beforeEach(() => {
  useSettingsStore.setState({ settings: null });
  useKeyboardSteeringStore.getState().exit();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("steering project jump", () => {
  it("lists the open projects first, activates an inactive pick and lands on its tabs", () => {
    const { onActivateProject, input } = renderSearch();
    act(() => {
      steering().enter();
      steering().setLevel("projects");
    });
    press({ key: "/" });
    expect(steering().active).toBe(false);
    expect(document.activeElement).toBe(input);
    // Nothing typed yet: every open project, the inactive ones stay out.
    expect(rowNames()).toEqual(["Alpha", "Beta"]);
    expect(screen.getAllByText("open")).toHaveLength(2);

    fireEvent.change(input, { target: { value: "be" } });
    expect(rowNames()).toEqual(["Beta", "Bench"]);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onActivateProject).toHaveBeenCalledWith("bench");
    expect(steering()).toMatchObject({ active: true, level: "tabs" });
    expect(input.value).toBe("");
  });

  it("switches to an open project and returns to the tabs level it came from", () => {
    const { onActivateProject, input } = renderSearch();
    act(() => steering().enter());
    press({ key: "/" });
    fireEvent.change(input, { target: { value: "beta" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onActivateProject).toHaveBeenCalledWith("beta");
    expect(steering()).toMatchObject({ active: true, level: "tabs" });
  });

  it("picking the current project switches nothing and returns to the level it came from", () => {
    const { onActivateProject, input } = renderSearch();
    act(() => {
      steering().enter();
      steering().setLevel("projects");
    });
    press({ key: "/" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onActivateProject).not.toHaveBeenCalled();
    expect(steering()).toMatchObject({ active: true, level: "projects" });
  });

  it("Escape goes back to steering without switching, and the box forgets jump mode", () => {
    const { onActivateProject, input } = renderSearch();
    act(() => {
      steering().enter();
      steering().setLevel("panes");
    });
    press({ key: "/" });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onActivateProject).not.toHaveBeenCalled();
    expect(steering()).toMatchObject({ active: true, level: "panes" });
    // Plain use of the box again includes open projects too.
    fireEvent.change(input, { target: { value: "be" } });
    expect(rowNames()).toEqual(["Beta", "Bench"]);
  });

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

  it("stays in steering when no project search is mounted", () => {
    render(<Harness />);
    act(() => steering().enter());
    press({ key: "/" });
    expect(steering()).toMatchObject({ active: true, level: "tabs" });
  });
});
