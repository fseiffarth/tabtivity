/**
 * Threat recheck follow-up (b): the project blob pane opens a file that has an
 * in-app viewer in a tab, through the shared `openFileEntry` policy, like
 * every other file listing; only a file without a viewer goes to the OS (and
 * so asks first). It used to hand every clicked file to the OS.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { ProjectBlobPane } from "../../components/common/ProjectBlobPane";
import { useProjectsStore } from "../../stores/projects";
import { useTabsStore } from "../../stores/tabs";
import { useOpenExternalStore } from "../../stores/openExternal";
import type { ProjectEntry } from "../../types";
import type { FileEntry } from "../../lib/viewers/fileUtils";

const invokeMock = vi.mocked(invoke);

const PROJECT = {
  id: "p1",
  name: "Thesis",
  directory: "/work/thesis",
  local_file: "/work/thesis/project.json",
  position: 0,
  status: "active",
} as unknown as ProjectEntry;

function file(name: string, extension: string): FileEntry {
  return { name, path: `/work/thesis/${name}`, is_dir: false, size: 10, extension, mime: null };
}

// jsdom lays nothing out; the animation loop skips frames without a layout box.
const offsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetParent");

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get: () => document.body,
  });
  vi.useFakeTimers();
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "list_dir") return [file("paper.pdf", ".pdf"), file("data.xyz", ".xyz")];
    if (cmd === "get_project_activity") return {};
    return null;
  });
  useProjectsStore.setState({ projects: [PROJECT], activeId: null });
});

const initialTabs = useTabsStore.getState();

afterEach(() => {
  cleanup();
  useTabsStore.setState(initialTabs, true);
  if (offsetParent) Object.defineProperty(HTMLElement.prototype, "offsetParent", offsetParent);
  vi.useRealTimers();
  invokeMock.mockReset();
  useOpenExternalStore.setState({ pending: null, queue: [], answeredAt: 0 });
});

async function focusProject() {
  render(<ProjectBlobPane />);
  fireEvent.click(screen.getByText("Thesis"));
  // The click is deferred (a double-click may follow), then the project flies
  // to the centre in the animation loop before the folder is listed.
  for (let i = 0; i < 40; i++) {
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
  }
  expect(screen.getByText("paper.pdf")).toBeTruthy();
}

describe("blob pane file clicks", () => {
  it("opens a file with an in-app viewer in a tab, not through the OS", async () => {
    await focusProject();
    const addTab = vi.fn();
    useTabsStore.setState({ tabs: [], addTab } as never);
    fireEvent.click(screen.getByText("paper.pdf"));
    expect(addTab).toHaveBeenCalledTimes(1);
    expect(addTab.mock.calls[0][0]).toMatchObject({
      kind: "embed",
      embedPath: "/work/thesis/paper.pdf",
      viewer: "pdf",
      cwd: "/work/thesis",
    });
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "open_file")).toBe(false);
    expect(useOpenExternalStore.getState().pending).toBeNull();
  });

  it("hands a file without a viewer to the OS, which asks first", async () => {
    await focusProject();
    fireEvent.click(screen.getByText("data.xyz"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(invokeMock).toHaveBeenCalledWith(
      "open_file",
      expect.objectContaining({ path: "/work/thesis/data.xyz", checkOnly: true }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(useOpenExternalStore.getState().pending?.request).toMatchObject({ kind: "confirm", name: "data.xyz" });
  });
});

describe("blob pane Escape", () => {
  it("steps up out of the file viewer on Escape, but not while the pane is hidden", async () => {
    const { rerender } = render(<ProjectBlobPane visible />);
    fireEvent.click(screen.getByText("Thesis"));
    for (let i = 0; i < 40; i++) {
      await act(async () => {
        vi.advanceTimersByTime(100);
      });
    }
    expect(screen.getByText("paper.pdf")).toBeTruthy();

    rerender(<ProjectBlobPane visible={false} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByText("paper.pdf")).toBeTruthy();

    rerender(<ProjectBlobPane visible />);
    const taken = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    taken.preventDefault();
    act(() => {
      window.dispatchEvent(taken);
    });
    expect(screen.getByText("paper.pdf")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("paper.pdf")).toBeNull();
  });
});
