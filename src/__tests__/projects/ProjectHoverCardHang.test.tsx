/**
 * The project hover card closes once its pill is no longer under the pointer,
 * even without the pill's own `mouseleave`: the pointer leaving the window, the
 * window losing focus, or the next move landing elsewhere. It used to hang on
 * screen until that pill was hovered and left again.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup, fireEvent } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ startDragging: () => Promise.resolve() }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
  confirm: vi.fn().mockResolvedValue(false),
  message: vi.fn().mockResolvedValue(null),
}));

import { ProjectSwitcher } from "../../components/layout/ProjectSwitcher";
import { useProjectsStore } from "../../stores/projects";
import { useBoxesStore } from "../../stores/boxes";
import type { ProjectEntry } from "../../types";

const project: ProjectEntry = {
  id: "a",
  name: "Project a",
  status: "active",
  position: 0,
  local_file: "/tmp/a/project.json",
  directory: "/tmp/a",
};

const card = () => document.body.querySelector(".project-pill-popup");

async function hoverPill(): Promise<HTMLElement> {
  let container: HTMLElement;
  await act(async () => {
    ({ container } = render(<ProjectSwitcher open />));
  });
  const pill = container!.querySelector<HTMLElement>(".project-pill")!;
  await act(async () => {
    fireEvent.mouseEnter(pill);
  });
  expect(card()).not.toBeNull();
  return pill;
}

describe("project hover card never hangs", () => {
  beforeEach(() => {
    useBoxesStore.setState({ boxes: [] });
    useProjectsStore.setState({ projects: [project], activeId: "a", loaded: true });
  });
  afterEach(cleanup);

  it("stays up while the pointer moves over the pill", async () => {
    const pill = await hoverPill();
    act(() => {
      fireEvent.pointerMove(pill);
    });
    expect(card()).not.toBeNull();
  });

  it("closes when the next move lands outside the pill without a mouseleave", async () => {
    await hoverPill();
    act(() => {
      fireEvent.pointerMove(document.body);
    });
    expect(card()).toBeNull();
  });

  it("closes when the pointer leaves the window", async () => {
    await hoverPill();
    act(() => {
      fireEvent.mouseLeave(document.documentElement);
    });
    expect(card()).toBeNull();
  });

  it("closes when the window loses focus", async () => {
    await hoverPill();
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(card()).toBeNull();
  });
});
