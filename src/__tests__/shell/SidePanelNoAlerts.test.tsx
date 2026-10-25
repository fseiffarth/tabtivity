/**
 * The Alerts used to be a group stacked below the side panel's body. The rows
 * are machine-wide, so they now open from the header bell's hover
 * (`header/AlertsToggle`, see `HeaderAlertsMenu.test.tsx`) and no view of the
 * panel — whatever `files_alerts` says — renders them any more.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import type { Settings } from "../../types";
import { clearFileViewSnapshots } from "../../lib/projects/fileViewSnapshots";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("../../stores/projects", () => ({ useProjectsStore: vi.fn() }));
vi.mock("../../stores/windows", () => ({
  useWindowsStore: () => ({ windows: [], refresh: vi.fn(), untrack: vi.fn(), closeApp: vi.fn() }),
}));
vi.mock("../../stores/settings", () => {
  const state: {
    settings: Settings | null;
    updateSettings: (patch: Partial<Settings>) => Promise<void>;
  } = { settings: null, updateSettings: vi.fn(async () => {}) };
  return {
    __state: state,
    useSettingsStore: (selector?: (s: typeof state) => unknown) =>
      selector ? selector(state) : state,
  };
});

import { useProjectsStore } from "../../stores/projects";
import * as settingsModule from "../../stores/settings";
import { SidePanel } from "../../components/layout/SidePanel";

// Selector-aware, like the real zustand hook: the panel reads each field
// through its own selector, so a mock that returned the whole state for every
// call handed `projects` the state object itself.
function mockProjectsState(state: { projects: unknown[]; activeId: string | null }) {
  const full = { sidePanelFolderByProject: {}, setSidePanelFolder: vi.fn(), rootDir: null, ...state };
  vi.mocked(useProjectsStore).mockImplementation(((sel?: (s: typeof full) => unknown) =>
    sel ? sel(full) : full) as unknown as typeof useProjectsStore);
}

const settingsState = (settingsModule as unknown as {
  __state: { settings: Settings | null; updateSettings: ReturnType<typeof vi.fn> };
}).__state;

const LOCAL_PROJECT = {
  id: "proj-1",
  name: "TestProject",
  status: "active",
  position: 0,
  local_file: "/tmp/test-project/project.json",
};

beforeEach(() => {
  vi.clearAllMocks();
  clearFileViewSnapshots();
  settingsState.settings = null;
  settingsState.updateSettings = vi.fn(async () => {});
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "git_status")
      return Promise.resolve({ staged: 0, unstaged: 0, untracked: 0, has_remote: false, is_repo: true });
    if (cmd === "git_unpushed_commits") return Promise.resolve([]);
    if (cmd === "git_file_statuses") return Promise.resolve({});
    if (cmd === "git_change_stats") return Promise.resolve([]);
    if (cmd === "load_project") return Promise.resolve({});
    if (cmd === "list_project_endings") return Promise.resolve([]);
    if (cmd === "list_dir") return Promise.resolve([]);
    return Promise.resolve(null);
  });
  mockProjectsState({ projects: [LOCAL_PROJECT], activeId: "proj-1" });
});

async function renderOnView(view: string) {
  settingsState.settings = {
    files_alerts: true,
    side_panel_view_by_project: { "proj-1": view },
  } as Settings;
  let container!: HTMLElement;
  await act(async () => {
    container = render(<SidePanel open={true} />).container;
  });
  return container;
}

describe("side panel alerts", () => {
  it.each(["files", "git", "orange", "agents", "windows"])(
    "renders no alerts group in the %s view",
    async (view) => {
      const container = await renderOnView(view);
      expect(container.querySelector(".alerts-section")).toBeNull();
    },
  );

  it("is a view the panel really entered, not a silent fall back to Files", async () => {
    // Guards the case above: a view that was unavailable would render Files
    // while claiming to prove nothing about the others.
    const container = await renderOnView("git");
    expect(screen.getByRole("button", { name: "Git" }).getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".alerts-section")).toBeNull();
  });
});
