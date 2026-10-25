/**
 * "Open in <IDE>" rows in the pill menu (`IdeMenuItems`): one per candidate
 * the backend detects, a "(not found)" suffix on one without a launcher, no
 * rows at all for a project without markers, and a click that launches by IDE
 * id — the exec is never sent from here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, fireEvent, screen } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
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
import { useRemoteMachinesStore } from "../../stores/remote/remoteMachines";
import type { IdeCandidate } from "../../components/projects/IdeMenuItems";

const PROJECT = {
  id: "p1",
  name: "Py",
  status: "active" as const,
  position: 0,
  local_file: "/tmp/p1/project.json",
  directory: "/tmp/p1",
  git_type: "local",
};

const PYCHARM: IdeCandidate = {
  id: "pycharm",
  family: "jetbrains",
  label: "PyCharm",
  markerPath: ".idea",
  target: "/tmp/p1",
  exec: "/usr/bin/pycharm",
  displayName: "PyCharm Professional",
  source: "installed",
  overridden: false,
};

const VS: IdeCandidate = {
  id: "visual_studio",
  family: "visual_studio",
  label: "Visual Studio",
  markerPath: "App.sln",
  target: "/tmp/p1/App.sln",
  exec: null,
  displayName: null,
  source: null,
  overridden: false,
};

function stub(ides: IdeCandidate[]) {
  invoke.mockImplementation((cmd: string) => {
    if (cmd === "detect_project_ides") return Promise.resolve(ides);
    if (cmd === "list_project_endings") return Promise.resolve([]);
    if (cmd === "get_opened_windows") return Promise.resolve([]);
    return Promise.resolve(null);
  });
}

async function openPillMenu() {
  let container: HTMLElement;
  await act(async () => {
    ({ container } = render(<ProjectSwitcher open />));
  });
  const pill = container!.querySelector(".project-pill") as HTMLElement;
  await act(async () => {
    fireEvent.contextMenu(pill);
  });
}

describe("pill menu · Open in <IDE>", () => {
  beforeEach(() => {
    invoke.mockReset();
    useBoxesStore.setState({ boxes: [] });
    useProjectsStore.setState({ projects: [PROJECT], activeId: "p1", loaded: true });
  });

  it("lists one row per detected IDE, marking a missing launcher", async () => {
    stub([PYCHARM, VS]);
    await openPillMenu();
    expect(invoke).toHaveBeenCalledWith("detect_project_ides", { projectId: "p1" });
    expect(screen.getByText("Open in PyCharm Professional")).toBeTruthy();
    expect(screen.getByText("Open in Visual Studio (not found)")).toBeTruthy();
    expect(screen.queryByText("Use the detected PyCharm")).toBeNull();
  });

  it("closes the menu when the Remote machines manager opens by another route", async () => {
    stub([PYCHARM]);
    await openPillMenu();
    expect(screen.getByText("Open in PyCharm Professional")).toBeTruthy();
    await act(async () => {
      useRemoteMachinesStore.getState().open("p1");
    });
    expect(screen.queryByText("Open in PyCharm Professional")).toBeNull();
    useRemoteMachinesStore.getState().close();
  });

  it("shows no IDE rows for a project without markers", async () => {
    stub([]);
    await openPillMenu();
    expect(screen.getByText("Show on disk")).toBeTruthy();
    expect(screen.queryByText(/^Open in /)).toBeNull();
  });

  it("launches by IDE id and refreshes the project's windows", async () => {
    stub([PYCHARM]);
    await openPillMenu();
    await act(async () => {
      fireEvent.click(screen.getByText("Open in PyCharm Professional"));
    });
    expect(invoke).toHaveBeenCalledWith("open_project_in_ide", { projectId: "p1", ideId: "pycharm" });
    expect(invoke).toHaveBeenCalledWith("get_opened_windows", { projectId: "p1" });
    expect(screen.queryByText("Open in PyCharm Professional")).toBeNull();
  });

  it("offers to go back to detection for an overridden launcher", async () => {
    stub([{ ...PYCHARM, overridden: true, source: "override" }]);
    await openPillMenu();
    await act(async () => {
      fireEvent.click(screen.getByText("Use the detected PyCharm"));
    });
    expect(invoke).toHaveBeenCalledWith("set_ide_launcher", { ideId: "pycharm", exec: null });
  });
});
