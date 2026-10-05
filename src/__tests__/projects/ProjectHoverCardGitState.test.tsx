/**
 * The pending git state lives in the project hover card, not in a separate
 * tooltip on the pill's folder icon: one hover shows everything.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";

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

import { ProjectHoverCard, type ProjectHoverState } from "../../components/projects/ProjectHoverCard";
import { ProjectSwitcher } from "../../components/layout/ProjectSwitcher";
import { useGitDirtyStore } from "../../stores/gitDirty";
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

const openState: ProjectHoverState = {
  popupPos: { x: 10, y: 10, alignment: "center" },
  timeToday: null,
  cpu: null,
  scaffoldMissing: false,
  isLiveProject: false,
  timerPaused: false,
  open: async () => {},
  close: () => {},
};

function gitLine(): HTMLElement | null {
  return document.body.querySelector(".project-pill-popup .pill-popup-git");
}

describe("project hover card git state", () => {
  beforeEach(() => {
    useGitDirtyStore.setState({ byId: {} });
  });

  it("names committed-but-unpushed work", () => {
    useGitDirtyStore.setState({ byId: { a: "unpushed" } });
    const { unmount } = render(<ProjectHoverCard project={project} state={openState} showTags={false} />);
    expect(gitLine()?.textContent).toBe("Committed — not yet pushed");
    expect(gitLine()?.classList.contains("git-unpushed")).toBe(true);
    unmount();
  });

  it("names uncommitted, not-yet-added changes", () => {
    useGitDirtyStore.setState({ byId: { a: "dirty" } });
    const { unmount } = render(<ProjectHoverCard project={project} state={openState} showTags={false} />);
    expect(gitLine()?.textContent).toBe("Uncommitted changes — not yet added");
    unmount();
  });

  // #2349: an errored probe is its own state, never drawn as clean.
  it("names a git status it could not read, and the pill wears the hollow mark", async () => {
    useGitDirtyStore.setState({ byId: { a: "unknown" } });
    const card = render(<ProjectHoverCard project={project} state={openState} showTags={false} />);
    expect(gitLine()?.textContent).toBe("Git status unavailable");
    expect(gitLine()?.classList.contains("git-unknown")).toBe(true);
    card.unmount();

    useBoxesStore.setState({ boxes: [] });
    useProjectsStore.setState({ projects: [project], activeId: "a", loaded: true });
    let container: HTMLElement;
    await act(async () => {
      ({ container } = render(<ProjectSwitcher open />));
    });
    const icon = container!.querySelector(".pill-folder-icon");
    expect(icon?.classList.contains("git-unknown")).toBe(true);
    expect(icon?.classList.contains("git-clean")).toBe(false);
  });

  it("shows no git line for a clean or unprobed project", () => {
    useGitDirtyStore.setState({ byId: { a: "clean" } });
    const first = render(<ProjectHoverCard project={project} state={openState} showTags={false} />);
    expect(gitLine()).toBeNull();
    first.unmount();
    useGitDirtyStore.setState({ byId: {} });
    const second = render(<ProjectHoverCard project={project} state={openState} showTags={false} />);
    expect(gitLine()).toBeNull();
    second.unmount();
  });

  it("the pill's folder icon carries no separate tooltip", async () => {
    useBoxesStore.setState({ boxes: [] });
    useProjectsStore.setState({ projects: [project], activeId: "a", loaded: true });
    useGitDirtyStore.setState({ byId: { a: "unpushed" } });
    let container: HTMLElement;
    await act(async () => {
      ({ container } = render(<ProjectSwitcher open />));
    });
    const icon = container!.querySelector(".pill-folder-icon");
    expect(icon).not.toBeNull();
    expect(icon!.hasAttribute("title")).toBe(false);
  });
});
