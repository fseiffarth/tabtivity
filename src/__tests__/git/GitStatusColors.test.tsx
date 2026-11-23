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
import { render, screen, act, within } from "@testing-library/react";
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

type Change = { path: string; added: number; deleted: number; binary: boolean; needs_count?: boolean };

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

describe("git change groups", () => {
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

  const group = (title: RegExp) =>
    screen.findByRole("button", { name: title }).then((head) => head.closest("section") as HTMLElement);

  // The trees were popovers behind a caret on each footer button until
  // 2026-11-22; they are inline now, so no click opens them.
  it("lists the Add files inline under Not staged, with +/- stats", async () => {
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
    const section = await group(/^Not staged/);
    await within(section).findByText("changed.ts");
    expect(section.textContent).toContain("new.ts");
    expect(section.textContent).toContain("+12");
    expect(section.textContent).toContain("-5");
    // The directory is rendered as a navigable node above its file.
    expect(section.textContent).toContain("src");
    expect(screen.queryByLabelText("Show changed files")).toBeNull();
  });

  it("lists the Commit files under Staged, read from the staged scope", async () => {
    setupInvoke({
      staged: 1,
      changeStats: { staged: [{ path: "staged.ts", added: 7, deleted: 1, binary: false }] },
    });
    await renderOpenPanel();
    const section = await group(/^Staged/);
    await within(section).findByText("staged.ts");
    expect(section.textContent).toContain("+7");
    expect(mockInvoke).toHaveBeenCalledWith("git_change_stats", { projectDir: expect.any(String), scope: "staged" });
    // No group for a step with nothing in it.
    expect(screen.queryByRole("button", { name: /^Not staged/ })).toBeNull();
  });

  it("marks each row with its git state letter", async () => {
    setupInvoke({
      untracked: 1,
      unstaged: 1,
      staged: 1,
      changeStats: {
        unstaged: [
          { path: "edited.ts", added: 1, deleted: 0, binary: false, needs_count: false },
          { path: "fresh.ts", added: 0, deleted: 0, binary: false, needs_count: true },
        ],
        staged: [{ path: "ready.ts", added: 2, deleted: 0, binary: false, needs_count: false }],
      },
    });
    await renderOpenPanel();
    const chipOf = async (name: string) =>
      (await screen.findByText(name)).closest(".sp-row")!.querySelector(".sp-chip")!;
    expect((await chipOf("edited.ts")).textContent).toBe("M");
    expect((await chipOf("fresh.ts")).textContent).toBe("U");
    expect((await chipOf("ready.ts")).textContent).toBe("S");
  });

  it("clicking a group's head folds it", async () => {
    const user = userEvent.setup();
    setupInvoke({ staged: 1, changeStats: { staged: [{ path: "staged.ts", added: 1, deleted: 0, binary: false }] } });
    await renderOpenPanel();
    await screen.findByText("staged.ts");
    const head = screen.getByRole("button", { name: /^Staged/ });
    expect(head.getAttribute("aria-expanded")).toBe("true");
    await user.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("staged.ts")).toBeNull();
  });

  it("shows 'No changes' when the scope is empty", async () => {
    setupInvoke({ staged: 1, changeStats: { staged: [] } });
    await renderOpenPanel();
    const section = await group(/^Staged/);
    await within(section).findByText("No changes");
  });
});
