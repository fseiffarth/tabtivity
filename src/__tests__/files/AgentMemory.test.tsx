/**
 * The "Agent memory (n)" sub-group at the end of the Project docs group and its
 * read-only preview dialog. The memory commands are mocked at the `invoke`
 * boundary; the group is hidden when the listing is empty, collapsed otherwise,
 * and a row opens the dialog (never a viewer tab).
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
import { AgentMemoryDialog } from "../../components/files/AgentMemoryDialog";

const mockUseProjectsStore = vi.mocked(useProjectsStore);

const ACTIVE_PROJECT = {
  id: "proj-1",
  name: "TestProject",
  status: "active",
  position: 0,
  local_file: "/tmp/test-project/project.json",
};

const entry = (name: string, cli: "claude" | "codex" = "claude", home: "scope" | "local" = "scope") => ({
  cli, home, name, bytes: 2048, modifiedSecs: 1_700_000_000,
});

function setupInvoke(memory: unknown[]) {
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "list_dir") {
      return Promise.resolve([{ name: "AGENTS.md", path: "/tmp/test-project/AGENTS.md", is_dir: false, size: 1, extension: ".md", mime: null }]);
    }
    if (cmd === "project_docs_status") {
      return Promise.resolve([{ name: "AGENTS.md", state: "edited", nestedUnder: null, creatable: true, isDefault: true }]);
    }
    if (cmd === "project_agent_memory") return Promise.resolve(memory);
    if (cmd === "project_agent_memory_read") return Promise.resolve("# Notes\n\nThe build needs **cmake**.");
    if (cmd === "git_status") return Promise.resolve({ staged: 0, unstaged: 0, untracked: 0, has_remote: false, is_repo: false });
    if (cmd === "git_unpushed_commits") return Promise.resolve([]);
    if (cmd === "git_file_statuses") return Promise.resolve({});
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

describe("file tree · Agent memory sub-group", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    try { localStorage.clear(); } catch { /* ignore */ }
    const state = {
      projects: [ACTIVE_PROJECT],
      activeId: "proj-1",
      sidePanelFolderByProject: {},
      setSidePanelFolder: vi.fn(),
    } as unknown as ReturnType<typeof useProjectsStore>;
    mockUseProjectsStore.mockImplementation(((selector?: (s: typeof state) => unknown) =>
      selector ? selector(state) : state) as typeof useProjectsStore);
  });

  async function openDocs() {
    const toggle = (await screen.findByText("Project docs", { exact: false })).closest("button") as HTMLElement;
    await waitFor(() => expect(toggle.textContent).toContain("/"));
    await act(async () => {
      fireEvent.click(toggle);
    });
  }

  it("is hidden when there is no memory", async () => {
    setupInvoke([]);
    await renderPanel();
    await openDocs();
    expect(screen.queryByText(/Agent memory/)).toBeNull();
  });

  it("is a collapsed sub-group with the count, and a row opens the read-only preview", async () => {
    setupInvoke([entry("MEMORY.md"), entry("user_role.md"), entry("notes.md", "codex")]);
    await renderPanel();
    await openDocs();
    const head = await screen.findByText(/Agent memory \(3\)/);
    const toggle = head.closest("button") as HTMLElement;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector(".doc-memory")).toBeNull();

    fireEvent.click(toggle);
    const rows = Array.from(document.querySelectorAll(".doc-memory .file-name")).map((n) => n.textContent);
    expect(rows).toEqual(["MEMORY.md", "user_role.md", "notes.md"]);

    await act(async () => {
      fireEvent.click(document.querySelector(".doc-memory") as HTMLElement);
    });
    expect(mockInvoke).toHaveBeenCalledWith("project_agent_memory_read", {
      projectId: "proj-1", cli: "claude", home: "scope", name: "MEMORY.md",
    });
    expect(await screen.findByText("cmake")).toBeTruthy();
    // A preview dialog, not a viewer tab.
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("AgentMemoryDialog", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders the markdown read-only, and says so", async () => {
    setupInvoke([]);
    const onClose = vi.fn();
    await act(async () => {
      render(<AgentMemoryDialog projectId="p1" entry={entry("MEMORY.md")} onClose={onClose} />);
    });
    expect(await screen.findByText("cmake")).toBeTruthy();
    expect(screen.getByText(/Read-only\./)).toBeTruthy();
    expect(document.querySelector("textarea, input")).toBeNull();
  });

  it("shows 'not available' when the read is refused", async () => {
    mockInvoke.mockImplementation(() => Promise.reject("gone"));
    await act(async () => {
      render(<AgentMemoryDialog projectId="p1" entry={entry("MEMORY.md")} onClose={vi.fn()} />);
    });
    expect(await screen.findByText("This memory file is not available any more.")).toBeTruthy();
  });
});
