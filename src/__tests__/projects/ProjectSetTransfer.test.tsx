/**
 * Several projects in one file (`commands::project_transfer::set`).
 *
 * Pinned: a set is measured before it is written and only measured,
 * exportable projects go in; a remote-only project's tree comes from the host
 * only while it is connected; and on import a set picked through the one
 * "Import Project File" runs the single import once per ticked member, so one
 * failure is named and the rest still land.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockInvoke, mockSave, mockOpen } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockSave: vi.fn(),
  mockOpen: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: mockSave,
  open: mockOpen,
}));

import {
  ProjectSetExportDialog,
  setRowBytes,
  suggestedSetName,
} from "../../components/projects/ProjectSetExportDialog";
import { ProjectImportBundleDialog } from "../../components/projects/ProjectImportBundleDialog";
import type { BundleInfo, ExportPreview, ProjectEntry, SetInfo } from "../../types";
import { BRAND, NAMES } from "../../lib/brand";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";

const MB = 1024 * 1024;

const local = (id: string, name: string): ProjectEntry => ({
  id,
  name,
  status: "inactive",
  position: 10,
  local_file: `/home/me/work/${id}/project.json`,
  directory: `/home/me/work/${id}`,
});

const hostOnly: ProjectEntry = {
  ...local("r1", "Cluster"),
  remote: { host: "hpc.example", user: "me", remote_path: "/scratch/me/run", remote_only: true },
};

const preview = (id: string, over: Partial<ExportPreview> = {}): ExportPreview => ({
  projectId: id,
  name: id,
  remote: false,
  directory: `/home/me/work/${id}`,
  directoryMissing: false,
  mirror: null,
  mirrorMissing: false,
  files: 10,
  bytes: 4 * MB,
  gitFiles: 5,
  gitBytes: 2 * MB,
  rebuildableFiles: 100,
  rebuildableBytes: 50 * MB,
  rebuildableDirs: [],
  skipped: 0,
  agentHistoryFiles: 0,
  agentHistoryBytes: 0,
  tabs: 2,
  boxNames: [],
  suggestedFileName: `${id}.${NAMES.exportExtension}`,
  ...over,
});

beforeEach(() => {
  cleanup();
  mockInvoke.mockReset();
  mockSave.mockReset();
  mockOpen.mockReset();
  useRemoteStatusStore.setState({ byProject: {} });
});

describe("set export helpers", () => {
  it("names the file by date with the bundle extension", () => {
    expect(suggestedSetName(new Date("2026-11-03T12:00:00Z"))).toBe(
      `projects-2026-11-03.${NAMES.exportExtension}`,
    );
  });

  it("counts a project's parts under the shared switches", () => {
    const opts = { includeFiles: true, includeGit: true, skipRebuildable: true, includeAgentHistory: false };
    expect(setRowBytes(preview("a"), opts)).toBe(6 * MB);
    expect(setRowBytes(preview("a"), { ...opts, includeGit: false, skipRebuildable: false })).toBe(54 * MB);
    expect(setRowBytes(preview("a"), { ...opts, includeFiles: false })).toBe(0);
    expect(setRowBytes(preview("a", { blocked: "vm" }), opts)).toBe(0);
    expect(setRowBytes(preview("a", { directoryMissing: true, agentHistoryBytes: MB }), { ...opts, includeAgentHistory: true })).toBe(MB);
  });
});

describe("set export dialog", () => {
  function setup(projects: ProjectEntry[], previews: Record<string, ExportPreview>) {
    useProjectsStore.setState({ projects } as never);
    mockInvoke.mockImplementation((cmd: string, args: { projectId?: string }) => {
      if (cmd === "preview_project_export") return Promise.resolve(previews[args.projectId!]);
      if (cmd === "export_project_set") {
        return Promise.resolve({ path: "/media/stick/set", bytes: 7 * MB, members: [] });
      }
      return Promise.resolve(null);
    });
  }

  it("measures only ticked projects and exports the measured, exportable ones", async () => {
    setup(
      [local("a", "Alpha"), local("b", "Beta"), local("v", "VM box")],
      { a: preview("a"), b: preview("b"), v: preview("v", { blocked: "vm" }) },
    );
    await act(async () => {
      render(<ProjectSetExportDialog onClose={() => {}} />);
    });
    expect(mockInvoke.mock.calls.filter(([cmd]) => cmd === "preview_project_export")).toHaveLength(0);

    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "Select all" }));
    });
    await vi.waitFor(() => expect(screen.getByText(/2 projects, about 12\.0 MB/)).toBeTruthy());
    expect(screen.getByText(/project VM cannot be exported/)).toBeTruthy();

    mockSave.mockResolvedValue("/media/stick/set");
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "Export…" }));
    });
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: expect.stringMatching(/^projects-\d{4}-\d{2}-\d{2}\./) }),
    );
    const call = mockInvoke.mock.calls.find(([cmd]) => cmd === "export_project_set");
    expect(call![1]).toEqual({
      req: {
        projectIds: ["a", "b"],
        destPath: "/media/stick/set",
        includeFiles: true,
        includeGit: true,
        includeSession: true,
        includeMirror: true,
        skipRebuildable: true,
        includeAgentHistory: false,
        hostCopy: [],
      },
    });
  });

  it("packs a remote-only project from the host only while it is connected", async () => {
    setup([hostOnly], { r1: preview("r1", { remote: true, remoteOnly: true, bytes: 0, files: 0 }) });
    await act(async () => {
      render(<ProjectSetExportDialog onClose={() => {}} />);
    });
    await act(async () => {
      await userEvent.click(screen.getByRole("checkbox", { name: "Cluster" }));
    });
    await vi.waitFor(() => expect(screen.getByText(/Host offline — settings only/)).toBeTruthy());

    act(() => {
      useRemoteStatusStore.setState({ byProject: { r1: { ssh: "connected" } } } as never);
    });
    expect(screen.getByText("Files from the host")).toBeTruthy();
    mockSave.mockResolvedValue("/media/stick/set");
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "Export…" }));
    });
    const call = mockInvoke.mock.calls.find(([cmd]) => cmd === "export_project_set");
    expect((call![1] as { req: { hostCopy: string[] } }).req.hostCopy).toEqual(["r1"]);
  });
});

describe("set import", () => {
  const member = (file: string, over: Partial<BundleInfo> = {}): BundleInfo => ({
    path: "/media/stick/set",
    member: file,
    format: 1,
    appVersion: "0.2.57",
    exportedAt: "2026-11-03T10:00:00+00:00",
    projectId: file,
    name: file,
    remote: false,
    description: null,
    gitType: null,
    directory: null,
    mirror: null,
    contents: { dir: true, state: false, mirror: false, gitHistory: true, rebuildableSkipped: true, files: 3, bytes: MB },
    tabs: 1,
    boxNames: [],
    timeDays: 0,
    idInUse: false,
    suggestedParent: "/x",
    ...over,
  });

  const set: SetInfo = {
    path: "/media/stick/set",
    appVersion: "0.2.57",
    exportedAt: "2026-11-03T10:00:00+00:00",
    members: [
      { member: "projects/01-a", info: member("projects/01-a", { name: "Alpha" }) },
      { member: "projects/02-b", info: member("projects/02-b", { name: "Beta" }) },
      {
        member: "projects/03-c",
        info: member("projects/03-c", { name: "Taken", remote: true, siteConflict: "Cluster work" }),
      },
      { member: "projects/04-d", error: "read projects/04-d: broken" },
    ],
    suggestedParent: `/home/me/${BRAND.slug}/projects`,
    suggestedMirrorParent: `/home/me/${BRAND.slug}/ssh`,
  };

  it("imports each ticked member in turn and names the one that failed", async () => {
    const onProject = vi.fn();
    mockOpen.mockResolvedValue(set.path);
    mockInvoke.mockImplementation((cmd: string, args: { req?: { member?: string } }) => {
      if (cmd === "inspect_project_bundle") return Promise.resolve({ kind: "set", set });
      if (cmd === "import_project_export") {
        if (args.req?.member === "projects/02-b") return Promise.reject("disk full");
        return Promise.resolve({
          entry: local("n1", "Alpha"),
          directory: `/home/me/${BRAND.slug}/projects/alpha`,
          files: 3,
          tabsRestored: 1,
          tabsDowngraded: 0,
          newId: false,
          boxesJoined: [],
          boxesMissing: [],
          agentFiles: 0,
          notes: ["rebuildableSkipped"],
        });
      }
      return Promise.resolve(null);
    });
    await act(async () => {
      render(<ProjectImportBundleDialog onClose={() => {}} onProject={onProject} />);
    });
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "Choose file…" }));
    });

    expect(screen.getByText(new RegExp(String.raw`4 projects — exported 2026-11-03 by ${BRAND.display} 0\.2\.57`))).toBeTruthy();
    // A member whose host folder is already a project, and an unreadable
    // one, cannot be ticked.
    expect((screen.getByRole("checkbox", { name: "Taken" }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("checkbox", { name: "projects/04-d" }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/already the project 'Cluster work'/)).toBeTruthy();
    // Only local members are ticked: no working-copy folder is asked for.
    expect(screen.queryByText(/working copies/)).toBeNull();

    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "Import 2" }));
    });
    const imports = mockInvoke.mock.calls.filter(([cmd]) => cmd === "import_project_export");
    expect(imports.map(([, a]) => (a as { req: { member: string } }).req.member)).toEqual([
      "projects/01-a",
      "projects/02-b",
    ]);
    expect(imports[0][1]).toEqual({
      req: {
        bundlePath: set.path,
        member: "projects/01-a",
        name: null,
        targetParent: `/home/me/${BRAND.slug}/projects`,
        mirrorParent: null,
        restoreSession: true,
        restoreTime: true,
        joinBoxes: true,
        restoreAgentHistory: true,
      },
    });
    expect(onProject).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/1 of 2 projects imported/)).toBeTruthy();
    expect(screen.getByText("disk full")).toBeTruthy();
    expect(screen.getByText(/Rebuildable folders/)).toBeTruthy();
  });
});
