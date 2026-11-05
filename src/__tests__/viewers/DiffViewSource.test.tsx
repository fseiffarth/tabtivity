/**
 * DiffView's data side (`embed/diff/useDiffSource`): what it asks the backend,
 * when, and what it shows while the answer is missing, late, wrong or absent —
 * loading, "No changes", errors with Retry, a file outside git, a remote
 * project that is not connected, a hidden pane, a tab retargeted under a slow
 * answer, and a diff too big to draw in one go.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode } from "react";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("../../stores/windows", () => ({
  useWindowsStore: { getState: () => ({ openFile: () => Promise.resolve() }) },
}));

import { DiffView } from "../../components/embed/DiffView";
import { PaneVisibleContext } from "../../lib/files/fileAccess";
import { storageKey } from "../../lib/brand";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import type { ProjectEntry } from "../../types";

const WHOLE_KEY = storageKey("diffView.wholeFile");

const MODIFIED = [
  "diff --git a/a.txt b/a.txt",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1,2 +1,2 @@",
  " keep",
  "-old",
  "+brand new",
  "",
].join("\n");

/** A lockfile-sized diff: one hunk adding `n` lines. */
function addedLines(n: number): string {
  const body = Array.from({ length: n }, (_, i) => `+line ${i}`).join("\n");
  return `--- /dev/null\n+++ b/big.lock\n@@ -0,0 +1,${n} @@\n${body}\n`;
}

let fileText = "keep\nbrand new\n";
let fileError: string | null = null;
let gitDiff: (args: Record<string, unknown>) => Promise<string>;
const calls = (cmd: string) => mockInvoke.mock.calls.filter((c) => c[0] === cmd);

function install() {
  mockInvoke.mockImplementation((cmd: string, args: Record<string, unknown>) => {
    if (cmd === "read_file_text") {
      return fileError ? Promise.reject(fileError) : Promise.resolve(fileText);
    }
    if (cmd === "file_mtime") return Promise.resolve(1);
    if (cmd === "git_diff_file" || cmd === "sync_diff") return gitDiff(args);
    return Promise.resolve(null);
  });
}

const view = (path = "/p/a.txt", projectId: string | null = null, mode: "git" | "sync" = "git") => (
  <DiffView path={path} projectId={projectId} mode={mode} onOpenExternally={() => {}} />
);

function Visible({ on, children }: { on: boolean; children: ReactNode }) {
  return <PaneVisibleContext.Provider value={on}>{children}</PaneVisibleContext.Provider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  // jsdom has no layout; the Whole file view scrolls its first change into view.
  Element.prototype.scrollIntoView = vi.fn();
  // The Changes view unless a test asks for the whole file.
  localStorage.setItem(WHOLE_KEY, "0");
  fileText = "keep\nbrand new\n";
  fileError = null;
  gitDiff = () => Promise.resolve(MODIFIED);
  useProjectsStore.setState({ projects: [] });
  useRemoteStatusStore.setState({ byProject: {} });
  install();
});

describe("DiffView data loading", () => {
  it("shows the diff, then nothing but 'No changes' for an empty one", async () => {
    const { unmount } = render(view());
    expect(screen.getByText("Loading diff…")).toBeTruthy();
    await screen.findByText(/brand new/);
    unmount();

    gitDiff = () => Promise.resolve("");
    render(view("/p/b.txt"));
    await screen.findByText("No changes.");
  });

  it("asks git from the file's own folder when there is no project", async () => {
    render(view("/elsewhere/dir/a.txt"));
    await screen.findByText(/brand new/);
    expect(calls("git_diff_file")[0][1]).toEqual({ projectDir: "/elsewhere/dir", relPath: "a.txt" });
  });

  it("an error shows with Retry, and Retry asks again", async () => {
    let n = 0;
    gitDiff = () => (++n === 1 ? Promise.reject("index.lock exists") : Promise.resolve(MODIFIED));
    render(view());
    await screen.findByText("index.lock exists");
    fireEvent.click(screen.getByText("Retry"));
    await screen.findByText(/brand new/);
    expect(calls("git_diff_file")).toHaveLength(2);
  });

  it("says so when the file is not in a git repository", async () => {
    gitDiff = () => Promise.reject("not a git repository");
    render(view());
    await screen.findByText(/not in a git repository/);
    expect(screen.queryByText("Retry")).toBeNull();
  });

  it("the Refresh button asks the backend again", async () => {
    render(view());
    await screen.findByText(/brand new/);
    fireEvent.click(screen.getByLabelText("Refresh"));
    await waitFor(() => expect(calls("git_diff_file")).toHaveLength(2));
  });

  it("drops a late answer for the file the tab was retargeted away from", async () => {
    const pending = new Map<string, (text: string) => void>();
    gitDiff = (args) =>
      new Promise<string>((resolve) => {
        pending.set(String(args.relPath), resolve);
      });
    const { rerender } = render(view("/p/first.txt"));
    await waitFor(() => expect(pending.has("first.txt")).toBe(true));
    rerender(view("/p/second.txt"));
    await waitFor(() => expect(pending.has("second.txt")).toBe(true));

    await act(async () => {
      pending.get("second.txt")!(MODIFIED.replace("brand new", "second answer"));
    });
    await screen.findByText(/second answer/);
    await act(async () => {
      pending.get("first.txt")!(MODIFIED.replace("brand new", "first answer"));
    });
    expect(screen.queryByText(/first answer/)).toBeNull();
    expect(screen.getByText(/second answer/)).toBeTruthy();
  });

  it("does not show the previous file's diff under the next one while it loads", async () => {
    const { rerender } = render(view("/p/first.txt"));
    await screen.findByText(/brand new/);
    gitDiff = () => new Promise(() => {});
    rerender(view("/p/second.txt"));
    expect(screen.queryByText(/brand new/)).toBeNull();
    expect(screen.getByText("Loading diff…")).toBeTruthy();
  });

  it("waits for a hidden pane to be shown before asking git", async () => {
    const { rerender } = render(<Visible on={false}>{view()}</Visible>);
    await act(async () => {
      await Promise.resolve();
    });
    expect(calls("git_diff_file")).toHaveLength(0);
    rerender(<Visible on={true}>{view()}</Visible>);
    await screen.findByText(/brand new/);
    expect(calls("git_diff_file")).toHaveLength(1);
  });

  it("the Whole file view falls back to the changes when the file cannot be read", async () => {
    localStorage.setItem(WHOLE_KEY, "1");
    fileError = "No such file";
    gitDiff = () => Promise.resolve(MODIFIED.replace("+brand new", "+").replace("-old", "-gone line"));
    render(view());
    await screen.findByText(/gone line/);
  });

  it("a patch file shows its own content and never asks git; a read error has Retry", async () => {
    fileText = MODIFIED;
    fileError = "no such file";
    render(view("/p/fix.patch"));
    const retry = await screen.findByText("Retry");
    fileError = null;
    fireEvent.click(retry);
    await screen.findByText(/brand new/);
    expect(calls("git_diff_file")).toHaveLength(0);
  });

  it("follows an edit while open in the Changes view too", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(view());
      await screen.findByText(/brand new/);
      expect(calls("git_diff_file")).toHaveLength(1);
      // The file moves on under the open tab: the disk poll re-reads it.
      fileText = "keep\nedited again\n";
      let mtime = 1;
      mockInvoke.mockImplementation((cmd: string, args: Record<string, unknown>) => {
        if (cmd === "read_file_text") return Promise.resolve(fileText);
        if (cmd === "file_mtime") return Promise.resolve(++mtime);
        if (cmd === "git_diff_file") return gitDiff(args);
        return Promise.resolve(null);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4000);
      });
      await waitFor(() => expect(calls("git_diff_file").length).toBeGreaterThan(1));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("DiffView on a remote project", () => {
  const remote = {
    id: "r1",
    name: "r",
    directory: "/proj",
    local_file: "/proj/project.json",
    remote: { host: "h", user: "u", port: 22, remote_path: "/srv/r" },
  } as unknown as ProjectEntry;

  it("asks nothing of a project that is not connected, and asks once it is", async () => {
    useProjectsStore.setState({ projects: [remote] });
    useRemoteStatusStore.setState({ byProject: { r1: { ssh: "off", vpn: "off" } } } as never);
    render(view("/proj/a.txt", "r1"));
    await screen.findByText(/not connected/);
    expect(calls("git_diff_file")).toHaveLength(0);

    act(() => useRemoteStatusStore.getState().setSsh("r1", "connected"));
    await screen.findByText(/brand new/);
    expect(calls("git_diff_file")).toHaveLength(1);
  });

  it("a sync diff is blocked the same way and is keyed by the path under the mirror", async () => {
    useProjectsStore.setState({ projects: [remote] });
    useRemoteStatusStore.setState({ byProject: { r1: { ssh: "off", vpn: "off" } } } as never);
    render(view("/proj/mirror/src/a.txt", "r1", "sync"));
    await screen.findByText(/not connected/);
    expect(calls("sync_diff")).toHaveLength(0);

    act(() => useRemoteStatusStore.getState().setSsh("r1", "connected"));
    await screen.findByText(/brand new/);
    expect(calls("sync_diff")[0][1]).toEqual({ projectId: "r1", relPath: "src/a.txt" });
  });
});

describe("DiffView on a big diff", () => {
  it("draws the first lines only, and grows on request", async () => {
    gitDiff = () => Promise.resolve(addedLines(5000));
    const { container } = render(view());
    await screen.findByText(/Large diff: showing 1500 of 5001 lines/);
    const drawn = () => container.querySelectorAll(".diff-line").length;
    expect(drawn()).toBe(1500);

    fireEvent.click(screen.getByText("Show 3000 more lines"));
    await waitFor(() => expect(drawn()).toBe(4500));
    fireEvent.click(screen.getByText(/Show all 5001 lines/));
    await waitFor(() => expect(drawn()).toBe(5001));
    expect(screen.queryByText(/Large diff/)).toBeNull();
  });

  it("cuts a megabyte line and shows it whole on request", async () => {
    gitDiff = () => Promise.resolve(`--- a/m.js\n+++ b/m.js\n@@ -1 +1 @@\n+${"x".repeat(100_000)}\n`);
    const { container } = render(view());
    await screen.findByText(/very long lines are shortened/);
    const text = () => container.querySelector('.diff-line[data-type="add"] .diff-text')!.textContent!;
    expect(text().length).toBeLessThan(2100);
    fireEvent.click(screen.getByText("Show full lines"));
    await waitFor(() => expect(text().length).toBe(100_001));
  });

  it("the Whole file view opens as a window around the first change", async () => {
    localStorage.setItem(WHOLE_KEY, "1");
    const total = 20_000;
    fileText = Array.from({ length: total }, (_, i) => (i === 10_000 ? "CHANGED" : `row ${i}`)).join("\n") + "\n";
    gitDiff = () =>
      Promise.resolve("--- a/w.txt\n+++ b/w.txt\n@@ -10000,3 +10000,3 @@\n row 9999\n-was\n+CHANGED\n row 10001\n");
    const { container } = render(view("/p/w.txt"));
    await screen.findByText(/lines above/);
    expect(container.querySelectorAll(".diff-line").length).toBeLessThanOrEqual(1500 + 5);
    expect(screen.getByText("Show 3000 earlier lines")).toBeTruthy();
    expect(screen.getByText(/lines below/)).toBeTruthy();
  });
});
