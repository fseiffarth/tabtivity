/**
 * Tests for the local-loss warning (#28q): the dialog that says a file on the LOCAL side
 * was deleted or overwritten by git lockstep or by sync.
 *
 * The behaviours worth pinning are the ones that decide whether the warning can be
 * trusted at all:
 * - it raises unacknowledged losses for the active project, naming the files;
 * - an unrecoverable loss says so, rather than leaving the recovery line blank (a blank
 *   line reads as "git has a copy", which is exactly the wrong thing to assume);
 * - "Got it" acknowledges through the backend, so a dismissal survives a relaunch;
 * - an acknowledged log never re-raises;
 * - a log belonging to a project the user has since switched away from is never shown
 *   over the project now on screen.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (e: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string, handler: (e: { payload: unknown }) => void) => {
    handlers.set(event, handler);
    return Promise.resolve(() => {});
  }),
}));

import { LocalLossDialog } from "../../components/common/LocalLossDialog";
import { localLossEventConcerns, useLocalLossStore } from "../../stores/localLoss";
import { useProjectsStore } from "../../stores/projects";

const DELETED = {
  ts: 1_752_000_000,
  source: "git",
  kind: "deleted",
  op: "checkout 'main' (following the host)",
  paths: ["src/gone.rs", "docs/notes.md"],
  total: 2,
  recovery: "Still in git — restore a file with:  git -C /mirror checkout abc123 -- <path>",
  acked: false,
};
const OVERWRITTEN = {
  ts: 1_752_000_050,
  source: "sync",
  kind: "overwritten",
  op: "Sync now (re-pulled every selected file)",
  paths: ["notes/draft.txt"],
  total: 1,
  recovery: null, // byte-sync overwrote edits that existed nowhere else
  acked: false,
};

/** Mock the backend log per project — losses belong to one project, never to "any". */
function setLogs(byProject: Record<string, unknown[]>) {
  mockInvoke.mockImplementation((cmd: string, args?: { projectId?: string }) => {
    if (cmd === "local_loss_list") {
      return Promise.resolve(byProject[args?.projectId ?? ""] ?? []);
    }
    return Promise.resolve(null);
  });
}

const setLog = (entries: unknown[]) => setLogs({ proj1: entries });

async function renderFor(projectId: string | null) {
  useProjectsStore.setState({ activeId: projectId ?? undefined } as never);
  useLocalLossStore.setState({ entries: [], projectId: null });
  await act(async () => {
    render(<LocalLossDialog />);
  });
}

describe("#28q local-loss warning", () => {
  beforeEach(() => vi.clearAllMocks());

  it("raises a deletion, naming the files and how to get them back", async () => {
    setLog([DELETED]);
    await renderFor("proj1");

    expect(mockInvoke).toHaveBeenCalledWith("local_loss_list", { projectId: "proj1" });
    expect(screen.getByText(/2 files deleted locally/i)).toBeTruthy();
    expect(screen.getByText("src/gone.rs")).toBeTruthy();
    expect(screen.getByText("docs/notes.md")).toBeTruthy();
    expect(screen.getByText(/git -C \/mirror checkout abc123/)).toBeTruthy();
  });

  it("says outright when the content cannot be recovered", async () => {
    // The sync case: a pull wrote the host's bytes over local edits that were never
    // pushed or committed anywhere. There is no backup ref, no reflog, nothing — and the
    // dialog must say that rather than show an empty recovery line.
    setLog([OVERWRITTEN]);
    await renderFor("proj1");

    expect(screen.getByText(/1 file overwritten locally/i)).toBeTruthy();
    expect(screen.getByText(/cannot be recovered/i)).toBeTruthy();
  });

  it("acknowledges through the backend, so a dismissal survives a relaunch", async () => {
    setLog([DELETED, OVERWRITTEN]);
    await renderFor("proj1");

    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: /got it/i }));
    });

    expect(mockInvoke).toHaveBeenCalledWith("local_loss_ack", { projectId: "proj1" });
    expect(screen.queryByText(/deleted locally/i)).toBeNull();
  });

  it("never re-raises an already-acknowledged loss", async () => {
    setLog([{ ...DELETED, acked: true }]);
    await renderFor("proj1");

    expect(screen.queryByText(/deleted locally/i)).toBeNull();
  });

  it("never shows one project's losses over another project", async () => {
    // proj2 has lost nothing; proj1 has. Switching to proj2 must clear the warning…
    setLogs({ proj1: [DELETED], proj2: [] });
    await renderFor("proj1");
    expect(screen.getByText(/2 files deleted locally/i)).toBeTruthy();

    await act(async () => {
      useProjectsStore.setState({ activeId: "proj2" } as never);
    });
    expect(screen.queryByText("src/gone.rs")).toBeNull();

    // …and a proj1 fetch that lands *after* the switch (the real race — these reads are
    // fired by background lockstep/sync passes) must not paint proj1's deletions over
    // proj2 either. The store records which project a log belongs to precisely so this
    // cannot happen.
    await act(async () => {
      useLocalLossStore.setState({ entries: [DELETED] as never, projectId: "proj1" });
    });
    expect(screen.queryByText("src/gone.rs")).toBeNull();
  });

  it("re-reads the log only for the active project's pass reports, not per synced file", async () => {
    setLog([]);
    await renderFor("proj1");
    const reads = () =>
      mockInvoke.mock.calls.filter(([cmd]) => cmd === "local_loss_list").length;
    const before = reads();
    const fire = async (event: string, payload: unknown) => {
      await act(async () => {
        handlers.get(event)?.({ payload });
      });
    };

    // Another project's lockstep tick and auto-sync pass: not this dialog's news.
    await fire("git-peer-status", { projectId: "proj2", state: {} });
    await fire("auto-sync", { project_id: "proj2", pulled: 1, pushed: 0, skipped_amber: 0 });
    // A byte-sync transfer: one event per file, only the bookends re-read.
    await fire("sync-progress", { project_id: "proj1", phase: "start", rel_path: "", done: 0, total: 3 });
    for (let i = 1; i <= 3; i++) {
      await fire("sync-progress", { project_id: "proj1", phase: "file", rel_path: `f${i}`, done: i, total: 3 });
    }
    await fire("sync-progress", { project_id: "proj1", phase: "done", rel_path: "", done: 3, total: 3 });
    expect(reads() - before).toBe(2);

    // The active project's own lockstep pass still re-reads, and a loss it recorded shows.
    setLog([DELETED]);
    await fire("git-peer-status", { projectId: "proj1", state: {} });
    expect(reads() - before).toBe(3);
    expect(screen.getByText(/2 files deleted locally/i)).toBeTruthy();
  });

  it("re-reads on a payload it does not recognise rather than miss a loss", () => {
    expect(localLossEventConcerns("auto-sync", null, "p")).toBe(true);
    expect(localLossEventConcerns("git-peer-status", { state: {} }, "p")).toBe(true);
    expect(localLossEventConcerns("sync-progress", { project_id: "p", phase: "file" }, "p")).toBe(false);
    expect(localLossEventConcerns("sync-progress", { project_id: "q", phase: "done" }, "p")).toBe(false);
  });
});
