/**
 * The diverged view's remote-only section: nothing touches the host until the
 * scan button, a pulled file leaves the list once the status knows it, and a
 * host delete asks first and drops only the files that actually went.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import { SyncHostOnlyFiles } from "../../components/files/SyncHostOnlyFiles";
import { useSyncConfirmStore } from "../../stores/remote/syncConfirm";
import type { SyncEntryStatus } from "../../stores/remote/sync";

const SCAN = {
  files: [
    { relPath: "logs/a.log", size: 1, mtime: 1 },
    { relPath: "logs/b.log", size: 1, mtime: 1 },
  ],
  truncated: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  useSyncConfirmStore.setState({ pending: null });
  mockInvoke.mockImplementation((cmd: string, args: Record<string, unknown> = {}) => {
    if (cmd === "sync_scan_host_new") return Promise.resolve(SCAN);
    if (cmd === "sync_apply_delete")
      return args.relPath === "logs/b.log" ? Promise.reject(new Error("refused")) : Promise.resolve();
    return Promise.resolve([]);
  });
});

const view = (syncMap?: Record<string, SyncEntryStatus>) => (
  <SyncHostOnlyFiles projectId="p" label="Project" remoteBlocked={false} syncMap={syncMap} />
);

describe("SyncHostOnlyFiles", () => {
  it("scans only on the button and lists what the status does not know", async () => {
    const { rerender } = render(view());
    expect(mockInvoke).not.toHaveBeenCalledWith("sync_scan_host_new", expect.anything());
    await userEvent.click(screen.getByRole("button", { name: "Find remote-only files" }));
    expect(mockInvoke).toHaveBeenCalledWith("sync_scan_host_new", { projectId: "p", confirmed: false });
    expect(await screen.findByText("logs/a.log")).toBeTruthy();
    expect(screen.getByText("logs/b.log")).toBeTruthy();

    // Pulled: the status now carries it, so the snapshot row goes.
    rerender(view({ "logs/a.log": { state: "green" } as SyncEntryStatus }));
    expect(screen.queryByText("logs/a.log")).toBeNull();
    expect(screen.getByText("logs/b.log")).toBeTruthy();
  });

  it("deletes on the host after the confirmation and keeps the files that failed", async () => {
    render(view());
    await userEvent.click(screen.getByRole("button", { name: "Find remote-only files" }));
    await screen.findByText("logs/a.log");
    await userEvent.click(screen.getByRole("button", { name: "Delete all on the host" }));
    await waitFor(() => {
      const pending = useSyncConfirmStore.getState().pending;
      expect(pending && "hostOnly" in pending && pending.hostOnly).toBe(true);
    });
    expect(mockInvoke).not.toHaveBeenCalledWith("sync_apply_delete", expect.anything());
    useSyncConfirmStore.getState().proceed();
    await waitFor(() => expect(screen.queryByText("logs/a.log")).toBeNull());
    expect(mockInvoke).toHaveBeenCalledWith("sync_apply_delete", { projectId: "p", relPath: "logs/a.log", side: "host" });
    expect(screen.getByText("logs/b.log")).toBeTruthy();
  });
});
