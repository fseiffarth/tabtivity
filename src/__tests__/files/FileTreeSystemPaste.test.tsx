/**
 * Files and folders copied in the OS file manager paste into the side-panel
 * tree: the context menu offers them once `clipboard_file_paths` reports them,
 * one item opens the paste-rename prompt and lands through the OS-drop import
 * (`import_external_file`, a copy — the source stays put), several paste in
 * bulk with " copy" names on collision.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react";

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

const ACTIVE_PROJECT = {
  id: "proj-1",
  name: "TestProject",
  status: "active",
  position: 0,
  local_file: "/tmp/test-project/project.json",
};

function fileEntry(name: string) {
  return {
    name,
    path: `/tmp/test-project/${name}`,
    is_dir: false,
    size: 1,
    extension: name.slice(name.lastIndexOf(".")),
    mime: null,
  };
}

type SystemFile = { path: string; name: string; isDir: boolean };

function setupInvoke(systemFiles: SystemFile[]) {
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "list_dir") return Promise.resolve([fileEntry("notes.txt")]);
    if (cmd === "clipboard_file_paths") return Promise.resolve(systemFiles);
    if (cmd === "clipboard_has_image") return Promise.resolve(false);
    if (cmd === "git_status") return Promise.resolve({ staged: 0, unstaged: 0, untracked: 0, has_remote: false, is_repo: false });
    if (cmd === "git_unpushed_commits") return Promise.resolve([]);
    if (cmd === "git_file_statuses") return Promise.resolve({});
    if (cmd === "load_project") return Promise.resolve({});
    if (cmd === "list_project_endings") return Promise.resolve([]);
    if (cmd === "import_external_file") return Promise.resolve("x");
    return Promise.resolve(null);
  });
}

async function openRowMenu() {
  await act(async () => {
    render(<SidePanel open={true} />);
  });
  const row = (await screen.findByText("notes.txt")).closest(".file-entry")!;
  await act(async () => {
    fireEvent.contextMenu(row);
  });
}

function importCalls() {
  return mockInvoke.mock.calls.filter(([cmd]) => cmd === "import_external_file").map(([, args]) => args);
}

describe("paste from the system clipboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const state = {
      projects: [ACTIVE_PROJECT],
      activeId: "proj-1",
      sidePanelFolderByProject: {},
      setSidePanelFolder: vi.fn(),
    } as unknown as ReturnType<typeof useProjectsStore>;
    mockUseProjectsStore.mockImplementation(((selector?: (s: typeof state) => unknown) =>
      selector ? selector(state) : state) as typeof useProjectsStore);
  });

  it("offers nothing when the clipboard holds no files", async () => {
    setupInvoke([]);
    await openRowMenu();
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("clipboard_file_paths"));
    expect(screen.queryByText(/from the system clipboard/)).toBeNull();
  });

  it("one copied file pastes through the rename prompt, renamed off a collision", async () => {
    setupInvoke([{ path: "/home/u/Downloads/notes.txt", name: "notes.txt", isDir: false }]);
    await openRowMenu();
    const item = await screen.findByText(/Paste “notes.txt” from the system clipboard/);
    await act(async () => {
      fireEvent.click(item.closest("button")!);
    });
    const input = document.querySelector<HTMLInputElement>(".file-paste-name")!;
    expect(input.value).toBe("notes copy.txt");
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    await waitFor(() => expect(importCalls()).toHaveLength(1));
    expect(importCalls()[0]).toEqual({
      projectDir: "/tmp/test-project",
      sourcePath: "/home/u/Downloads/notes.txt",
      destRel: "",
      replace: false,
      destName: "notes copy.txt",
    });
  });

  it("several copied items paste in one go, each under a free name", async () => {
    setupInvoke([
      { path: "/home/u/a/notes.txt", name: "notes.txt", isDir: false },
      { path: "/home/u/b/data", name: "data", isDir: true },
    ]);
    await openRowMenu();
    const item = await screen.findByText(/Paste 2 items from the system clipboard/);
    await act(async () => {
      fireEvent.click(item.closest("button")!);
    });
    await waitFor(() => expect(importCalls()).toHaveLength(2));
    expect(importCalls().map((a) => (a as { destName: string }).destName)).toEqual(["notes copy.txt", "data"]);
  });
});
