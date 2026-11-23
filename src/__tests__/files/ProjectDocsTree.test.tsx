/**
 * The file tree's "Project docs" group at the project root: header summary,
 * badges, only-template dimming, pointer nesting, ghost rows that create a doc,
 * and the open state remembered per project. The backend status is mocked at
 * the `invoke` boundary (`project_docs_status`).
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
import { storageKey } from "../../lib/brand";

const mockUseProjectsStore = vi.mocked(useProjectsStore);

const ACTIVE_PROJECT = {
  id: "proj-1",
  name: "TestProject",
  status: "active",
  position: 0,
  local_file: "/tmp/test-project/project.json",
};

function fileEntry(name: string, is_dir = false) {
  return {
    name,
    path: `/tmp/test-project/${name}`,
    is_dir,
    size: 1,
    extension: name.includes(".") ? name.slice(name.lastIndexOf(".")) : null,
    mime: null,
  };
}

const STATUS = [
  { name: "AGENTS.md", state: "template", nestedUnder: null, creatable: true, isDefault: true },
  { name: "README.md", state: "edited", nestedUnder: null, creatable: true, isDefault: true },
  { name: "PROJECT.md", state: "missing", nestedUnder: null, creatable: true, isDefault: false },
  { name: "CLAUDE.md", state: "pointer", nestedUnder: "AGENTS.md", creatable: false, isDefault: false },
];

function setupInvoke(status: unknown = STATUS) {
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "list_dir") {
      return Promise.resolve([
        fileEntry("src", true),
        fileEntry("AGENTS.md"),
        fileEntry("CLAUDE.md"),
        fileEntry("README.md"),
      ]);
    }
    if (cmd === "project_docs_status") return Promise.resolve(status);
    if (cmd === "create_project_doc") return Promise.resolve(true);
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

const rowOf = (name: string) => screen.getByText(name, { selector: ".file-name" }).closest(".file-entry") as HTMLElement;

describe("file tree · Project docs group", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    try { localStorage.clear(); } catch { /* ignore */ }
    setupInvoke();
    const state = {
      projects: [ACTIVE_PROJECT],
      activeId: "proj-1",
      sidePanelFolderByProject: {},
      setSidePanelFolder: vi.fn(),
    } as unknown as ReturnType<typeof useProjectsStore>;
    mockUseProjectsStore.mockImplementation(((selector?: (s: typeof state) => unknown) =>
      selector ? selector(state) : state) as typeof useProjectsStore);
  });

  it("heads the group with present/total defaults and the template count, collapsed at first", async () => {
    await renderPanel();
    const header = await screen.findByText("Project docs", { exact: false });
    const toggle = header.closest("button") as HTMLElement;
    await waitFor(() => expect(toggle.textContent).toContain("2/2 · 1 template"));
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("AGENTS.md", { selector: ".file-name" })).toBeNull();
    expect(mockInvoke).toHaveBeenCalledWith("project_docs_status", { projectId: "proj-1" });
  });

  it("dims only the template row, badges template and pointer, nests the pointer and lists the ghost row", async () => {
    await renderPanel();
    const toggle = (await screen.findByText("Project docs", { exact: false })).closest("button") as HTMLElement;
    await waitFor(() => expect(toggle.textContent).toContain("2/2"));
    fireEvent.click(toggle);

    expect(rowOf("AGENTS.md").classList.contains("doc-template")).toBe(true);
    expect(rowOf("AGENTS.md").textContent).toContain("template");
    expect(rowOf("README.md").classList.contains("doc-template")).toBe(false);
    expect(rowOf("README.md").classList.contains("scaffold")).toBe(false);
    const pointer = rowOf("CLAUDE.md");
    expect(pointer.classList.contains("doc-nested")).toBe(true);
    expect(pointer.classList.contains("doc-template")).toBe(false);
    expect(pointer.textContent).toContain("pointer");

    // AGENTS.md, its nested pointer, then README.md; the ghost row after the files.
    const names = Array.from(document.querySelectorAll(".file-entry .file-name")).map((n) => n.textContent);
    expect(names.slice(0, 4)).toEqual(["AGENTS.md", "CLAUDE.md", "README.md", "PROJECT.md"]);
    const ghost = rowOf("PROJECT.md");
    expect(ghost.classList.contains("doc-ghost")).toBe(true);
    // A ghost row is not a file row: nothing to select, drag or right-click.
    expect(ghost.hasAttribute("data-entry-path")).toBe(false);
    expect(ghost.getAttribute("draggable")).toBeNull();
    expect(ghost.textContent).toContain("create");
  });

  it("creates the doc from its ghost row", async () => {
    await renderPanel();
    const toggle = (await screen.findByText("Project docs", { exact: false })).closest("button") as HTMLElement;
    await waitFor(() => expect(toggle.textContent).toContain("2/2"));
    fireEvent.click(toggle);
    await act(async () => {
      fireEvent.click(rowOf("PROJECT.md"));
    });
    expect(mockInvoke).toHaveBeenCalledWith("create_project_doc", { projectId: "proj-1", name: "PROJECT.md" });
  });

  it("remembers the open state per project", async () => {
    await renderPanel();
    const toggle = (await screen.findByText("Project docs", { exact: false })).closest("button") as HTMLElement;
    fireEvent.click(toggle);
    expect(localStorage.getItem(storageKey("fileTree.docsExpanded.proj-1"))).toBe("1");
    fireEvent.click(toggle);
    expect(localStorage.getItem(storageKey("fileTree.docsExpanded.proj-1"))).toBe("0");
  });

  it("falls back to a plain count, with no ghost rows, when the project has no local status", async () => {
    setupInvoke(null);
    await renderPanel();
    const toggle = (await screen.findByText("Project docs", { exact: false })).closest("button") as HTMLElement;
    expect(toggle.textContent).toContain("Project docs");
    expect(toggle.querySelector(".sp-count")?.textContent).toBe("3");
    fireEvent.click(toggle);
    expect(document.querySelector(".doc-ghost")).toBeNull();
  });
});
