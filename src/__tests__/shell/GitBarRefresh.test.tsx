/**
 * The git bar's counts follow the repo, not just the moment the view went
 * active. They used to be read on activation and after the bar's own buttons
 * only, so a reading taken while an agent had 163 files modified went on
 * offering "Add (163)" after that agent (or a terminal) committed them: the
 * Git view mounts no file tree, so nothing was watching the repo either.
 *
 * Perf plan §3.4: outside the Git view an `fs-change` refreshes only the
 * project's pill dot (one `git_dirty_probe`), which the Git button's flag
 * shows; the full counts follow the watcher only in the Git view, at most once
 * a second. Events for another tree's folder are ignored.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Settings } from "../../types";
import { clearFileViewSnapshots } from "../../lib/projects/fileViewSnapshots";

const { mockInvoke, fsChange } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  fsChange: [] as Array<(event: { payload: string }) => void>,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: string }) => void) => {
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
let unpushedList: string[] = [];
/** The folder the side panel's tree watches (`watch_dir`'s `path`). */
const PROJECT_DIR = "/tmp/test-project";

const fire = (payload = PROJECT_DIR) =>
  act(async () => {
    fsChange.forEach((handler) => handler({ payload }));
  });
const calls = (cmd: string) => mockInvoke.mock.calls.filter(([c]) => c === cmd).length;

beforeEach(() => {
  vi.clearAllMocks();
  clearFileViewSnapshots();
  fsChange.length = 0;
  unstaged = 163;
  unpushedList = [];
  settingsState.settings = null;
  useGitDirtyStore.setState({ byId: {} });
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "git_status")
      return Promise.resolve({ staged: 0, unstaged, untracked: 0, has_remote: false, is_repo: true, behind: 0 });
    if (cmd === "git_unpushed_commits") return Promise.resolve(unpushedList);
    if (cmd === "git_dirty_probe")
      return Promise.resolve({
        status: { staged: 0, unstaged, untracked: 0, has_remote: false, is_repo: true, behind: 0 },
        unpushed: unstaged === 0 ? unpushedList.length : 0,
      });
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
  it("follows the repo under the Files view through the pill dot, not the full counts", async () => {
    render(<SidePanel open={true} />);
    await settle();
    expect(gitButton().className).toContain("toolbar-btn--flagged");
    const statusReads = calls("git_status");

    unstaged = 0; // committed from a terminal
    await fire();
    await settle(1_100);
    expect(gitButton().className).not.toContain("toolbar-btn--flagged");
    expect(useGitDirtyStore.getState().byId["proj-1"]).toBe("clean");
    // One cheap dot probe, no full re-read (git_status + unpushed: 5 spawns).
    expect(calls("git_dirty_probe")).toBe(1);
    expect(calls("git_status")).toBe(statusReads);
  });

  it("coalesces a burst of events in the Files view into one dot probe", async () => {
    render(<SidePanel open={true} />);
    await settle();
    for (let i = 0; i < 10; i += 1) await fire();
    await settle(1_100);
    expect(calls("git_dirty_probe")).toBe(1);
  });

  it("ignores events for another tree's folder", async () => {
    render(<SidePanel open={true} />);
    await settle();
    const listings = calls("list_dir");
    await fire("/tmp/other-project");
    await fire(`${PROJECT_DIR}-sibling`);
    await settle(1_100);
    expect(calls("git_dirty_probe")).toBe(0);
    expect(calls("list_dir")).toBe(listings);
    // Its own folder still re-lists the tree.
    await fire();
    await settle(400);
    expect(calls("list_dir")).toBeGreaterThan(listings);
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
    // The Git view: there the watcher drives the full reading.
    settingsState.settings = { side_panel_view: "git" };
    render(<SidePanel open={true} />);
    await settle();
    expect(useGitDirtyStore.getState().byId["proj-1"]).toBe("unpushed");

    unpushedFails = true;
    await fire();
    await settle(1_100);
    expect(useGitDirtyStore.getState().byId["proj-1"]).toBe("unpushed");
    expect(gitButton().className).toContain("toolbar-btn--flagged");
  });

  it("follows a burst of events in the Git view with one full reading a second", async () => {
    settingsState.settings = { side_panel_view: "git" };
    render(<SidePanel open={true} />);
    await settle();
    expect(screen.getByText("Add (163)")).toBeTruthy();
    const statusReads = calls("git_status");

    unstaged = 0;
    for (let i = 0; i < 10; i += 1) await fire();
    await settle(400);
    // Not yet: the burst waits out the coalescing second.
    expect(calls("git_status")).toBe(statusReads);
    await settle(800);
    expect(calls("git_status")).toBe(statusReads + 1);
    expect(screen.queryByText("Add (163)")).toBeNull();
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
    // The 5 s poll, then the coalescing second (`coalescedRun`).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_200);
    });
    expect(screen.queryByText("Add (163)")).toBeNull();
  });
});
