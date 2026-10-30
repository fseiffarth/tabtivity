/**
 * Remote ⇄ Remote-only from the pill's Edit group (`docs/remote_only_projects_plan.md`
 * E8/F9). "Stop keeping a local copy…" previews what lives only in the mirror and
 * keeps the confirm disarmed while anything does (local tabs included); once clean
 * it sends the preview's fingerprint and names the folder the mirror is kept at. A
 * changed mirror re-runs the preview. "Keep a local copy…" sends `keepLocalCopy:
 * true` and then turns lockstep on. Neither row exists on a VM project, and both
 * wait for a connected host.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, fireEvent, screen, cleanup } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ startDragging: () => Promise.resolve() }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
  confirm: vi.fn().mockResolvedValue(false),
  message: vi.fn().mockResolvedValue(null),
}));

import { ProjectSwitcher } from "../../components/layout/ProjectSwitcher";
import { useProjectsStore } from "../../stores/projects";
import { useBoxesStore } from "../../stores/boxes";
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import { useTabsStore } from "../../stores/tabs";
import { BRAND } from "../../lib/brand";
import type { ProjectEntry, RemoteSpec, UnpairPreview } from "../../types";

const SSH: RemoteSpec = { user: "ada", host: "box.example", remote_path: "/srv/app" };
const STOP = "Stop keeping a local copy…";
const KEEP = "Keep a local copy…";

function project(extra: Partial<ProjectEntry>): ProjectEntry {
  return {
    id: "p1",
    name: "Proj",
    status: "active",
    position: 0,
    local_file: "/tmp/state/remote-projects/p1/project.json",
    directory: "/tmp/state/remote-projects/p1",
    git_type: "local",
    ...extra,
  };
}

function preview(extra: Partial<UnpairPreview> = {}): UnpairPreview {
  return {
    lockstepEnabled: true,
    mirrorIsRepo: true,
    commitsNotOnHost: 0,
    uncommitted: 0,
    unpushedSyncEdits: 0,
    localTabs: 0,
    stoppedWorkers: [],
    mirrorPath: "/tmp/state/remote-projects/p1/mirror",
    mirrorExists: true,
    keptAt: "/home/ada/projects-ssh/proj (local copy)",
    moves: true,
    fingerprint: "fp1",
    ...extra,
  };
}

type Handler = (args: Record<string, unknown>) => unknown;

function stub(handlers: Record<string, Handler> = {}) {
  invoke.mockImplementation((cmd: string, args: Record<string, unknown>) => {
    if (cmd in handlers) {
      try {
        return Promise.resolve(handlers[cmd](args));
      } catch (err) {
        return Promise.reject(err);
      }
    }
    if (cmd === "list_project_endings" || cmd === "get_opened_windows" || cmd === "detect_project_ides")
      return Promise.resolve([]);
    return Promise.resolve(null);
  });
}

async function openPillMenu(entry: ProjectEntry, connected = true) {
  useProjectsStore.setState({ projects: [entry], activeId: "p1", loaded: true });
  useRemoteStatusStore.setState({
    byProject: connected ? { p1: { ssh: "connected", vpn: "off" } } : {},
    byHost: {},
  });
  let container: HTMLElement;
  await act(async () => {
    ({ container } = render(<ProjectSwitcher open />));
  });
  await act(async () => {
    fireEvent.contextMenu(container!.querySelector(".project-pill") as HTMLElement);
  });
}

const row = (label: string) =>
  screen.queryAllByRole("button").find((b) => b.textContent?.trim().startsWith(label)) ?? null;

const dialogButton = (label: string) =>
  [...screen.getByRole("dialog").querySelectorAll("button")].find((b) => b.textContent === label) as
    | HTMLButtonElement
    | undefined;

async function click(el: Element) {
  await act(async () => {
    fireEvent.click(el);
  });
}

describe("pill menu · keeping a local copy or not", () => {
  beforeEach(() => {
    invoke.mockReset();
    stub();
    useBoxesStore.setState({ boxes: [] });
  });
  afterEach(() => cleanup());

  it("offers each direction on its own kind and neither on a VM", async () => {
    await openPillMenu(project({ remote: SSH }));
    expect(row(STOP)).toBeTruthy();
    expect(row(KEEP)).toBeNull();
    cleanup();
    await openPillMenu(project({ remote: { ...SSH, remote_only: true } }));
    expect(row(KEEP)).toBeTruthy();
    expect(row(STOP)).toBeNull();
    cleanup();
    await openPillMenu(project({ remote: { ...SSH, vm: true }, vm: { enabled: true } }));
    expect(row(STOP)).toBeNull();
    expect(row(KEEP)).toBeNull();
    cleanup();
    await openPillMenu(project({ remote: { ...SSH, vm: true } }));
    expect(row(STOP)).toBeNull();
    expect(row(KEEP)).toBeNull();
  });

  it("waits for a connected host", async () => {
    await openPillMenu(project({ remote: SSH }), false);
    expect((row(STOP) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    await openPillMenu(project({ remote: { ...SSH, remote_only: true } }), false);
    expect((row(KEEP) as HTMLButtonElement).disabled).toBe(true);
  });

  it("blocks the confirm while the preview finds work only the mirror holds", async () => {
    stub({ remote_unpair_mirror_preview: () => preview({ commitsNotOnHost: 2, localTabs: 1 }) });
    await openPillMenu(project({ remote: SSH }));
    await click(row(STOP)!);
    expect(screen.getByText("Commits in the local copy that are not on the host: 2")).toBeTruthy();
    expect(screen.getByText(/Tabs running on this computer: 1\./)).toBeTruthy();
    expect(screen.getByText("Push, sync or close these first.")).toBeTruthy();
    const confirm = dialogButton("Stop keeping a local copy")!;
    expect(confirm.disabled).toBe(true);
    await click(confirm);
    expect(invoke).not.toHaveBeenCalledWith("remote_unpair_mirror", expect.anything());
  });

  it("counts this window's live local tabs too, before the layout is saved", async () => {
    stub({ remote_unpair_mirror_preview: () => preview() });
    useTabsStore.setState({
      tabsByScope: {
        p1: [
          { key: "a1", label: "claude", kind: "agent", cmd: "claude", cwd: "/x" },
          { key: "s1", label: "sh", kind: "shell", cmd: "", cwd: "/x" },
        ],
      },
    } as never);
    await openPillMenu(project({ remote: SSH }));
    await click(row(STOP)!);
    expect(screen.getByText(/Tabs running on this computer: 1\./)).toBeTruthy();
    expect(dialogButton("Stop keeping a local copy")!.disabled).toBe(true);
    useTabsStore.setState({ tabsByScope: {} } as never);
  });

  it("converts with the preview's fingerprint and shows where the folder is kept", async () => {
    const kept = "/home/ada/projects-ssh/proj (local copy)";
    stub({
      remote_unpair_mirror_preview: () => preview({ stoppedWorkers: ["gpu"] }),
      remote_unpair_mirror: () => ({
        entry: project({ remote: { ...SSH, remote_only: true } }),
        keptAt: kept,
        moved: true,
        moveError: null,
      }),
    });
    await openPillMenu(project({ remote: SSH }));
    await click(row(STOP)!);
    expect(screen.getByTestId("stop-local-copy-kept").textContent).toBe(kept);
    expect(screen.getByText(/stop receiving code from the local copy: gpu/)).toBeTruthy();
    await click(dialogButton("Stop keeping a local copy")!);
    expect(invoke).toHaveBeenCalledWith("remote_unpair_mirror", { projectId: "p1", expect: "fp1" });
    expect(screen.getByText(`The old local copy is kept at ${kept}.`)).toBeTruthy();
    expect(useProjectsStore.getState().projects[0].remote?.remote_only).toBe(true);
  });

  it("re-runs the preview when the mirror changed since it", async () => {
    let previews = 0;
    stub({
      remote_unpair_mirror_preview: () => preview({ fingerprint: `fp${++previews}` }),
      remote_unpair_mirror: () => {
        throw `${BRAND.upper}_MIRROR_CHANGED: the local copy changed`;
      },
    });
    await openPillMenu(project({ remote: SSH }));
    await click(row(STOP)!);
    await click(dialogButton("Stop keeping a local copy")!);
    expect(previews).toBe(2);
    expect(screen.getByText(/The local copy changed since this check/)).toBeTruthy();
    stub({ remote_unpair_mirror_preview: () => preview({ fingerprint: "fp2" }), remote_unpair_mirror: () => {
      throw "stop";
    } });
    await click(dialogButton("Stop keeping a local copy")!);
    expect(invoke).toHaveBeenLastCalledWith("remote_unpair_mirror", { projectId: "p1", expect: "fp2" });
  });

  it("keeps a local copy with keepLocalCopy, pinning the tabs first, then pairs", async () => {
    const order: string[] = [];
    stub({
      remote_mirror_status: () => ({ path: "", exists: false, suggested: "/home/ada/projects-ssh/proj", remoteOnly: true }),
      remote_download_size: () => ({ files: 3, bytes: 2048 }),
      set_remote_mirror_dir: (args) => {
        order.push("set");
        const agent = useTabsStore.getState().tabsByScope.p1?.find((t) => t.key === "a1");
        order.push(`agent:${agent?.location}`);
        return args.path;
      },
      git_peer_set_enabled: () => {
        order.push("pair");
        return { enabled: true };
      },
    });
    useTabsStore.setState({
      tabsByScope: { p1: [{ key: "a1", label: "claude", kind: "agent", cmd: "claude", cwd: "/x" }] },
    } as never);
    await openPillMenu(project({ remote: { ...SSH, remote_only: true } }));
    await click(row(KEEP)!);
    expect(screen.getByTestId("keep-local-copy-folder").textContent).toBe("/home/ada/projects-ssh/proj");
    expect(screen.getByText("The host folder holds 3 files (2.0 KB).")).toBeTruthy();
    await click(dialogButton("Keep a local copy")!);
    expect(invoke).toHaveBeenCalledWith("set_remote_mirror_dir", {
      projectId: "p1",
      path: "/home/ada/projects-ssh/proj",
      keepLocalCopy: true,
    });
    expect(order).toEqual(["set", "agent:remote", "pair"]);
    const stored = useProjectsStore.getState().projects[0];
    expect(stored.remote?.remote_only).toBeUndefined();
    expect((stored as ProjectEntry & { mirror?: string }).mirror).toBe("/home/ada/projects-ssh/proj");
  });
});
