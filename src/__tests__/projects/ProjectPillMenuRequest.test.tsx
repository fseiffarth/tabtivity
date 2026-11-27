/**
 * The pill menu asked for from outside the pill (`stores/pillMenuRequest`, the
 * side panel's project name): that project's pill opens its own menu once,
 * and a request for another project opens nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, screen } from "@testing-library/react";

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
import { usePillMenuRequestStore } from "../../stores/pillMenuRequest";

const PROJECT = {
  id: "p1",
  name: "Py",
  status: "active" as const,
  position: 0,
  local_file: "/tmp/p1/project.json",
  directory: "/tmp/p1",
  git_type: "local",
};

function stub() {
  invoke.mockImplementation((cmd: string) => {
    if (cmd === "detect_project_ides") return Promise.resolve([]);
    if (cmd === "list_project_endings") return Promise.resolve([]);
    if (cmd === "get_opened_windows") return Promise.resolve([]);
    return Promise.resolve(null);
  });
}

describe("pill menu · opened by request", () => {
  beforeEach(() => {
    invoke.mockReset();
    stub();
    usePillMenuRequestStore.setState({ request: null });
    useBoxesStore.setState({ boxes: [] });
    useProjectsStore.setState({ projects: [PROJECT], activeId: "p1", loaded: true });
  });

  it("opens the named project's pill menu and clears the request", async () => {
    await act(async () => {
      render(<ProjectSwitcher open />);
    });
    expect(screen.queryByText("Show on disk")).toBeNull();
    await act(async () => {
      usePillMenuRequestStore.getState().open({ projectId: "p1", x: 40, y: 60 });
    });
    expect(screen.getByText("Show on disk")).toBeTruthy();
    expect(usePillMenuRequestStore.getState().request).toBeNull();
  });

  it("leaves a request for another project alone", async () => {
    await act(async () => {
      render(<ProjectSwitcher open />);
    });
    await act(async () => {
      usePillMenuRequestStore.getState().open({ projectId: "other", x: 40, y: 60 });
    });
    expect(screen.queryByText("Show on disk")).toBeNull();
    expect(usePillMenuRequestStore.getState().request?.projectId).toBe("other");
  });
});
