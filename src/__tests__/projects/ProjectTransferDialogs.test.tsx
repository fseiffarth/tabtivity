/**
 * Full project export / import (docs/context/project_transfer.md).
 *
 * What is pinned here is the part of the feature the backend cannot enforce:
 * that the dialogs tell the truth about the file *before* it is written or
 * unpacked. A bundle can be gigabytes and lands as a whole project on the far
 * side, so the numbers behind the toggles, the refusal for a project that
 * cannot travel, and the warnings about what does not travel are the feature —
 * without them "Export" is a button that produces a surprise.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
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

import { ProjectExportDialog } from "../../components/projects/ProjectExportDialog";
import { ProjectImportBundleDialog } from "../../components/projects/ProjectImportBundleDialog";
import type { BundleInfo, ExportPreview, ProjectEntry } from "../../types";
import { BRAND, NAMES } from "../../lib/brand";
import { useBoxesStore } from "../../stores/boxes";

const project: ProjectEntry = {
  id: "p1",
  name: "Thesis",
  status: "current",
  position: 10,
  local_file: "/home/me/work/thesis/project.json",
  directory: "/home/me/work/thesis",
};

const preview = (over: Partial<ExportPreview> = {}): ExportPreview => ({
  projectId: "p1",
  name: "Thesis",
  remote: false,
  directory: "/home/me/work/thesis",
  directoryMissing: false,
  mirror: null,
  mirrorMissing: false,
  files: 120,
  bytes: 5 * 1024 * 1024,
  gitFiles: 40,
  gitBytes: 200 * 1024 * 1024,
  rebuildableFiles: 9000,
  rebuildableBytes: 1024 * 1024 * 1024,
  tabs: 4,
  boxNames: ["Papers"],
  suggestedFileName: `thesis-2026-09-21.${NAMES.exportExtension}`,
  ...over,
});

const bundle = (over: Partial<BundleInfo> = {}): BundleInfo => ({
  path: `/media/stick/thesis.${NAMES.exportExtension}`,
  format: 1,
  appVersion: "0.1.76",
  exportedAt: "2026-09-20T10:00:00+00:00",
  projectId: "p1",
  name: "Thesis",
  remote: false,
  description: "The thesis",
  gitType: "local",
  directory: "/home/me/work/thesis",
  mirror: null,
  contents: {
    dir: true,
    state: false,
    mirror: false,
    gitHistory: true,
    rebuildableSkipped: true,
    files: 120,
    bytes: 5 * 1024 * 1024,
  },
  tabs: 4,
  boxNames: ["Papers"],
  timeDays: 31,
  idInUse: false,
  suggestedParent: `/home/me/${BRAND.slug}/projects`,
  ...over,
});

beforeEach(() => {
  mockInvoke.mockReset();
  mockSave.mockReset();
  mockOpen.mockReset();
});

describe("export dialog", () => {
  /** The toggles are only worth having if each one shows what it costs. */
  it("sizes each part of the project separately", async () => {
    mockInvoke.mockResolvedValue(preview());
    await act(async () => {
      render(<ProjectExportDialog project={project} onClose={() => {}} />);
    });

    expect(mockInvoke).toHaveBeenCalledWith("preview_project_export", {
      projectId: "p1",
    });
    // The tree, its history and its rebuildable folders are three numbers, not
    // one: the whole point is deciding which of them to carry.
    expect(screen.getByText(/120 files, 5\.0 MB/)).toBeTruthy();
    expect(screen.getByText(/200\.0 MB/)).toBeTruthy();
    expect(screen.getByText(/1\.0 GB/)).toBeTruthy();
    expect(screen.getByText(/4 saved tabs/)).toBeTruthy();
    // Default: files + history, rebuildable folders left out.
    expect(screen.getByText(/About 205\.0 MB before compression/)).toBeTruthy();
  });

  it("drops git history out of the estimate when its switch is turned off", async () => {
    mockInvoke.mockResolvedValue(preview());
    await act(async () => {
      render(<ProjectExportDialog project={project} onClose={() => {}} />);
    });

    await act(async () => {
      await userEvent.click(screen.getByRole("checkbox", { name: "Git history" }));
    });
    expect(screen.getByText(/About 5\.0 MB before compression/)).toBeTruthy();
  });

  it("names both things that never travel", async () => {
    mockInvoke.mockResolvedValue(preview());
    await act(async () => {
      render(<ProjectExportDialog project={project} onClose={() => {}} />);
    });
    // Passwords stay in the keychain and sync state is machine-bound. A user
    // who expects them to ride along loses a workday on the far side.
    expect(screen.getByText(/keychain/)).toBeTruthy();
    expect(screen.getByText(/Boxes: Papers/)).toBeTruthy();
  });

  it("refuses a project whose tree cannot be copied, and never opens a save dialog", async () => {
    mockInvoke.mockResolvedValue(preview({ blocked: "vm" }));
    await act(async () => {
      render(<ProjectExportDialog project={project} onClose={() => {}} />);
    });

    expect(screen.getByText(/disk image/)).toBeTruthy();
    const exportBtn = screen.getByRole("button", { name: "Export…" }) as HTMLButtonElement;
    expect(exportBtn.disabled).toBe(true);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("writes the bundle the save dialog chose, with the toggles as asked", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "preview_project_export") return Promise.resolve(preview());
      return Promise.resolve({
        path: `/media/stick/thesis.${NAMES.exportExtension}`,
        bytes: 4_000_000,
        files: 160,
        payloadBytes: 5_000_000,
        remote: false,
        notes: ["rebuildableSkipped"],
      });
    });
    mockSave.mockResolvedValue(`/media/stick/thesis.${NAMES.exportExtension}`);

    await act(async () => {
      render(<ProjectExportDialog project={project} onClose={() => {}} />);
    });
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "Export…" }));
    });

    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: `thesis-2026-09-21.${NAMES.exportExtension}` }),
    );
    expect(mockInvoke).toHaveBeenCalledWith("export_project", {
      req: {
        projectId: "p1",
        destPath: `/media/stick/thesis.${NAMES.exportExtension}`,
        includeFiles: true,
        includeGit: true,
        includeSession: true,
        includeMirror: true,
        skipRebuildable: true,
      },
    });
    expect(screen.getByText(/160 files/)).toBeTruthy();
    // The note the backend returned is worded, not printed as a token.
    expect(screen.getByText(/Rebuildable folders/)).toBeTruthy();
  });

  it("does nothing when the save dialog is cancelled", async () => {
    mockInvoke.mockResolvedValue(preview());
    mockSave.mockResolvedValue(null);
    await act(async () => {
      render(<ProjectExportDialog project={project} onClose={() => {}} />);
    });
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "Export…" }));
    });
    expect(
      mockInvoke.mock.calls.filter(([cmd]) => cmd === "export_project"),
    ).toHaveLength(0);
  });
});

describe("import dialog", () => {
  async function chooseBundle(info: BundleInfo) {
    mockOpen.mockResolvedValue(info.path);
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "inspect_project_export") return Promise.resolve(info);
      return Promise.resolve(null);
    });
    await act(async () => {
      render(<ProjectImportBundleDialog onClose={() => {}} onProject={() => {}} />);
    });
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "Choose file…" }));
    });
  }

  it("reads the file before asking anything, and says what is in it", async () => {
    await chooseBundle(bundle());
    expect(mockInvoke).toHaveBeenCalledWith("inspect_project_export", {
      bundlePath: `/media/stick/thesis.${NAMES.exportExtension}`,
    });
    expect(screen.getByText(new RegExp(String.raw`Thesis — exported 2026-09-20 by ${BRAND.display} 0\.1\.76`))).toBeTruthy();
    expect(screen.getByText(/120 files, 5\.0 MB/)).toBeTruthy();
    // Both gaps the bundle records are surfaced before the import, not after.
    expect(screen.getByText(/Rebuildable folders/)).toBeTruthy();
    expect(screen.getByText(/31 recorded days/)).toBeTruthy();
    const name = screen.getByDisplayValue("Thesis");
    expect(name).toBeTruthy();
    expect(screen.getByDisplayValue(`/home/me/${BRAND.slug}/projects`)).toBeTruthy();
  });

  it("warns that a remote project's credentials stay behind", async () => {
    await chooseBundle(bundle({ remote: true }));
    expect(screen.getByText(/sign in to the host again/i)).toBeTruthy();
  });

  it("says up front that an id already here means a new one", async () => {
    await chooseBundle(bundle({ idInUse: true }));
    expect(screen.getByText(/already registered here/)).toBeTruthy();
  });

  /** A remote bundle's host+path is its identity, and it does not move with the
   *  import — so a duplicate is a refusal, not a second project on one tree. */
  it("blocks an import whose host folder is already a project here", async () => {
    await chooseBundle(bundle({ remote: true, siteConflict: "Cluster work" }));
    expect(screen.getByText(/already the project 'Cluster work'/)).toBeTruthy();
    const importBtn = screen.getByRole("button", { name: "Import" }) as HTMLButtonElement;
    expect(importBtn.disabled).toBe(true);
  });

  it("imports with the chosen name, folder and switches, and reports the result", async () => {
    await chooseBundle(bundle());
    const entry: ProjectEntry = { ...project, id: "p2", name: "Thesis copy" };
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "inspect_project_export") return Promise.resolve(bundle());
      if (cmd === "get_boxes") {
        return Promise.resolve([{ id: "b1", name: "Papers", member_ids: ["p2"], position: 10, rev: 3 }]);
      }
      return Promise.resolve({
        entry,
        directory: `/home/me/${BRAND.slug}/projects/thesis-copy`,
        mirror: null,
        files: 120,
        tabsRestored: 4,
        tabsDowngraded: 1,
        newId: false,
        boxesJoined: ["Papers"],
        boxesMissing: ["Reading"],
        notes: ["sessionSanitized"],
      });
    });

    const nameField = screen.getByDisplayValue("Thesis");
    await act(async () => {
      await userEvent.clear(nameField);
      await userEvent.type(nameField, "Thesis copy");
      await userEvent.click(screen.getByRole("button", { name: "Import" }));
    });

    expect(mockInvoke).toHaveBeenCalledWith("import_project_export", {
      req: {
        bundlePath: `/media/stick/thesis.${NAMES.exportExtension}`,
        name: "Thesis copy",
        targetParent: `/home/me/${BRAND.slug}/projects`,
        mirrorParent: null,
        restoreSession: true,
        restoreTime: true,
        joinBoxes: true,
      },
    });
    expect(screen.getByText(/Thesis copy imported — 120 files/)).toBeTruthy();
    expect(screen.getByText(/4 tabs restored/)).toBeTruthy();
    expect(screen.getByText(/Added to: Papers/)).toBeTruthy();
    expect(screen.getByText(/No box here is named: Reading/)).toBeTruthy();
    // The downgrade is reported, so a tab that comes back as a bare shell is
    // explained rather than discovered.
    expect(screen.getByText(/came back as plain shells/)).toBeTruthy();
    // Joining a box wrote boxes.json: the store reloads it, so the pill shows
    // the member and the next box save carries the moved-on revision.
    await vi.waitFor(() =>
      expect(useBoxesStore.getState().boxes).toEqual([
        { id: "b1", name: "Papers", member_ids: ["p2"], position: 10, rev: 3 },
      ]),
    );
  });
});
