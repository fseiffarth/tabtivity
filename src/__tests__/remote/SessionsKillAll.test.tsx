/**
 * The Sessions view's per-machine "Kill all" and "Kill closed": one confirm,
 * then a kill for exactly the rows that machine's group lists (all, or those
 * with no owning tab and no attached client) — never the other machine's, and
 * every killed row drops from the shared list once its kill lands.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, within } from "@testing-library/react";
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
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import { useHostSessionsStore } from "../../stores/remote/hostSessions";
import { usePowerStore } from "../../stores/power";

const settingsState = (settingsModule as unknown as {
  __state: { settings: Settings | null };
}).__state;

const PID = "kill-all-proj";

const PROJECT: ProjectEntry = {
  id: PID,
  name: "proj",
  status: "active",
  position: 0,
  local_file: `/p/${PID}/project.json`,
  remote: { host: "gpu.example", remote_path: "/home/me/proj" },
  compute_hosts: [{ id: "w1", label: "worker", host: "worker.example" }],
} as ProjectEntry;

function session(name: string) {
  return {
    name,
    windows: 1,
    created: 1,
    attached: ATTACHED.has(name),
    activity: 1,
    currentCommand: "bash",
    working: false,
    currentPath: "/home/me/proj",
  };
}

const LISTS: Record<string, string[]> = { primary: ["a", "b"], w1: ["c"] };
/** Sessions a client is attached to — not "closed" though no tab here owns them. */
const ATTACHED = new Set(["a"]);

beforeEach(() => {
  vi.clearAllMocks();
  clearFileViewSnapshots();
  mockInvoke.mockImplementation((cmd: string, args?: { hostId?: string }) => {
    if (cmd === "remote_tmux_list")
      return Promise.resolve((LISTS[args?.hostId ?? ""] ?? []).map(session));
    if (cmd === "remote_tmux_kill") return Promise.resolve(null);
    if (cmd === "list_dir" || cmd === "list_project_endings") return Promise.resolve([]);
    return Promise.resolve(null);
  });
  settingsState.settings = {
    side_panel_view_by_project: { [PID]: "sessions" },
  } as unknown as Settings;
  usePowerStore.setState({ blurred: false });
  useHostSessionsStore.setState({ byProject: {}, showAll: {} });
  useProjectsStore.setState({ projects: [PROJECT], activeId: PID });
  useRemoteStatusStore.getState().setSsh(PID, "connected");
  useRemoteStatusStore.getState().setSsh(PID, "connected", "w1");
});

describe("Sessions view: kill all per machine", () => {
  it("kills every session the machine lists, and only those", async () => {
    await act(async () => {
      render(<SidePanel open={true} />);
    });
    const primary = await screen.findByRole("region", { name: /gpu\.example/ });
    await within(primary).findByText("a");

    await act(async () => {
      fireEvent.click(within(primary).getByRole("button", { name: "Kill all sessions on gpu.example" }));
    });
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("2");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Kill all" }));
    });

    const kills = mockInvoke.mock.calls
      .filter(([cmd]) => cmd === "remote_tmux_kill")
      .map(([, a]) => `${(a as { hostId: string }).hostId}/${(a as { session: string }).session}`);
    expect(kills.sort()).toEqual(["primary/a", "primary/b"]);
    const rows = useHostSessionsStore.getState().byProject[PID].map((r) => `${r.hostId}/${r.session.name}`);
    expect(rows).toEqual(["w1/c"]);
  });

  it("kills nothing when the confirm is cancelled", async () => {
    await act(async () => {
      render(<SidePanel open={true} />);
    });
    const worker = await screen.findByRole("region", { name: /worker/ });
    await within(worker).findByText("c");
    await act(async () => {
      fireEvent.click(within(worker).getByRole("button", { name: "Kill all sessions on worker" }));
    });
    const dialog = await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    });
    expect(mockInvoke.mock.calls.some(([cmd]) => cmd === "remote_tmux_kill")).toBe(false);
  });

  it("Kill closed spares a session a client is attached to", async () => {
    await act(async () => {
      render(<SidePanel open={true} />);
    });
    const primary = await screen.findByRole("region", { name: /gpu\.example/ });
    await within(primary).findByText("a");
    await act(async () => {
      fireEvent.click(within(primary).getByRole("button", { name: "Kill closed sessions on gpu.example" }));
    });
    const dialog = await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Kill closed" }));
    });
    const kills = mockInvoke.mock.calls
      .filter(([cmd]) => cmd === "remote_tmux_kill")
      .map(([, a]) => `${(a as { hostId: string }).hostId}/${(a as { session: string }).session}`);
    expect(kills).toEqual(["primary/b"]);
    const rows = useHostSessionsStore.getState().byProject[PID].map((r) => `${r.hostId}/${r.session.name}`);
    expect(rows.sort()).toEqual(["primary/a", "w1/c"]);
  });
});
