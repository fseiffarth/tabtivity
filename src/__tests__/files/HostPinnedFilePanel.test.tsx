/**
 * The file panel of a host-pinned project (`isHostPinned`: a VM, or a remote
 * project created without a local copy — `docs/remote_only_projects_plan.md`,
 * F4). The host is the only tree, so:
 * - no Local/Remote switch, no Diverged view, no ⧉, no whole-tree sync row and
 *   no per-row sync slots;
 * - disconnected, the tree area is the Connect prompt saying the files live
 *   only on the host — no listing is attempted;
 * - a host file never reaches an OS app (Shift-open / no built-in viewer): a
 *   message points at "Download to…" instead;
 * - search and quick open stay off until the host listing lands (E6a);
 * - the git history has no lockstep to pair.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react";
import type { ProjectEntry } from "../../types";

const { mockInvoke, mockOpenFileEntry } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockOpenFileEntry: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("../../lib/files/openFileEntry", () => ({ openFileEntry: mockOpenFileEntry }));

import { SidePanel } from "../../components/layout/SidePanel";
import { GitHistory } from "../../components/files/GitHistory";
import { QuickOpen } from "../../components/files/QuickOpen";
import { useProjectsStore } from "../../stores/projects";
import { useTabsStore } from "../../stores/tabs";
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import { useFileSourcePrefStore } from "../../stores/remote/fileSourcePref";
import { clearFileViewSnapshots } from "../../lib/projects/fileViewSnapshots";

const PINNED = {
  id: "p1",
  name: "p1",
  status: "active",
  position: 0,
  local_file: "/state/p1/project.json",
  remote: { host: "h", user: "u", remote_path: "/srv/p1", label: "lab-box", remote_only: true },
} as ProjectEntry;

function hostEntry(name: string, is_dir = false) {
  return {
    name,
    path: `/srv/p1/${name}`,
    is_dir,
    size: 1,
    extension: !is_dir && name.includes(".") ? name.slice(name.lastIndexOf(".")) : null,
    mime: null,
  };
}

function setupInvoke() {
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "list_dir") return Promise.resolve([hostEntry("data", true), hostEntry("notes.md"), hostEntry("blob.xyz")]);
    if (cmd === "git_status") {
      return Promise.resolve({ staged: 0, unstaged: 0, untracked: 0, has_remote: false, is_repo: false });
    }
    if (cmd === "git_log" || cmd === "git_branches" || cmd === "git_worktree_list") return Promise.resolve([]);
    if (cmd === "git_unpushed_commits") return Promise.resolve([]);
    if (cmd === "git_file_statuses") return Promise.resolve({});
    if (cmd === "list_project_endings") return Promise.resolve([]);
    if (cmd === "get_opened_windows") return Promise.resolve([]);
    if (cmd === "get_settings") return Promise.resolve({});
    if (cmd === "git_peer_status") return Promise.resolve({ enabled: false });
    return Promise.resolve(null);
  });
}

function setSsh(ssh: "off" | "connected") {
  useRemoteStatusStore.setState({ byProject: { p1: { ssh, vpn: "off" } }, byHost: {} });
}

async function renderPanel() {
  await act(async () => {
    render(<SidePanel open={true} />);
  });
}

const calls = (cmd: string) => mockInvoke.mock.calls.filter(([c]) => c === cmd);

describe("the file panel of a host-pinned project", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearFileViewSnapshots();
    setupInvoke();
    useProjectsStore.setState({
      projects: [PINNED],
      activeId: "p1",
      loaded: true,
      sidePanelFolderByProject: {},
    });
    useTabsStore.setState({ scope: "p1" });
    // A Local choice left over from before the pin must not resurface.
    useFileSourcePrefStore.setState({ byProject: { p1: "local" }, byViewer: {} });
  });

  it("lists the host tree with no switch, no Diverged view, no ⧉ and no sync overlay", async () => {
    setSsh("connected");
    await renderPanel();
    await screen.findByText("notes.md");
    // The listing is the host's: the project directory, never a mirror folder.
    expect(calls("list_dir").every(([, a]) => (a as { projectDir: string }).projectDir === "/state/p1")).toBe(true);
    expect(document.querySelector(".side-panel-source-switch")).toBeNull();
    expect(screen.queryByText("Diverged")).toBeNull();
    expect(screen.getByText("Sessions")).toBeTruthy();
    expect([...document.querySelectorAll("button")].some((b) => b.textContent === "⧉")).toBe(false);
    expect(document.querySelector(".file-sync-slot")).toBeNull();
    expect(screen.queryByText("Sync all")).toBeNull();
    expect(calls("sync_status")).toHaveLength(0);
    // Search stays off, and does not point at a Local side that isn't there.
    const hint = document.querySelector(".file-tree-search-remote-hint");
    expect(hint?.textContent).toContain("does not reach this project’s host yet");
  });

  it("disconnected, the tree area is the host-only Connect prompt and nothing is listed", async () => {
    setSsh("off");
    await renderPanel();
    expect(await screen.findByText("The files live only on lab-box. Connect to browse them.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
    expect(calls("list_dir")).toHaveLength(0);
    expect(document.querySelector(".side-panel-source-switch")).toBeNull();
  });

  it("a host file never reaches an OS app: Shift-open and no-viewer files point at Download to…", async () => {
    setSsh("connected");
    await renderPanel();
    const md = (await screen.findByText("notes.md")).closest(".file-entry")!;
    await act(async () => {
      fireEvent.doubleClick(md, { shiftKey: true });
    });
    expect(await screen.findByText("On the host only")).toBeTruthy();
    expect(screen.getByText(/choose “Download to…”/)).toBeTruthy();
    expect(mockOpenFileEntry).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "OK" }));
    });

    const blob = screen.getByText("blob.xyz").closest(".file-entry")!;
    await act(async () => {
      fireEvent.doubleClick(blob);
    });
    expect(await screen.findByText("On the host only")).toBeTruthy();
    expect(mockOpenFileEntry).not.toHaveBeenCalled();

    // A built-in viewer reads over SFTP, so a plain open still works.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "OK" }));
    });
    await act(async () => {
      fireEvent.doubleClick(md);
    });
    expect(mockOpenFileEntry).toHaveBeenCalledTimes(1);
  });

  it("quick open lists nothing from the state dir while the host listing is not there", async () => {
    setSsh("connected");
    await act(async () => {
      render(<QuickOpen />);
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: "p", ctrlKey: true });
    });
    expect(await screen.findByText(/finding them by name does not reach the host yet/)).toBeTruthy();
    expect(calls("list_project_paths")).toHaveLength(0);
  });
});

describe("the git history of a host-pinned project", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupInvoke();
  });

  it("asks for no lockstep and offers no mirror worktree site", async () => {
    await act(async () => {
      render(<GitHistory projectDir="/state/p1" projectId="p1" remote hostPinned connected />);
    });
    await waitFor(() => expect(calls("git_log").length).toBeGreaterThan(0));
    expect(calls("git_peer_status")).toHaveLength(0);
    expect(document.querySelector(".git-worktree-site")).toBeNull();
  });

  it("a plain remote project still does (control)", async () => {
    await act(async () => {
      render(<GitHistory projectDir="/state/p1" projectId="p1" remote connected />);
    });
    await waitFor(() => expect(calls("git_peer_status").length).toBeGreaterThan(0));
  });
});
