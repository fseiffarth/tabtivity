import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn(() => Promise.resolve()) }));
const insertIntoReader = vi.fn((..._args: unknown[]) => true);
vi.mock("../../lib/terminal/terminalDrop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/terminal/terminalDrop")>()),
  insertIntoReader: (...args: unknown[]) => insertIntoReader(...args),
}));

import { CheckpointRestoreDialog } from "../../components/terminal/CheckpointRestoreDialog";
import { ReaderComposerChips } from "../../components/terminal/ReaderComposerChips";
import {
  checkpointDiff,
  checkpointList,
  noteCheckpointKey,
  preForPrompt,
  previousPost,
  sizeLabel,
  snapshotRows,
  type CheckpointRow,
  type CheckpointSince,
} from "../../lib/agents/checkpoints";

function row(partial: Partial<CheckpointRow> & Pick<CheckpointRow, "id" | "kind" | "at">): CheckpointRow {
  return { commit: "c", tree: "t", tabUid: "u1", tabLabel: "", cli: "claude", raced: false, partial: false, skipped: [], nested: [], ...partial };
}

describe("matching a prompt to its checkpoint", () => {
  const rows = [
    row({ id: "a", kind: "pre", at: 1_000, promptAt: Date.parse("2026-11-13T10:00:00Z") }),
    row({ id: "b", kind: "post", at: 2_000 }),
    row({ id: "c", kind: "pre", at: 3_000, promptAt: Date.parse("2026-11-13T10:05:00Z") }),
    row({ id: "d", kind: "pre", at: 4_000, promptAt: Date.parse("2026-11-13T10:05:01Z"), tabUid: "u2" }),
  ];

  it("takes the tab's pre row within five seconds of the bubble's time", () => {
    expect(preForPrompt(rows, "u1", "2026-11-13T10:00:03Z")?.id).toBe("a");
    expect(preForPrompt(rows, "u1", "2026-11-13T10:05:00Z")?.id).toBe("c");
  });

  it("offers nothing for a prompt it cannot place, never a guess", () => {
    expect(preForPrompt(rows, "u1", "2026-11-13T10:02:30Z")).toBeUndefined();
    expect(preForPrompt(rows, "u1", undefined)).toBeUndefined();
    expect(preForPrompt(rows, "u1", "not a date")).toBeUndefined();
    expect(preForPrompt(rows, "other", "2026-11-13T10:00:00Z")).toBeUndefined();
  });

  it("finds the end of the previous turn, and only the same tab's", () => {
    const list = [row({ id: "p", kind: "post", at: 500 }), row({ id: "q", kind: "post", at: 800, tabUid: "u2" }), row({ id: "r", kind: "pre", at: 900 })];
    expect(previousPost(list, list[2])?.id).toBe("p");
    expect(previousPost([list[1], list[2]], list[2])).toBeUndefined();
  });

  it("restores to snapshots only and prints sizes", () => {
    expect(snapshotRows([row({ id: "x", kind: "restore", at: 1, commit: "" }), row({ id: "y", kind: "manual", at: 2 })]).map((r) => r.id)).toEqual(["y"]);
    expect(sizeLabel(512)).toBe("512 B");
    expect(sizeLabel(3 * 1024 * 1024)).toBe("3.0 MiB");
  });
});

describe("the restore dialog", () => {
  const since: CheckpointSince = {
    files: [
      { path: "a.txt", status: "M", added: 1, removed: 1, binary: false, diff: "", cut: false },
      { path: "gone.txt", status: "D", added: null, removed: null, binary: false, diff: null, cut: false },
      { path: "new.txt", status: "A", added: null, removed: null, binary: false, diff: null, cut: false },
    ],
    others: ["gone.txt"],
    leftOut: 0,
    nested: [],
    othersWorking: false,
    othersUnknown: false,
    turnUnknown: false,
    raced: false,
    partial: false,
  };
  const target = row({ id: "ck", kind: "pre", at: Date.parse("2026-11-13T10:00:00Z"), promptAt: 1 });
  let working = false;
  let unknown = false;

  beforeEach(() => {
    invoke.mockReset();
    insertIntoReader.mockClear();
    noteCheckpointKey("u1", "k1");
    working = false;
    unknown = false;
    invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "checkpoint_diff") return Promise.resolve({ ...since, othersWorking: working, turnUnknown: unknown });
      if (command === "checkpoint_restore") return Promise.resolve({ restored: 2, removed: 1, failed: [], undoId: "undo-1" });
      if (command === "checkpoint_list") return Promise.resolve({ enabled: true, bound: true, rows: [] });
      return Promise.reject(new Error(`unexpected ${command} ${JSON.stringify(args)}`));
    });
  });

  it("lists every differing file ticked, flags another tab's, restores the ticked ones and notes it in the composer", async () => {
    const onClose = vi.fn();
    render(<CheckpointRestoreDialog uid="u1" ptyId="p:agent-1" row={target} rows={[target]} onClose={onClose} />);
    await screen.findByText("a.txt");
    expect(screen.getAllByRole("checkbox").slice(0, 3).every((box) => (box as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByText("changed by another tab")).toBeTruthy();

    fireEvent.click(screen.getByLabelText(/new\.txt/));
    fireEvent.click(screen.getByRole("button", { name: "Restore 2 files" }));
    await screen.findByText("Restored 2 files and removed 1.");
    expect(invoke).toHaveBeenCalledWith("checkpoint_restore", { tabKey: "k1", id: "ck", only: ["a.txt", "gone.txt"], confirmOthers: false, confirmUnknown: false });
    expect(insertIntoReader).toHaveBeenCalledTimes(1);
    expect(String(insertIntoReader.mock.calls[0][1])).toContain("Files were restored");

    // Undo restore restores the pre-restore checkpoint, every file.
    fireEvent.click(screen.getByRole("button", { name: "Undo restore" }));
    await screen.findByText(/Undone/);
    expect(invoke).toHaveBeenCalledWith("checkpoint_restore", { tabKey: "k1", id: "undo-1", only: null, confirmOthers: false, confirmUnknown: false });
  });

  it("leaves the note out when its box is unticked, and holds the button while another tab works", async () => {
    working = true;
    render(<CheckpointRestoreDialog uid="u1" ptyId="p:agent-1" row={target} rows={[target]} onClose={() => {}} />);
    await screen.findByText("a.txt");
    const restore = screen.getByRole("button", { name: "Restore 3 files" }) as HTMLButtonElement;
    expect(restore.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Another agent tab in this folder is working. Restore anyway."));
    expect(restore.disabled).toBe(false);
    fireEvent.click(screen.getByLabelText("Put a note about it into the message box"));
    fireEvent.click(restore);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("checkpoint_restore", expect.objectContaining({ confirmOthers: true })));
    await screen.findByText("Restored 2 files and removed 1.");
    expect(insertIntoReader).not.toHaveBeenCalled();
  });

  it("holds the button for an agent that can't be told working until that is ticked", async () => {
    unknown = true;
    render(<CheckpointRestoreDialog uid="u1" ptyId="p:agent-1" row={target} rows={[target]} onClose={() => {}} />);
    await screen.findByText("a.txt");
    const restore = screen.getByRole("button", { name: "Restore 3 files" }) as HTMLButtonElement;
    expect(restore.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/doesn't report its turns/));
    expect(restore.disabled).toBe(false);
    fireEvent.click(restore);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("checkpoint_restore", expect.objectContaining({ confirmUnknown: true, confirmOthers: false })));
  });

  it("asks nothing of the backend for a tab this window holds no key for", async () => {
    noteCheckpointKey("u9", null);
    await expect(checkpointList("u9")).resolves.toMatchObject({ bound: false, enabled: false });
    await expect(checkpointDiff("u9", "ck")).rejects.toThrow(/no checkpoints/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("shows the backend's refusal and restores nothing", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "checkpoint_diff") return Promise.resolve(since);
      if (command === "checkpoint_restore") return Promise.reject("the agent in this tab is working; restore when it has finished");
      return Promise.resolve({ enabled: true, bound: true, rows: [] });
    });
    render(<CheckpointRestoreDialog uid="u1" ptyId={undefined} row={target} rows={[target]} onClose={() => {}} />);
    await screen.findByText("a.txt");
    expect(screen.queryByLabelText("Put a note about it into the message box")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Restore 3 files" }));
    await screen.findByText(/the agent in this tab is working/);
  });

  it("offers the previous turn's end for a checkpoint taken after the agent may have started", async () => {
    const raced = row({ id: "ck2", kind: "pre", at: Date.parse("2026-11-13T10:30:00Z"), raced: true });
    const previous = row({ id: "ck1", kind: "post", at: Date.parse("2026-11-13T10:10:00Z") });
    render(<CheckpointRestoreDialog uid="u1" ptyId="p:agent-1" row={raced} rows={[previous, raced]} onClose={() => {}} />);
    await screen.findByText("a.txt");
    fireEvent.click(screen.getByText(/Use the end of the previous turn instead/));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("checkpoint_diff", { tabKey: "k1", id: "ck1", only: null }));
  });
});

describe("the Checkpoint chip", () => {
  const chips = (props: Partial<Parameters<typeof ReaderComposerChips>[0]>) => (
    <ReaderComposerChips prefixes={[]} active={null} disabled={false} onPrefix={() => {}} onClear={() => {}} onCheckpoint={() => {}} {...props} />
  );

  it("says the folder's checkpoints are failing, and why on hover, until one lands", () => {
    const { rerender } = render(chips({ checkpointError: "d/.gitignore is a named pipe" }));
    const chip = screen.getByRole("button", { name: /Checkpoints failing/ });
    expect(chip.getAttribute("title")).toBe("The last checkpoint of this folder failed: d/.gitignore is a named pipe");
    // A click's own answer still shows first.
    rerender(chips({ checkpointError: "x", checkpointNote: "done" }));
    expect(screen.getByRole("button", { name: /Saved/ })).toBeTruthy();
    rerender(chips({ checkpointError: null }));
    expect(screen.getByRole("button", { name: /^Checkpoint/ }).getAttribute("title")).toContain("Save the project's files now");
  });
});
