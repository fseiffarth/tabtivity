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
