/**
 * The pill menu of a project pinned to its host (remote-only, or a VM): no local
 * copy exists, so every row that acts on one is gone — Show on disk (which would
 * offer to *create* a mirror when none is found), Move project…, Detach SSH host…,
 * Repair scaffold and the IDE rows (markers are read off the mirror). Archive says
 * what is at stake, and Publish… runs on the host (the backend refuses
 * `publishFrom: "local"` for such a project). A plain remote keeps all of it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, fireEvent, screen, cleanup } from "@testing-library/react";

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
import type { ProjectEntry, RemoteSpec } from "../../types";

const SSH: RemoteSpec = { user: "ada", host: "box.example", remote_path: "/srv/app" };

function project(extra: Partial<ProjectEntry>): ProjectEntry {
  return {
    id: "p1",
    name: "Proj",
    status: "active",
    position: 0,
    local_file: "/tmp/state/remote-projects/p1/project.json",
    directory: "/tmp/state/remote-projects/p1",
    git_type: "local",
    ...extra,
  };
}

const PINNED_ROWS = ["Show on disk", "Move project…", "Detach SSH host…", "Repair scaffold files"];

function stub() {
  invoke.mockImplementation((cmd: string) => {
    if (cmd === "detect_project_ides")
      return Promise.resolve([
        {
          id: "pycharm",
          family: "jetbrains",
          label: "PyCharm",
          markerPath: ".idea",
          target: "/x",
          exec: "/usr/bin/pycharm",
          displayName: "PyCharm",
          source: "installed",
          overridden: false,
        },
      ]);
    if (cmd === "list_project_endings") return Promise.resolve([]);
    if (cmd === "get_opened_windows") return Promise.resolve([]);
    return Promise.resolve(null);
  });
}

async function openPillMenu(entry: ProjectEntry) {
  useProjectsStore.setState({ projects: [entry], activeId: "p1", loaded: true });
  let container: HTMLElement;
  await act(async () => {
    ({ container } = render(<ProjectSwitcher open />));
  });
  await act(async () => {
    fireEvent.contextMenu(container!.querySelector(".project-pill") as HTMLElement);
  });
}

const rowLabel = (label: string) =>
  screen.queryAllByRole("button").find((b) => b.textContent?.trim().startsWith(label)) ?? null;

describe("pill menu · a project pinned to its host", () => {
  beforeEach(() => {
    invoke.mockReset();
    stub();
    useBoxesStore.setState({ boxes: [] });
  });
  afterEach(() => cleanup());

  it("keeps every local-copy row on a plain remote project", async () => {
    await openPillMenu(project({ remote: SSH }));
    for (const row of PINNED_ROWS) expect(rowLabel(row), row).toBeTruthy();
    expect(screen.getByText("Open in PyCharm")).toBeTruthy();
  });

  it("hides them on a remote-only project", async () => {
    await openPillMenu(project({ remote: { ...SSH, remote_only: true } }));
    for (const row of PINNED_ROWS) expect(rowLabel(row), row).toBeNull();
    expect(screen.queryByText("Open in PyCharm")).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("detect_project_ides", expect.anything());
    // The cockpit rows stay.
    expect(rowLabel("Show Activity")).toBeTruthy();
  });

  it("hides them on a VM project too (the same posture)", async () => {
    await openPillMenu(project({ remote: { ...SSH, vm: true }, vm: { enabled: true } }));
    for (const row of PINNED_ROWS) expect(rowLabel(row), row).toBeNull();
    expect(screen.queryByText("Open in PyCharm")).toBeNull();
  });

  it("says in the Archive confirm that nothing exists locally", async () => {
    await openPillMenu(project({ remote: { ...SSH, remote_only: true } }));
    await act(async () => {
      fireEvent.click(rowLabel("Delete project…")!);
    });
    expect(
      screen.getByText("No local copy exists. What is not pushed lives only on the host."),
    ).toBeTruthy();
  });

  it("publishes from the host, with no side to choose", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "publish_project") return Promise.resolve("published");
      if (cmd === "list_project_endings" || cmd === "get_opened_windows") return Promise.resolve([]);
      return Promise.resolve(null);
    });
    await openPillMenu(project({ remote: { ...SSH, remote_only: true } }));
    await act(async () => {
      fireEvent.click(rowLabel("Publish to GitHub / GitLab…")!);
    });
    expect(screen.queryByText(/^Publish from/)).toBeNull();
    const dialog = screen.getByRole("dialog");
    const publish = [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Publish");
    await act(async () => {
      fireEvent.click(publish!);
    });
    const call = invoke.mock.calls.find((c) => c[0] === "publish_project");
    expect(call![1]).toMatchObject({ projectId: "p1", publishFrom: "remote" });
  });
});
