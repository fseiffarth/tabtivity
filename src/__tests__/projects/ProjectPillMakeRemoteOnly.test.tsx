/**
 * Local → Remote-only from the pill (`docs/done/remote_only_projects_plan.md` D7):
 * "Make remote only…" opens the Extend dialog with its local-copy switch off,
 * and once that extend landed the pill opens the Stop-keeping check — but only
 * after the host is connected, since the check asks it which commits it has.
 * The Extend dialog itself is stubbed here (its own test drives it).
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
vi.mock("../../components/projects/ExtendToRemoteDialog", () => ({
  ExtendToRemoteDialog: (props: {
    initialKeepLocalCopy?: boolean;
    onExtended?: (keep: boolean) => void;
    onClose: () => void;
  }) => (
    <button
      type="button"
      onClick={() => {
        props.onExtended?.(props.initialKeepLocalCopy ?? true);
        props.onClose();
      }}
    >
      {`fake-extend keep=${String(props.initialKeepLocalCopy)}`}
    </button>
  ),
}));

import { ProjectSwitcher } from "../../components/layout/ProjectSwitcher";
import { useProjectsStore } from "../../stores/projects";
import { useBoxesStore } from "../../stores/boxes";
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import type { ProjectEntry, RemoteSpec, UnpairPreview } from "../../types";

const SSH: RemoteSpec = { user: "ada", host: "box.example", remote_path: "/srv/proj" };
const LOCAL: ProjectEntry = {
  id: "p1",
  name: "Proj",
  status: "active",
  position: 0,
  local_file: "/home/ada/proj/project.json",
  directory: "/home/ada/proj",
  git_type: "local",
};

const PREVIEW: UnpairPreview = {
  lockstepEnabled: true,
  mirrorIsRepo: true,
  commitsNotOnHost: 0,
  uncommitted: 0,
  unpushedSyncEdits: 0,
  localTabs: 0,
  stoppedWorkers: [],
  mirrorPath: "/home/ada/proj",
  mirrorExists: true,
  keptAt: "/home/ada/proj",
  moves: false,
  fingerprint: "fp1",
};

const row = (label: string) =>
  screen.queryAllByRole("button").find((b) => b.textContent?.trim().startsWith(label)) ?? null;

async function click(el: Element) {
  await act(async () => {
    fireEvent.click(el);
  });
}

describe("pill menu · Make remote only…", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "remote_unpair_mirror_preview") return Promise.resolve(PREVIEW);
      if (cmd === "list_project_endings" || cmd === "get_opened_windows" || cmd === "detect_project_ides")
        return Promise.resolve([]);
      return Promise.resolve(null);
    });
    useBoxesStore.setState({ boxes: [] });
    useProjectsStore.setState({ projects: [LOCAL], activeId: "p1", loaded: true });
    useRemoteStatusStore.setState({ byProject: {}, byHost: {} });
  });
  afterEach(() => cleanup());

  it("extends with the local copy off, then opens the check once the host is connected", async () => {
    let container: HTMLElement;
    await act(async () => {
      ({ container } = render(<ProjectSwitcher open />));
    });
    await act(async () => {
      fireEvent.contextMenu(container!.querySelector(".project-pill") as HTMLElement);
    });
    await click(row("Make remote only…")!);
    // What a real extend leaves behind: a plain Remote project, still connecting.
    await act(async () => {
      useProjectsStore.setState({ projects: [{ ...LOCAL, remote: SSH }] });
    });
    await click(screen.getByText("fake-extend keep=false"));
    expect(screen.queryByText("Stop keeping a local copy of Proj?")).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("remote_unpair_mirror_preview", expect.anything());
    await act(async () => {
      useRemoteStatusStore.setState({ byProject: { p1: { ssh: "connected", vpn: "off" } }, byHost: {} });
    });
    expect(screen.getByText("Stop keeping a local copy of Proj?")).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("remote_unpair_mirror_preview", { projectId: "p1" });
  });

  it("a plain Extend to remote… opens no check", async () => {
    useRemoteStatusStore.setState({ byProject: { p1: { ssh: "connected", vpn: "off" } }, byHost: {} });
    let container: HTMLElement;
    await act(async () => {
      ({ container } = render(<ProjectSwitcher open />));
    });
    await act(async () => {
      fireEvent.contextMenu(container!.querySelector(".project-pill") as HTMLElement);
    });
    await click(row("Extend to remote…")!);
    await act(async () => {
      useProjectsStore.setState({ projects: [{ ...LOCAL, remote: SSH }] });
    });
    await click(screen.getByText("fake-extend keep=true"));
    expect(screen.queryByText("Stop keeping a local copy of Proj?")).toBeNull();
  });
});
