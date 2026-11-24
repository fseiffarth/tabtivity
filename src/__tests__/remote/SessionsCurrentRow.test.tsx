/**
 * The Sessions view marks the row of the session the tab in front runs:
 * highlighted (`selected`, `aria-current`) and "this tab" in place of "open".
 * Another tab's session stays a plain "open" row.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import type { ProjectEntry, Settings } from "../../types";
import { clearFileViewSnapshots } from "../../lib/projects/fileViewSnapshots";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
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

import * as settingsModule from "../../stores/settings";
import { SidePanel } from "../../components/layout/SidePanel";
import { useProjectsStore } from "../../stores/projects";
import { useTabsStore } from "../../stores/tabs";
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import { useHostSessionsStore } from "../../stores/remote/hostSessions";
import { usePowerStore } from "../../stores/power";

const settingsState = (settingsModule as unknown as {
  __state: { settings: Settings | null };
}).__state;

const PID = "current-row-proj";

const PROJECT: ProjectEntry = {
  id: PID,
  name: "proj",
  status: "active",
  position: 0,
  local_file: `/p/${PID}/project.json`,
  remote: { host: "gpu.example", remote_path: "/home/me/proj" },
} as ProjectEntry;

function session(name: string) {
  return {
    name,
    windows: 1,
    created: 1,
    attached: true,
    activity: 1,
    currentCommand: "bash",
    working: false,
    currentPath: "/home/me/proj",
  };
}

function attachTab(name: string) {
  return { label: name, cmd: "", args: [], cwd: "/home/me/proj", kind: "shell" as const, location: "remote" as const, tmuxAttach: name };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearFileViewSnapshots();
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "remote_tmux_list") return Promise.resolve(["front", "behind"].map(session));
    if (cmd === "list_dir" || cmd === "list_project_endings") return Promise.resolve([]);
    return Promise.resolve(null);
  });
  settingsState.settings = { side_panel_view_by_project: { [PID]: "sessions" } } as unknown as Settings;
  usePowerStore.setState({ blurred: false });
  useHostSessionsStore.setState({ byProject: {}, showAll: {} });
  useProjectsStore.setState({ projects: [PROJECT], activeId: PID });
  useRemoteStatusStore.getState().setSsh(PID, "connected");
});

describe("Sessions view: the current tab's session", () => {
  it("highlights the front tab's row and follows the active tab", async () => {
    act(() => {
      useTabsStore.getState().setScope(PID);
      useTabsStore.getState().addTabToScope(PID, attachTab("behind"));
      useTabsStore.getState().addTabToScope(PID, attachTab("front"));
    });
    const tabs = useTabsStore.getState().tabsByScope[PID] ?? [];
    const frontKey = tabs.find((t) => t.tmuxAttach === "front")!.key;
    const behindKey = tabs.find((t) => t.tmuxAttach === "behind")!.key;
    act(() => useTabsStore.getState().setActive(frontKey));

    await act(async () => {
      render(<SidePanel open={true} />);
    });
    const row = (name: string) => screen.getByText(name).closest(".sp-row")!;
    await screen.findByText("front");

    expect(row("front").classList.contains("selected")).toBe(true);
    expect(row("front").getAttribute("aria-current")).toBe("true");
    expect(row("front").textContent).toContain("this tab");
    expect(row("behind").classList.contains("selected")).toBe(false);
    expect(row("behind").textContent).toContain("open");

    act(() => useTabsStore.getState().setActive(behindKey));
    expect(row("behind").classList.contains("selected")).toBe(true);
    expect(row("front").classList.contains("selected")).toBe(false);
  });
});
