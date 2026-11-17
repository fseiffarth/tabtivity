/**
 * A `git_file_statuses` that fails is said in the tree, not shown as a folder
 * with nothing modified or ignored — for a project that should be a repo. A
 * git-less project on a host without git gets no note.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("../../stores/projects", () => ({ useProjectsStore: vi.fn() }));
vi.mock("../../stores/windows", () => ({
  useWindowsStore: () => ({ windows: [], refresh: vi.fn(), untrack: vi.fn(), closeApp: vi.fn() }),
}));
vi.mock("../../stores/settings", () => {
  const state = { settings: null, updateSettings: async () => {} };
  return {
    useSettingsStore: (selector?: (s: typeof state) => unknown) =>
      selector ? selector(state) : state,
  };
});

import { useProjectsStore } from "../../stores/projects";
import { SidePanel } from "../../components/layout/SidePanel";

const mockUseProjectsStore = vi.mocked(useProjectsStore);

const GIT_ERROR = "fatal: index file corrupt";

function useProject(gitType: string) {
  const state = {
    projects: [{
      id: "proj-1",
      name: "TestProject",
      status: "active",
      position: 0,
      local_file: "/tmp/test-project/project.json",
      git_type: gitType,
    }],
    activeId: "proj-1",
    sidePanelFolderByProject: {},
    setSidePanelFolder: vi.fn(),
  } as unknown as ReturnType<typeof useProjectsStore>;
  mockUseProjectsStore.mockImplementation(((selector?: (s: typeof state) => unknown) =>
    selector ? selector(state) : state) as typeof useProjectsStore);
}

function setupInvoke() {
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "list_dir") {
      return Promise.resolve([
        { name: "a.txt", path: "/tmp/test-project/a.txt", is_dir: false, size: 1, extension: ".txt", mime: null },
      ]);
    }
    if (cmd === "git_file_statuses") return Promise.reject(GIT_ERROR);
    if (cmd === "git_status") return Promise.reject(GIT_ERROR);
    if (cmd === "git_unpushed_commits") return Promise.resolve([]);
    if (cmd === "load_project") return Promise.resolve({});
    if (cmd === "list_project_endings") return Promise.resolve([]);
    return Promise.resolve(null);
  });
}

async function renderPanel() {
  await act(async () => {
    render(<SidePanel open={true} />);
  });
}

describe("file tree git status failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupInvoke();
  });

  it("says the letters could not be read in a git project", async () => {
    useProject("local");
    await renderPanel();
    await screen.findByText("a.txt");
    expect(await screen.findByText(new RegExp(`Couldn't read git status.*${GIT_ERROR}`))).toBeTruthy();
  });

  it("stays quiet in a project that is not a repo", async () => {
    useProject("none");
    await renderPanel();
    await screen.findByText("a.txt");
    expect(screen.queryByText(/Couldn't read git status/)).toBeNull();
  });
});
