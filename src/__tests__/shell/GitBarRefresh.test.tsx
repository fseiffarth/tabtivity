/**
 * The git bar's counts follow the repo, not just the moment the view went
 * active. They used to be read on activation and after the bar's own buttons
 * only, so a reading taken while an agent had 163 files modified went on
 * offering "Add (163)" after that agent (or a terminal) committed them: the
 * Git view mounts no file tree, so nothing was watching the repo either.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Settings } from "../../types";
import { clearFileViewSnapshots } from "../../lib/projects/fileViewSnapshots";

const { mockInvoke, fsChange } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  fsChange: [] as Array<() => void>,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: () => void) => {
    if (event === "fs-change") fsChange.push(handler);
    return () => {
      const at = fsChange.indexOf(handler);
      if (at >= 0) fsChange.splice(at, 1);
    };
  }),
}));
vi.mock("../../stores/projects", () => ({ useProjectsStore: vi.fn() }));
vi.mock("../../stores/windows", () => ({
  useWindowsStore: () => ({ windows: [], refresh: vi.fn(), untrack: vi.fn(), closeApp: vi.fn() }),
}));
vi.mock("../../stores/settings", () => {
  const state: { settings: Settings | null; updateSettings: () => Promise<void> } = {
    settings: null,
    updateSettings: async () => {},
  };
  return {
    __state: state,
    useSettingsStore: (selector?: (s: typeof state) => unknown) =>
      selector ? selector(state) : state,
  };
});

import { useProjectsStore } from "../../stores/projects";
import * as settingsModule from "../../stores/settings";
import { SidePanel } from "../../components/layout/SidePanel";
import { useGitDirtyStore } from "../../stores/gitDirty";

const settingsState = (settingsModule as unknown as { __state: { settings: Settings | null } }).__state;

let unstaged = 163;

beforeEach(() => {
  vi.clearAllMocks();
  clearFileViewSnapshots();
  fsChange.length = 0;
  unstaged = 163;
  settingsState.settings = null;
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "git_status")
      return Promise.resolve({ staged: 0, unstaged, untracked: 0, has_remote: false, is_repo: true, behind: 0 });
    if (cmd === "git_unpushed_commits") return Promise.resolve([]);
    if (cmd === "git_file_statuses") return Promise.resolve({});
    if (cmd === "git_change_stats") return Promise.resolve([]);
    if (cmd === "list_dir") return Promise.resolve([]);
    return Promise.resolve(null);
  });
  const full = {
    projects: [{ id: "proj-1", name: "TestProject", status: "active", position: 0, local_file: "/tmp/test-project/project.json" }],
    activeId: "proj-1",
    sidePanelFolderByProject: {},
    setSidePanelFolder: vi.fn(),
    rootDir: null,
  };
  vi.mocked(useProjectsStore).mockImplementation(((sel?: (s: typeof full) => unknown) =>
    sel ? sel(full) : full) as unknown as typeof useProjectsStore);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Past the bar's 120 ms refresh debounce. */
async function settle(ms = 200) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

const gitButton = () => screen.getByRole("button", { name: "Git" });

describe("git bar refresh", () => {
  it("re-reads the counts when the repo changes under the Files view", async () => {
    render(<SidePanel open={true} />);
    await settle();
    expect(gitButton().className).toContain("toolbar-btn--flagged");

    unstaged = 0; // committed from a terminal
    await act(async () => {
      fsChange.forEach((fire) => fire());
    });
    await settle();
    expect(gitButton().className).not.toContain("toolbar-btn--flagged");
  });

  it("re-reads the counts on entering the Git view", async () => {
    render(<SidePanel open={true} />);
    await settle();
    unstaged = 0;
    await act(async () => {
      await userEvent.setup().click(gitButton());
    });
    await settle();
    expect(screen.queryByText("Add (163)")).toBeNull();
  });

  // #2349: a failed unpushed read is no reading. It used to become `[]`, so a
  // clean tree with commits to push painted the pill "clean".
  it("never turns a failed unpushed read into a clean dot", async () => {
    useGitDirtyStore.setState({ byId: {} });
    unstaged = 0;
    let unpushedFails = false;
    const base = mockInvoke.getMockImplementation()!;
    mockInvoke.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === "git_unpushed_commits") {
        return unpushedFails ? Promise.reject("git log timed out after 120 s and was stopped.") : Promise.resolve(["abc123 one"]);
      }
      return base(cmd, args);
    });
    render(<SidePanel open={true} />);
    await settle();
    expect(useGitDirtyStore.getState().byId["proj-1"]).toBe("unpushed");

    unpushedFails = true;
    await act(async () => {
      fsChange.forEach((fire) => fire());
    });
    await settle();
    expect(useGitDirtyStore.getState().byId["proj-1"]).toBe("unpushed");
    expect(gitButton().className).toContain("toolbar-btn--flagged");
  });

  it("keeps re-reading while the Git view is on screen", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    settingsState.settings = { side_panel_view: "git" };
    render(<SidePanel open={true} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(screen.getByText("Add (163)")).toBeTruthy();

    unstaged = 0;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_200);
    });
    expect(screen.queryByText("Add (163)")).toBeNull();
  });
});
