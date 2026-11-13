/**
 * The transfer confirmation's take-newer ask names both directions in one
 * dialog, and any open ask is withdrawn when the user switches project.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));

import { SyncConfirmDialog } from "../../components/common/SyncConfirmDialog";
import { useProjectsStore } from "../../stores/projects";
import { confirmSyncTransfer, useSyncConfirmStore } from "../../stores/remote/syncConfirm";

const PREVIEW = {
  files: 1,
  bytes: 10,
  overwrites: 1,
  destructive: [],
  destructiveTotal: 0,
  conflicts: 0,
  tracked: 0,
  exact: true,
};

beforeEach(() => {
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(PREVIEW);
  useSyncConfirmStore.setState({ pending: null });
  useProjectsStore.setState({ activeId: "p1" });
});

describe("SyncConfirmDialog", () => {
  it("asks once for take-newer, naming each direction's files", async () => {
    render(<SyncConfirmDialog />);
    let answer: Promise<boolean> = Promise.resolve(false);
    act(() => {
      answer = confirmSyncTransfer({
        projectId: "p1",
        relPath: "",
        isDir: true,
        label: "proj",
        newer: { host: ["h.txt"], local: ["l.txt"] },
        force: true,
      });
    });
    expect(await screen.findByText("Take the newer copies?")).toBeTruthy();
    expect(screen.getByText(/newer on the host/)).toBeTruthy();
    expect(screen.getByText(/newer locally/)).toBeTruthy();
    expect(screen.getByText("h.txt")).toBeTruthy();
    expect(screen.getByText("l.txt")).toBeTruthy();
    act(() => screen.getByRole("button", { name: "Take newer" }).click());
    expect(await answer).toBe(true);
  });

  it("offers Git sync, not a lone Cancel, when only git-tracked files are in scope", async () => {
    mockInvoke.mockImplementation(async (cmd: string) =>
      cmd === "sync_transfer_preview"
        ? { ...PREVIEW, files: 0, bytes: 0, overwrites: 0, tracked: 1 }
        : {},
    );
    render(<SyncConfirmDialog />);
    let answer: Promise<boolean> = Promise.resolve(true);
    act(() => {
      answer = confirmSyncTransfer({
        projectId: "p1",
        direction: "push",
        relPath: "DATASETS.md",
        isDir: false,
        label: "DATASETS.md",
      });
    });
    expect(await screen.findByText(/reach the other side through Git sync/)).toBeTruthy();
    // No "will be copied to the host" headline over a transfer that moves nothing.
    expect(screen.queryByText(/will be copied to the host/)).toBeNull();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Copy to host|Overwrite host/ })).toBeNull();
    act(() => screen.getByRole("button", { name: /Sync Git now/ }).click());
    // Nothing moved as bytes, so the transfer's caller still reads "no".
    expect(await answer).toBe(false);
    expect(mockInvoke).toHaveBeenCalledWith("git_peer_sync_now", { projectId: "p1" });
  });

  it("stays open and names the reason when Git sync comes back out of step", async () => {
    mockInvoke.mockImplementation(async (cmd: string) =>
      cmd === "sync_transfer_preview"
        ? { ...PREVIEW, files: 0, bytes: 0, overwrites: 0, tracked: 2 }
        : { status: "desynchronized", detail: "fast-forward refused." },
    );
    render(<SyncConfirmDialog />);
    act(() => {
      void confirmSyncTransfer({
        projectId: "p1",
        direction: "push",
        relPath: "rgt",
        isDir: true,
        label: "rgt",
      });
    });
    act(() => {
      void screen.findByRole("button", { name: /Sync Git now/ }).then((b) => b.click());
    });
    expect(await screen.findByText(/not in step: fast-forward refused\./)).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("withdraws an open ask when the project switches", async () => {
    render(<SyncConfirmDialog />);
    let answer: Promise<boolean> = Promise.resolve(true);
    act(() => {
      answer = confirmSyncTransfer({
        projectId: "p1",
        direction: "pull",
        relPath: "",
        isDir: true,
        label: "proj",
      });
    });
    expect(await screen.findByRole("dialog")).toBeTruthy();
    act(() => useProjectsStore.setState({ activeId: "p2" }));
    expect(await answer).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
