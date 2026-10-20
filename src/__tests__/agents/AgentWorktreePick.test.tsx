/**
 * Agents in git worktrees (#23, Phase 4's agent-per-branch half):
 *  - the "+" menu starts an agent in the worktree the git view has selected,
 *    without asking, and that worktree lands as the tab's cwd;
 *  - a restored agent tab KEEPS a worktree cwd under its project root (Claude
 *    keys its history by cwd, so resetting it broke `--resume`), while a stale
 *    cwd under some other root still resets to the project root.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup, fireEvent, screen } from "@testing-library/react";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    scaleFactor: () => Promise.resolve(1),
    innerPosition: () => Promise.resolve({ toLogical: () => ({ x: 0, y: 0 }) }),
    onMoved: () => Promise.resolve(() => {}),
    onResized: () => Promise.resolve(() => {}),
  }),
  cursorPosition: () => Promise.resolve({ x: 0, y: 0 }),
}));

import { TabBar } from "../../components/tabs/TabBar";
import { useTabsStore } from "../../stores/tabs";
import { useProjectsStore } from "../../stores/projects";
import { useGitWorktreeSelectionStore } from "../../stores/gitWorktreeSelection";
import {
  agentWorktreeChoices,
  isProjectWorktreeCwd,
  restoredAgentCwd,
  type GitWorktree,
} from "../../lib/agents/agentWorktrees";
import type { ProjectEntry } from "../../types";
import { NAMES } from "../../lib/brand";

function wt(over: Partial<GitWorktree> & { path: string }): GitWorktree {
  return {
    branch: "",
    head: "abc",
    is_main: false,
    is_locked: false,
    lock_reason: "",
    is_prunable: false,
    prunable_reason: "",
    is_bare: false,
    is_current: false,
    ...over,
  };
}

const MAIN = wt({ path: "/p/p1", branch: "main", is_main: true, is_current: true });
const FEATURE = wt({ path: `/p/p1/${NAMES.worktreesDir}/feature`, branch: "feature" });

describe("isProjectWorktreeCwd / restoredAgentCwd", () => {
  it(`accepts exactly one directory under <root>/${NAMES.worktreesDir}/`, () => {
    expect(isProjectWorktreeCwd(`/p/p1/${NAMES.worktreesDir}/feature`, "/p/p1")).toBe(true);
    expect(isProjectWorktreeCwd(`/p/p1/${NAMES.worktreesDir}/feature/`, "/p/p1/")).toBe(true);
    expect(isProjectWorktreeCwd(`C:\\p\\p1\\${NAMES.projectDir}\\worktrees\\feature`, "C:\\p\\p1")).toBe(true);
  });

  it("rejects the root, the worktrees folder itself, nested paths, traversal, and other roots", () => {
    expect(isProjectWorktreeCwd("/p/p1", "/p/p1")).toBe(false);
    expect(isProjectWorktreeCwd(`/p/p1/${NAMES.worktreesDir}`, "/p/p1")).toBe(false);
    expect(isProjectWorktreeCwd(`/p/p1/${NAMES.worktreesDir}/`, "/p/p1")).toBe(false);
    expect(isProjectWorktreeCwd(`/p/p1/${NAMES.worktreesDir}/feature/src`, "/p/p1")).toBe(false);
    expect(isProjectWorktreeCwd(`/p/p1/${NAMES.worktreesDir}/..`, "/p/p1")).toBe(false);
    expect(isProjectWorktreeCwd(`/old/p1/${NAMES.worktreesDir}/feature`, "/p/p1")).toBe(false);
    expect(isProjectWorktreeCwd(`/p/p10/${NAMES.worktreesDir}/feature`, "/p/p1")).toBe(false);
    expect(isProjectWorktreeCwd("", "/p/p1")).toBe(false);
  });

  it("keeps a worktree cwd and resets everything else", () => {
    expect(restoredAgentCwd(`/p/p1/${NAMES.worktreesDir}/feature`, "/p/p1")).toBe(
      `/p/p1/${NAMES.worktreesDir}/feature`,
    );
    expect(restoredAgentCwd("/old/p1", "/p/p1")).toBe("/p/p1");
    expect(restoredAgentCwd("/p/p1/src", "/p/p1")).toBe("/p/p1");
    expect(restoredAgentCwd(undefined, "/p/p1")).toBe("/p/p1");
  });

  it("keeps a cwd that is one of the passed agent roots, or a worktree under one", () => {
    const roots = ["/p/p1", "/p/p2"];
    // A box scope's per-member Claude tab starts in the member root.
    expect(restoredAgentCwd("/p/p2", "/boxes/b1", roots)).toBe("/p/p2");
    expect(restoredAgentCwd("/p/p2/", "/boxes/b1", roots)).toBe("/p/p2/");
    expect(restoredAgentCwd(`/p/p1/${NAMES.worktreesDir}/feat`, "/boxes/b1", roots)).toBe(
      `/p/p1/${NAMES.worktreesDir}/feat`,
    );
    // A subdirectory of a member, a stale root, and an empty root list all reset.
    expect(restoredAgentCwd("/p/p2/src", "/boxes/b1", roots)).toBe("/boxes/b1");
    expect(restoredAgentCwd("/p/p20", "/boxes/b1", roots)).toBe("/boxes/b1");
    expect(restoredAgentCwd("/old/p2", "/boxes/b1", roots)).toBe("/boxes/b1");
    expect(restoredAgentCwd("/p/p2", "/boxes/b1", [])).toBe("/boxes/b1");
    expect(restoredAgentCwd("/p/p2", "/boxes/b1", [""])).toBe("/boxes/b1");
  });
});

describe("agentWorktreeChoices", () => {
  it("is empty — nothing to ask — with only the main worktree", () => {
    expect(agentWorktreeChoices([MAIN])).toEqual([]);
    expect(agentWorktreeChoices([])).toEqual([]);
  });

  it("lists main first plus every linked worktree that still has a checkout", () => {
    const gone = wt({ path: `/p/p1/${NAMES.worktreesDir}/gone`, branch: "gone", is_prunable: true });
    const bare = wt({ path: `/p/p1/${NAMES.worktreesDir}/bare`, is_bare: true });
    expect(agentWorktreeChoices([MAIN, gone, FEATURE, bare]).map((w) => w.path)).toEqual([
      MAIN.path,
      FEATURE.path,
    ]);
  });

  it("is empty when the only linked worktrees are gone", () => {
    const gone = wt({ path: `/p/p1/${NAMES.worktreesDir}/gone`, branch: "gone", is_prunable: true });
    expect(agentWorktreeChoices([MAIN, gone])).toEqual([]);
  });
});

function proj(id: string, dir: string): ProjectEntry {
  return { id, name: id, status: "active", position: 10, local_file: `${dir}/project.json` };
}

describe("restore keeps a worktree agent where it was", () => {
  beforeEach(() => {
    useTabsStore.setState({
      scope: "p1",
      tabsByScope: {},
      layoutByScope: {},
      focusedGroupByScope: {},
      tabs: [],
      layout: null,
      focusedGroupId: null,
      activeKey: null,
    });
  });

  it("keeps a cwd under this root's worktrees and resets a stale one", () => {
    useTabsStore.getState().loadFromLayout(
      [
        {
          key: "agent-1",
          label: "Claude · feature",
          cmd: "claude",
          cwd: `/p/p1/${NAMES.worktreesDir}/feature`,
          kind: "agent",
          sessionId: "11111111-1111-4111-8111-111111111111",
        },
        {
          key: "agent-2",
          label: "Claude",
          cmd: "claude",
          cwd: "/old/p1",
          kind: "agent",
          sessionId: "22222222-2222-4222-8222-222222222222",
        },
        { key: "shell-1", label: "Shell", cmd: "", cwd: "/p/p1/sub", kind: "shell" },
      ],
      "/p/p1",
      "p1",
    );
    const tabs = useTabsStore.getState().tabs;
    const byLabel = (l: string) => tabs.find((t) => t.label === l)!;
    expect(byLabel("Claude · feature").cwd).toBe(`/p/p1/${NAMES.worktreesDir}/feature`);
    expect(byLabel("Claude · feature").args).toContain("--resume");
    expect(byLabel("Claude").cwd).toBe("/p/p1");
    // Non-agent tabs were never reset and still are not.
    expect(byLabel("Shell").cwd).toBe("/p/p1/sub");
  });
});

describe("'+ agent' starts in the git view's worktree", () => {
  let worktrees: GitWorktree[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    worktrees = [MAIN, FEATURE];
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "list_agents") {
        return Promise.resolve([{ id: "claude", bin: "claude", installed: true }]);
      }
      if (cmd === "git_worktree_list") return Promise.resolve(worktrees);
      if (cmd === "git_status") {
        return Promise.resolve({ staged: 0, unstaged: 0, untracked: 0, has_remote: false, is_repo: true });
      }
      return Promise.resolve(null);
    });
    useProjectsStore.setState({ projects: [proj("p1", "/p/p1")], activeId: "p1", loaded: true });
    useGitWorktreeSelectionStore.setState({ byRoot: {} });
    useTabsStore.setState({
      scope: "p1",
      tabsByScope: {},
      layoutByScope: {},
      focusedGroupByScope: {},
      tabs: [],
      layout: null,
      focusedGroupId: null,
      activeKey: null,
    });
  });
  afterEach(() => cleanup());

  async function pickClaude() {
    useTabsStore.getState().setScope("p1");
    useTabsStore
      .getState()
      .addTab({ label: "Shell", cmd: "", args: [], env: {}, cwd: "/p/p1", kind: "shell" });
    const groupId = useTabsStore.getState().focusedGroupId!;
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<TabBar groupId={groupId} projectCwd="/p/p1" showGroupClose={false} />));
    });
    await act(async () => {
      fireEvent.click(container.querySelector(".tab-new-btn")!);
    });
    // Each row reads "<dot><label>" ("●Claude"), then the default agent's
    // Ctrl+1 hint; match the label after the dot.
    const claude = [...document.querySelectorAll(".tab-new-menu button")].find(
      (el) => el.querySelector(".tab-new-menu-dot")?.nextSibling?.textContent === "Claude",
    )!;
    expect(claude).toBeTruthy();
    await act(async () => {
      fireEvent.click(claude);
    });
  }

  function agentTabs() {
    return useTabsStore.getState().tabsByScope["p1"].filter((t) => t.kind === "agent");
  }

  it("lands the agent in the worktree selected in the git view, without asking", async () => {
    useGitWorktreeSelectionStore.getState().setSelected("/p/p1", FEATURE.path);
    await pickClaude();
    expect(mockInvoke).toHaveBeenCalledWith("git_worktree_list", {
      projectDir: "/p/p1",
      site: "mirror",
    });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    const created = agentTabs();
    expect(created).toHaveLength(1);
    expect(created[0].cwd).toBe(`/p/p1/${NAMES.worktreesDir}/feature`);
    expect(created[0].label).toBe("Claude · feature");
    expect(created[0].sessionId).toBeTruthy();
    // The session is named after the branch too.
    expect(created[0].initialInput).toBe("/rename p1 (feature)");
  });

  it("starts at the root when the git view has nothing selected", async () => {
    await pickClaude();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    const created = agentTabs();
    expect(created).toHaveLength(1);
    expect(created[0].cwd).toBe("/p/p1");
    expect(created[0].label).toBe("Claude");
  });

  it("starts at the root when the selected worktree is gone", async () => {
    useGitWorktreeSelectionStore
      .getState()
      .setSelected("/p/p1", `/p/p1/${NAMES.worktreesDir}/removed`);
    await pickClaude();
    const created = agentTabs();
    expect(created).toHaveLength(1);
    expect(created[0].cwd).toBe("/p/p1");
  });

  it("starts at the root when the project has only its main worktree", async () => {
    worktrees = [MAIN];
    useGitWorktreeSelectionStore.getState().setSelected("/p/p1", MAIN.path);
    await pickClaude();
    const created = agentTabs();
    expect(created).toHaveLength(1);
    expect(created[0].cwd).toBe("/p/p1");
  });

  it("starts at the root when the listing fails (not a repo)", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "list_agents") {
        return Promise.resolve([{ id: "claude", bin: "claude", installed: true }]);
      }
      if (cmd === "git_worktree_list") return Promise.reject(new Error("not a git repository"));
      return Promise.resolve(null);
    });
    await pickClaude();
    expect(agentTabs()).toHaveLength(1);
    expect(agentTabs()[0].cwd).toBe("/p/p1");
  });
});
