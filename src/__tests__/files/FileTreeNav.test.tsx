/**
 * Render tests for the side-panel file tree navigation:
 * - #2 (Group D.1): a file's full name is readable on hover via the existing
 *   custom `.file-tooltip` popup (not a native `title` attribute — that used
 *   to render as an unthemed OS tooltip instead of the app's own hover UI).
 * - #3 (Group D.1): entering a subfolder renders a breadcrumb (↑, ⌂ root crumb,
 *   and a crumb per path segment); clicking the root crumb navigates back.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("../../stores/projects", () => ({ useProjectsStore: vi.fn() }));
vi.mock("../../stores/windows", () => ({
  useWindowsStore: () => ({ windows: [], refresh: vi.fn(), untrack: vi.fn(), closeApp: vi.fn() }),
}));
vi.mock("../../stores/settings", () => {
  // Selector-aware, not a fixed `null`: the side panel reads its stored view off
  // `settings` and writes it back through the `updateSettings` action when the
  // view switcher moves, so a mock that ignored the selector handed the panel a
  // null where an action belongs.
  const state = { settings: null, updateSettings: async () => {} };
  return {
    useSettingsStore: (selector?: (s: typeof state) => unknown) =>
      selector ? selector(state) : state,
  };
});

import { useProjectsStore } from "../../stores/projects";
import { SidePanel } from "../../components/layout/SidePanel";
import { BRAND } from "../../lib/brand";

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

const LONG_NAME = "this-is-a-very-long-file-name-that-would-be-truncated.txt";

// list_dir returns root contents at "" and the subfolder's contents at "sub".
function setupInvoke() {
  mockInvoke.mockImplementation((cmd: string, args?: { relPath?: string }) => {
    if (cmd === "list_dir") {
      return Promise.resolve(
        args?.relPath === "sub"
          ? [fileEntry("deep.txt")]
          : [fileEntry("sub", true), fileEntry(LONG_NAME)],
      );
    }
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

describe("file tree navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupInvoke();
    // Apply the selector like real zustand: FileTree subscribes with selectors
    // (e.g. `(s) => !!s.projects.find(...)?.remote`), so the mock must run the
    // selector against the state — returning the whole state object would make
    // those boolean selectors truthy (a non-empty object) and mis-flag the local
    // test project as remote.
    const state = {
      projects: [ACTIVE_PROJECT],
      activeId: "proj-1",
      sidePanelFolderByProject: {},
      setSidePanelFolder: vi.fn(),
    } as unknown as ReturnType<typeof useProjectsStore>;
    mockUseProjectsStore.mockImplementation(((selector?: (s: typeof state) => unknown) =>
      selector ? selector(state) : state) as typeof useProjectsStore);
  });

  it("#2 shows the full file name in the hover tooltip, not a title attribute", async () => {
    await renderPanel();
    const nameSpan = await screen.findByText(LONG_NAME);
    expect(nameSpan.classList.contains("file-name")).toBe(true);
    expect(nameSpan.getAttribute("title")).toBeNull();

    const row = nameSpan.closest(".file-entry");
    expect(row).toBeTruthy();
    fireEvent.mouseEnter(row!);
    expect(await screen.findByText(LONG_NAME, { selector: ".file-tooltip-name" })).toBeTruthy();
  });

  it("#3 builds a breadcrumb on entering a subfolder and the root crumb goes back", async () => {
    const user = userEvent.setup();
    await renderPanel();

    // At the project root the breadcrumb holds ⌂ and nothing to go up to.
    expect(document.querySelector(".file-tree-breadcrumb")).toBeTruthy();
    expect(document.querySelector(".file-tree-up[title='Go up']")).toBeNull();
    expect(document.querySelector(".file-tree-crumb[title='Project root']")).toBeTruthy();
    expect(document.querySelector(".file-tree-crumb.current")?.textContent).toBe("⌂");

    // Enter the subfolder.
    await user.click(await screen.findByText("sub"));

    const crumb = await screen.findByText("sub", { selector: ".file-tree-crumb" });
    expect(crumb).toBeTruthy();
    expect(document.querySelector(".file-tree-up[title='Go up']")).toBeTruthy();
    expect(document.querySelector(".file-tree-crumb[title='Project root']")).toBeTruthy();
    // The subfolder's contents are now listed.
    expect(await screen.findByText("deep.txt")).toBeTruthy();

    // Clicking the root crumb returns to the top (the up button goes away and
    // ⌂ becomes the current crumb again).
    await user.click(screen.getByTitle("Project root"));
    await screen.findByText(LONG_NAME);
    expect(document.querySelector(".file-tree-up[title='Go up']")).toBeNull();
    expect(document.querySelector(".file-tree-crumb.current")?.textContent).toBe("⌂");
  });

  it("seeds relPath from the saved folder so a mount never flashes root", () => {
    // Store remembers `proj-1` was last browsing the `sub` folder.
    const state = {
      projects: [ACTIVE_PROJECT],
      activeId: "proj-1",
      sidePanelFolderByProject: { "proj-1": "sub" },
      setSidePanelFolder: vi.fn(),
    } as unknown as ReturnType<typeof useProjectsStore>;
    mockUseProjectsStore.mockImplementation(((selector?: (s: typeof state) => unknown) =>
      selector ? selector(state) : state) as typeof useProjectsStore);

    // Synchronous render (no awaited flush): the async `load("sub")` has NOT
    // resolved yet, so `relPath` reflects only its initial value. With the fix it
    // is seeded from `initialRelPath="sub"`, so the breadcrumb (driven by
    // `relPath`, not the entry listing) is on screen on the first commit. The old
    // `useState("")` would render root here and only reach `sub` after the load
    // resolved — the "flash root" this test guards against.
    render(<SidePanel open={true} />);
    expect(document.querySelector(".file-tree-breadcrumb")).not.toBeNull();
    expect(document.querySelector(".file-tree-crumb[title='Project root']")).toBeTruthy();
  });

  it(`#1 'New File' from the context menu asks in ${BRAND.display}'s dialog and calls create_file`, async () => {
    const user = userEvent.setup();
    await renderPanel();

    // Right-click the file-tree background to open the root context menu (New
    // File / New Folder live there, not on the per-entry menu), then choose New File.
    await screen.findByText("sub");
    fireEvent.contextMenu(document.querySelector(".file-tree")!);
    await user.click(await screen.findByText("New File"));

    // The name is asked for in the app's own dialog (`TextPromptDialog`), not in
    // `window.prompt` — WebKitGTK draws that as an origin-titled browser alert.
    const field = await screen.findByLabelText("New file name:");
    await user.type(field, "created.ts");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(mockInvoke).toHaveBeenCalledWith("create_file", {
      projectDir: "/tmp/test-project",
      relPath: "created.ts",
    });
  });
});
