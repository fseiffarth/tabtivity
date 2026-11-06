/**
 * The TensorBoard viewer's wiring: it draws what `tfevents_read` answers,
 * follows only new bytes (the cursor is handed back), and does no standing work
 * while its pane is hidden or its host is down. The parsing and the maths have
 * their own tests (`tensorboard.test.ts`, `services::tfevents`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("../../stores/windows", () => ({
  useWindowsStore: { getState: () => ({ openFile: () => Promise.resolve() }) },
}));

import { useProjectsStore } from "../../stores/projects";
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import { TensorBoardView } from "../../components/embed/TensorBoardView";
import { FileScopeContext, FileSourceContext, PaneVisibleContext } from "../../lib/files/fileAccess";
import type { TfReadResult } from "../../lib/viewers/tensorboard";

const FILE = "/p/logs/run1/events.out.tfevents.1700000000.h.1.0";
const reads = () => mockInvoke.mock.calls.filter((c) => c[0] === "tfevents_read");

function answer(over: Partial<TfReadResult> = {}): TfReadResult {
  return {
    cursor: { offset: 100, size: 100, mtime: 1 },
    reset: false,
    scalars: {
      "train/loss": [[0, 1, 2], [1, 2, 1.5], [2, 3, 1]],
      lr: [[0, 1, 0.1]],
    },
    skipped: { series: { image: ["samples"] }, nonFinite: 0, oversized: 0, malformed: 0, dropped: 0, badCrc: false },
    truncated: false,
    fileVersion: "brain.Event:2",
    ...over,
  };
}

function show(opts: { visible?: boolean; source?: "none" | "remote"; path?: string; scope?: string | null } = {}) {
  return render(
    <FileScopeContext.Provider value={opts.scope ?? null}>
      <FileSourceContext.Provider value={opts.source ?? "none"}>
        <PaneVisibleContext.Provider value={opts.visible ?? true}>
          <TensorBoardView path={opts.path ?? FILE} onOpenExternally={() => {}} />
        </PaneVisibleContext.Provider>
      </FileSourceContext.Provider>
    </FileScopeContext.Provider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useProjectsStore.setState({ projects: [] });
  useRemoteStatusStore.setState({ byProject: {}, byHost: {} });
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "tfevents_read") return Promise.resolve(answer());
    if (cmd === "tfevents_discover") return Promise.resolve([]);
    return Promise.resolve(null);
  });
});

describe("TensorBoardView", () => {
  it("draws one chart per scalar tag, grouped by prefix, and counts what it does not draw", async () => {
    await act(async () => {
      show();
    });
    await screen.findByLabelText("Chart of train/loss, 1 runs");
    expect(screen.getByLabelText("Chart of lr, 1 runs")).toBeTruthy();
    expect(screen.getByText("train")).toBeTruthy();
    expect(screen.getByText("Not shown: 1 image series")).toBeTruthy();
    expect(mockInvoke).toHaveBeenCalledWith("tfevents_read", { path: FILE, projectId: null, cursor: null });
  });

  it("keeps reading while the answer says more remains, handing the cursor back each time", async () => {
    mockInvoke.mockImplementation((cmd: string, args: { cursor: unknown }) => {
      if (cmd !== "tfevents_read") return Promise.resolve([]);
      if (args.cursor == null) return Promise.resolve(answer({ truncated: true, cursor: { offset: 40, size: 100, mtime: 1 } }));
      return Promise.resolve(answer({ scalars: { "train/loss": [[3, 4, 0.5]] } }));
    });
    await act(async () => {
      show();
    });
    await waitFor(() => expect(reads()).toHaveLength(2));
    expect(reads()[1][1]).toMatchObject({ cursor: { offset: 40, size: 100, mtime: 1 } });
  });

  it("catches up when a hidden pane is shown", async () => {
    const view = show({ visible: false });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(reads()).toHaveLength(0);
    view.rerender(
      <FileScopeContext.Provider value={null}>
        <FileSourceContext.Provider value="none">
          <PaneVisibleContext.Provider value={true}>
            <TensorBoardView path={FILE} onOpenExternally={() => {}} />
          </PaneVisibleContext.Provider>
        </FileSourceContext.Provider>
      </FileScopeContext.Provider>,
    );
    await screen.findByLabelText("Chart of train/loss, 1 runs");
  });

  it("does no reading while its pane is hidden", async () => {
    await act(async () => {
      show({ visible: false });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(reads()).toHaveLength(0);
  });

  it("does no reading while a remote project is not connected, and reads once it is", async () => {
    // Only the fields the gate reads; the rest of a project record is irrelevant here.
    useProjectsStore.setState({ projects: [{ id: "r1", remote: { host: "h" } }] as never });
    useRemoteStatusStore.getState().setSsh("r1", "error");
    await act(async () => {
      show({ source: "remote", scope: "r1" });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(reads()).toHaveLength(0);
    await act(async () => {
      useRemoteStatusStore.getState().setSsh("r1", "connected");
    });
    await screen.findByLabelText("Chart of train/loss, 1 runs");
    expect(reads().length).toBeGreaterThan(0);
  });

  it("lists a folder's event files and reads each", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "tfevents_discover") {
        return Promise.resolve([
          { path: "/p/logs/a/events.out.tfevents.1.h", size: 1, mtime: 1 },
          { path: "/p/logs/b/events.out.tfevents.2.h", size: 1, mtime: 1 },
        ]);
      }
      if (cmd === "tfevents_read") return Promise.resolve(answer());
      return Promise.resolve(null);
    });
    await act(async () => {
      show({ path: "/p/logs" });
    });
    await screen.findByLabelText("Chart of train/loss, 2 runs");
    expect(reads().map((c) => (c[1] as { path: string }).path).sort()).toEqual([
      "/p/logs/a/events.out.tfevents.1.h",
      "/p/logs/b/events.out.tfevents.2.h",
    ]);
    expect(screen.getByRole("button", { name: "a" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "b" })).toBeTruthy();
  });

  it("says so when a folder holds no event files", async () => {
    await act(async () => {
      show({ path: "/p/logs" });
    });
    await screen.findByText(/No event files/);
  });

  it("shows a read failure instead of an empty pane", async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "tfevents_read" ? Promise.reject(new Error("no such file or directory")) : Promise.resolve(null),
    );
    await act(async () => {
      show();
    });
    await screen.findByText(/Failed to read the event files/);
  });
});
