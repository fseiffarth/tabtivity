import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import { ProjectFilesView } from "../../components/files/ProjectFilesView";
import { useProjectsStore } from "../../stores/projects";
import { useTabsStore } from "../../stores/tabs";
import { clearFileViewSnapshots } from "../../lib/projects/fileViewSnapshots";
import { NAMES } from "../../lib/brand";

const project = { id: "p", name: "Project", status: "active", position: 10, local_file: "/p/project.json" };
const selection = { path: `/p/${NAMES.worktreesDir}/feature`, site: "host" };
const status = { is_repo: true, staged: 1, unstaged: 1, untracked: 0, has_remote: false, behind: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  clearFileViewSnapshots();
  useProjectsStore.setState({ projects: [project], activeId: "p", loaded: true });
  useTabsStore.setState({ scope: "p", tabsByScope: {} });
  mockInvoke.mockImplementation((cmd: string, args: Record<string, unknown> = {}) => {
    if (cmd === "git_worktree_selection_supported") return Promise.resolve(true);
    if (cmd === "git_repo_root") return Promise.resolve(null);
    if (cmd === "git_status") return Promise.resolve(status);
    if (cmd === "git_change_stats") return Promise.resolve([{ path: "note.txt", added: 1, deleted: 0, binary: false, needs_count: false }]);
    if (cmd === "git_diff_file") return Promise.resolve("+staged version");
    if (cmd === "git_generate_commit_message") return Promise.resolve("selected commit");
    if (cmd === "git_branches") return Promise.resolve([
      { name: "main", is_remote: false, is_current: !args.worktree },
      { name: "feature", is_remote: false, is_current: !!args.worktree },
    ]);
    if (cmd === "git_worktree_list") return Promise.resolve([
      { path: "/p", branch: "main", head: "aaa", is_main: true, is_current: true },
      { path: selection.path, branch: "feature", head: "bbb", is_main: false, is_current: false },
    ]);
    return Promise.resolve([]);
  });
});

describe("worktree selection in the shared Git viewer", () => {
  it("routes status, staging, change stats, and commit through the selected checkout", async () => {
    const user = userEvent.setup();
    await act(async () => {
      render(<ProjectFilesView scope="p" projectId="p" project={project} projectDir="/p"
        folder="" onFolderChange={() => {}} source="local" setSource={() => {}}
        active mountTree={false} containerClassName="test-view" view="git" />);
    });
    await user.click(await screen.findByRole("button", { name: /^Worktrees/, expanded: false }));
    await user.click(screen.getByRole("button", { name: "Select worktree feature" }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("git_status", { projectDir: "/p", worktree: selection, branchExchange: true }));
    await user.click(await screen.findByRole("button", { name: /Add \(1\)/ }));
    expect(mockInvoke).toHaveBeenCalledWith("git_add_all", { projectDir: "/p", worktree: selection });
    // Expanding the change lists reads from the selected checkout.
    await user.click(await screen.findByRole("button", { name: /^Not staged/ }));
    await user.click(await screen.findByRole("button", { name: /^Staged/ }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("git_change_stats", { projectDir: "/p", worktree: selection, scope: "unstaged" }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("git_change_stats", { projectDir: "/p", worktree: selection, scope: "staged" }));
    await user.click(await screen.findByRole("button", { name: "Stage" }));
    expect(mockInvoke).toHaveBeenCalledWith("git_add_path", { projectDir: "/p", worktree: selection, relPath: "note.txt", unstage: false });
    await user.click(await screen.findByRole("button", { name: "Staged diff" }));
    expect(await screen.findByText("+staged version")).toBeTruthy();
    expect(mockInvoke).toHaveBeenCalledWith("git_diff_file", { projectDir: "/p", worktree: selection, relPath: "note.txt", staged: true });
    await user.click(screen.getByRole("button", { name: "Unstage" }));
    expect(mockInvoke).toHaveBeenCalledWith("git_add_path", { projectDir: "/p", worktree: selection, relPath: "note.txt", unstage: true });
    await user.click(screen.getByRole("button", { name: /Commit \(1\)/ }));
    const draft = await screen.findByDisplayValue("selected commit");
    await user.clear(draft);
    await user.type(draft, "feature draft");
    await user.click(screen.getByRole("button", { name: "Select worktree p" }));
    await waitFor(() => expect(screen.queryByDisplayValue("feature draft")).toBeNull());
    expect(await screen.findByRole("button", { name: /^Staged/, expanded: false })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Select worktree feature" }));
    expect(await screen.findByDisplayValue("feature draft")).toBeTruthy();
    expect(await screen.findByRole("button", { name: /^Staged/, expanded: true })).toBeTruthy();
    await user.click(await screen.findByRole("button", { name: /Confirm/ }));
    expect(mockInvoke).toHaveBeenCalledWith("git_commit", { projectDir: "/p", worktree: selection, message: "feature draft" });
  });
});
