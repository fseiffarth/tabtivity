/**
 * Tests for git status color bars:
 * - STATUS_COLOR mapping (untracked=secondary text, modified=warning,
 *   staged=info, unpushed=success, ignored=muted — theme TOKENS, never
 *   hardcoded hexes, so the light themes' own palettes apply; never the danger
 *   token, which is for errors and destructive actions; see lib/theme/gitColors)
 * - SidePanel git action buttons have correct color bars
 * - Hovering a button shows the relevant staged/unpushed list
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { STATUS_COLOR } from "../../components/files/FileTree";
import { clearFileViewSnapshots } from "../../lib/projects/fileViewSnapshots";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("../../stores/projects", () => ({
  useProjectsStore: vi.fn(),
}));
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

// Selector-aware, like the real zustand hook: the panel reads each field
// through its own selector, so a mock that returned the whole state for every
// call handed `projects` the state object itself.
function mockProjectsState(state: { projects: unknown[]; activeId: string | null }) {
  const full = { sidePanelFolderByProject: {}, setSidePanelFolder: vi.fn(), rootDir: null, ...state };
  vi.mocked(useProjectsStore).mockImplementation(((sel?: (s: typeof full) => unknown) =>
    sel ? sel(full) : full) as unknown as typeof useProjectsStore);
}


const ACTIVE_PROJECT = {
  id: "proj-1",
  name: "TestProject",
  status: "active",
  position: 0,
  local_file: "/tmp/test-project/project.json",
};

type Change = { path: string; added: number; deleted: number; binary: boolean };

function setupInvoke({
  staged = 0,
  unstaged = 0,
  untracked = 0,
  has_remote = true,
  fileList = {} as Record<string, string>,
  unpushedCommits = [] as string[],
  changeStats = {} as Record<string, Change[]>,
} = {}) {
  mockInvoke.mockImplementation((cmd: string, args?: { scope?: string }) => {
    if (cmd === "git_status") return Promise.resolve({ staged, unstaged, untracked, has_remote, is_repo: true });
    if (cmd === "git_file_statuses") return Promise.resolve(fileList);
    if (cmd === "git_unpushed_commits") return Promise.resolve(unpushedCommits);
    if (cmd === "git_change_stats") return Promise.resolve(changeStats[args?.scope ?? ""] ?? []);
    if (cmd === "load_project") return Promise.resolve({});
    if (cmd === "list_project_endings") return Promise.resolve([]);
    if (cmd === "list_dir") return Promise.resolve([]);
    return Promise.resolve(null);
  });
}

describe("STATUS_COLOR", () => {
  it("untracked is the secondary-text token", () => {
    expect(STATUS_COLOR.untracked).toBe("var(--text-secondary)");
  });

  it("modified is the warning token", () => {
    expect(STATUS_COLOR.modified).toBe("var(--warning)");
  });

  it("staged is the info token, not the accent", () => {
    expect(STATUS_COLOR.staged).toBe("var(--info)");
  });

  it("unpushed is the success token", () => {
    expect(STATUS_COLOR.unpushed).toBe("var(--success)");
  });

  it("ignored is the muted-text token", () => {
    expect(STATUS_COLOR.ignored).toBe("var(--text-muted)");
  });

  it("never hardcodes a hex — the light themes define their own palette", () => {
    for (const color of Object.values(STATUS_COLOR)) {
      expect(color).toMatch(/^var\(--[a-z-]+\)$/);
    }
  });

  it("never paints ordinary git state red", () => {
    for (const color of Object.values(STATUS_COLOR)) {
      expect(color).not.toBe("var(--danger)");
    }
  });
});

describe("git action button bars", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The panel seeds its git bar and tree from module-level snapshots so a
    // reveal paints instantly (lib/projects/fileViewSnapshots). Every case here renders
    // the SAME project, so without a reset each one would start seeded from the
    // previous case's counts.
    clearFileViewSnapshots();
    mockProjectsState({ projects: [ACTIVE_PROJECT], activeId: "proj-1" });
  });

  async function renderOpenPanel() {
    let result: ReturnType<typeof render>;
    await act(async () => {
      result = render(<SidePanel open={true} />);
    });
    await userEvent.setup().click(screen.getByRole("button", { name: "Git" }));
    return result!;
  }

  it("Add button has the modified (warning) status dot", async () => {
    setupInvoke({ untracked: 1 });
    await renderOpenPanel();
    const bar = await screen.findByTestId("add-bar");
    expect(bar.style.background).toBe("var(--warning)");
  });

  it("flags the Git button with the next pending action colour", async () => {
    setupInvoke({ staged: 1 });
    await renderOpenPanel();
    await screen.findByTestId("commit-bar");
    const flag = await screen.findByRole("button", { name: "Git" }).then((button) =>
      button.querySelector(".toolbar-btn-flag"),
    );
    expect(flag).not.toBeNull();
    expect((flag as HTMLElement).style.backgroundColor).toBe("var(--info)");
  });

  it("Commit button has the staged (info) status dot", async () => {
    setupInvoke({ staged: 1 });
    await renderOpenPanel();
    const bar = await screen.findByTestId("commit-bar");
    expect(bar.style.background).toBe("var(--info)");
  });

  it("Push button has the success status dot when remote present and commits ahead", async () => {
    setupInvoke({ has_remote: true, unpushedCommits: ["abc123"] });
    await renderOpenPanel();
    const bar = await screen.findByTestId("push-bar");
    expect(bar.style.background).toBe("var(--success)");
  });

  it("Push button is absent when no remote", async () => {
    setupInvoke({ has_remote: false });
    await renderOpenPanel();
    expect(screen.queryByTestId("push-bar")).toBeNull();
  });

  it("Add button is hidden when nothing to stage", async () => {
    setupInvoke({ unstaged: 0, untracked: 0 });
    await renderOpenPanel();
    expect(screen.queryByTestId("add-bar")).toBeNull();
  });

  it("Commit button is hidden when nothing staged", async () => {
    setupInvoke({ staged: 0 });
    await renderOpenPanel();
    expect(screen.queryByTestId("commit-bar")).toBeNull();
  });

  it("Push button is hidden when remote present but no commits ahead", async () => {
    setupInvoke({ has_remote: true, unpushedCommits: [] });
    await renderOpenPanel();
    expect(screen.queryByTestId("push-bar")).toBeNull();
  });
});

describe("git change tree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The panel seeds its git bar and tree from module-level snapshots so a
    // reveal paints instantly (lib/projects/fileViewSnapshots). Every case here renders
    // the SAME project, so without a reset each one would start seeded from the
    // previous case's counts.
    clearFileViewSnapshots();
    mockProjectsState({ projects: [ACTIVE_PROJECT], activeId: "proj-1" });
  });

  async function renderOpenPanel() {
    let result: ReturnType<typeof render>;
    await act(async () => {
      result = render(<SidePanel open={true} />);
    });
    await userEvent.setup().click(screen.getByRole("button", { name: "Git" }));
    return result!;
  }

  it("the tree is closed until its caret is clicked", async () => {
    setupInvoke({ untracked: 1, changeStats: { unstaged: [{ path: "new.ts", added: 3, deleted: 0, binary: false }] } });
    await renderOpenPanel();
    await screen.findByTitle(/Stage all changes/);
    expect(screen.queryByTestId("git-change-tree")).toBeNull();
  });

  it("opening Add shows the changed files with +/- stats", async () => {
    const user = userEvent.setup();
    setupInvoke({
      untracked: 1,
      unstaged: 1,
      changeStats: {
        unstaged: [
          { path: "src/changed.ts", added: 12, deleted: 5, binary: false },
          { path: "new.ts", added: 3, deleted: 0, binary: false },
        ],
      },
    });
    await renderOpenPanel();
    const toggle = await screen.findByLabelText("Show changed files");
    await user.click(toggle);
    const tree = await screen.findByTestId("git-change-tree");
    expect(tree.textContent).toContain("changed.ts");
    expect(tree.textContent).toContain("new.ts");
    expect(tree.textContent).toContain("+12");
    expect(tree.textContent).toContain("-5");
    // The directory is rendered as a navigable node above its file.
    expect(tree.textContent).toContain("src");
  });

  it("opening Commit requests the staged scope", async () => {
    const user = userEvent.setup();
    setupInvoke({
      staged: 1,
      changeStats: { staged: [{ path: "staged.ts", added: 7, deleted: 1, binary: false }] },
    });
    await renderOpenPanel();
    const toggle = await screen.findByLabelText("Show staged files");
    await user.click(toggle);
    const tree = await screen.findByTestId("git-change-tree");
    expect(tree.textContent).toContain("staged.ts");
    expect(tree.textContent).toContain("+7");
    expect(mockInvoke).toHaveBeenCalledWith("git_change_stats", { projectDir: expect.any(String), scope: "staged" });
  });

  it("clicking the caret again closes the tree", async () => {
    const user = userEvent.setup();
    setupInvoke({ staged: 1, changeStats: { staged: [{ path: "staged.ts", added: 1, deleted: 0, binary: false }] } });
    await renderOpenPanel();
    const toggle = await screen.findByLabelText("Show staged files");
    await user.click(toggle);
    await screen.findByTestId("git-change-tree");
    await user.click(toggle);
    expect(screen.queryByTestId("git-change-tree")).toBeNull();
  });

  it("shows 'No changes' when the scope is empty", async () => {
    const user = userEvent.setup();
    setupInvoke({ staged: 1, changeStats: { staged: [] } });
    await renderOpenPanel();
    const toggle = await screen.findByLabelText("Show staged files");
    await user.click(toggle);
    const tree = await screen.findByTestId("git-change-tree");
    expect(tree.textContent).toContain("No changes");
  });
});
