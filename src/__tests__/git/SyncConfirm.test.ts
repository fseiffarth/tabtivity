/**
 * The byte-sync transfer confirmation. What is locked here is the *gate*, not the
 * wording: a transfer runs only after an explicit yes, a failed or missing preview
 * never becomes an implicit one, and a second ask can never take the question out
 * from under the one being read.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve({})) }));

import { confirmSyncTransfer, useSyncConfirmStore } from "../../stores/remote/syncConfirm";

const invokeMock = vi.mocked(invoke);

const PREVIEW = {
  files: 3,
  bytes: 120,
  overwrites: 2,
  destructive: ["a.txt"],
  destructiveTotal: 1,
  conflicts: 0,
  tracked: 0,
  exact: true,
};

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(PREVIEW as never);
  useSyncConfirmStore.setState({ pending: null });
});

/** Let the preview promise settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("sync transfer confirmation", () => {
  it("holds the caller until an answer and resolves true on proceed", async () => {
    const answer = confirmSyncTransfer({
      projectId: "p1",
      direction: "pull",
      relPath: "data",
      isDir: true,
      label: "data",
    });
    await settle();
    expect(useSyncConfirmStore.getState().pending?.direction).toBe("pull");
    useSyncConfirmStore.getState().proceed();
    expect(await answer).toBe(true);
    expect(useSyncConfirmStore.getState().pending).toBeNull();
  });

  it("resolves false on cancel", async () => {
    const answer = confirmSyncTransfer({
      projectId: "p1",
      direction: "push",
      relPath: "",
      isDir: true,
      label: "proj",
    });
    await settle();
    useSyncConfirmStore.getState().cancel();
    expect(await answer).toBe(false);
  });

  it("prices the transfer with the backend preview, forwarding force + path list", async () => {
    const answer = confirmSyncTransfer({
      projectId: "p1",
      direction: "push",
      relPath: "",
      isDir: true,
      label: "proj",
      relPaths: ["a.txt", "b.txt"],
      force: true,
    });
    await settle();
    const call = invokeMock.mock.calls.find((c) => c[0] === "sync_transfer_preview");
    expect(call![1]).toEqual({
      projectId: "p1",
      relPath: "",
      direction: "push",
      force: true,
      relPaths: ["a.txt", "b.txt"],
    });
    const pending = useSyncConfirmStore.getState().pending;
    expect(pending?.loading).toBe(false);
    expect(pending?.preview).toEqual(PREVIEW);
    useSyncConfirmStore.getState().cancel();
    await answer;
  });

  it("keeps asking when the preview fails — a missing price is not a yes", async () => {
    invokeMock.mockRejectedValueOnce(new Error("not connected") as never);
    const answer = confirmSyncTransfer({
      projectId: "p1",
      direction: "pull",
      relPath: "src",
      isDir: true,
      label: "src",
    });
    await settle();
    const pending = useSyncConfirmStore.getState().pending;
    expect(pending).not.toBeNull();
    expect(pending?.preview).toBeNull();
    expect(pending?.error).toContain("not connected");
    useSyncConfirmStore.getState().cancel();
    expect(await answer).toBe(false);
  });

  it("refuses a second ask while one is open rather than swapping the question", async () => {
    const first = confirmSyncTransfer({
      projectId: "p1",
      direction: "pull",
      relPath: "a",
      isDir: false,
      label: "a",
    });
    const second = confirmSyncTransfer({
      projectId: "p1",
      direction: "push",
      relPath: "b",
      isDir: false,
      label: "b",
    });
    expect(await second).toBe(false);
    expect(useSyncConfirmStore.getState().pending?.relPath).toBe("a");
    useSyncConfirmStore.getState().proceed();
    expect(await first).toBe(true);
  });

  it("drops a preview that lands after the user already answered", async () => {
    let release: (v: unknown) => void = () => {};
    invokeMock.mockReturnValueOnce(new Promise((r) => (release = r)) as never);
    const answer = confirmSyncTransfer({
      projectId: "p1",
      direction: "pull",
      relPath: "a",
      isDir: false,
      label: "a",
    });
    useSyncConfirmStore.getState().cancel();
    expect(await answer).toBe(false);
    release(PREVIEW);
    await settle();
    expect(useSyncConfirmStore.getState().pending).toBeNull();
  });

  it("prices a take-newer ask per direction in one dialog", async () => {
    const answer = confirmSyncTransfer({
      projectId: "p1",
      relPath: "",
      isDir: true,
      label: "proj",
      newer: { host: ["h.txt"], local: ["l1.txt", "l2.txt"] },
      force: true,
    });
    await settle();
    const calls = invokeMock.mock.calls.filter((c) => c[0] === "sync_transfer_preview");
    expect(calls.map((c) => c[1])).toEqual([
      { projectId: "p1", relPath: "", direction: "pull", force: true, relPaths: ["h.txt"] },
      { projectId: "p1", relPath: "", direction: "push", force: true, relPaths: ["l1.txt", "l2.txt"] },
    ]);
    const pending = useSyncConfirmStore.getState().pending;
    expect(pending?.loading).toBe(false);
    expect(pending?.newerPreview).toEqual({ pull: PREVIEW, push: PREVIEW });
    useSyncConfirmStore.getState().proceed();
    expect(await answer).toBe(true);
  });

  it("asks for no direction a take-newer ask has no files for", async () => {
    const answer = confirmSyncTransfer({
      projectId: "p1",
      relPath: "",
      isDir: true,
      label: "proj",
      newer: { host: [], local: ["l.txt"] },
      force: true,
    });
    await settle();
    const calls = invokeMock.mock.calls.filter((c) => c[0] === "sync_transfer_preview");
    expect(calls.map((c) => (c[1] as { direction: string }).direction)).toEqual(["push"]);
    expect(useSyncConfirmStore.getState().pending?.newerPreview).toEqual({ pull: null, push: PREVIEW });
    useSyncConfirmStore.getState().cancel();
    expect(await answer).toBe(false);
  });
});
