/**
 * Regression test for the render cap on the side-panel file tree.
 *
 * The tree renders its rows unvirtualized, and each row is ~16 elements with
 * ~11 handlers that are rebuilt on every render of the component. A folder with
 * thousands of files therefore built six figures of DOM and re-reconciled the
 * lot every time a folder size landed, a sync status refreshed, or the pointer
 * moved — which is what made a real project (an ML sweep whose `results/` holds
 * one CSV per config × per validation step, 8316 of them, with the gitignored
 * section expanded) freeze the whole window while the CPU sat idle: the cost was
 * layout and paint in a software-rendered webview, not compute.
 *
 * So: render at most ROW_CAP_STEP rows, with a footer that reveals another page.
 * The count in a section header must keep reporting the WHOLE folder — a header
 * that counted only the rendered page would quietly misreport what is on disk.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("../../stores/projects", () => ({ useProjectsStore: vi.fn() }));
vi.mock("../../stores/windows", () => ({
  useWindowsStore: () => ({ windows: [], refresh: vi.fn(), untrack: vi.fn(), closeApp: vi.fn() }),
}));
vi.mock("../../stores/settings", () => {
  // Selector-aware, not a fixed `null`: the side panel reads its stored view off
  // `settings` and writes it back through the `updateSettings` action when the
  // view switcher moves, so a mock that ignored the selector handed the panel a
  // null where an action belongs.
  const state = { settings: null, updateSettings: async () => {} };
  return {
    useSettingsStore: (selector?: (s: typeof state) => unknown) =>
      selector ? selector(state) : state,
  };
});

import { useProjectsStore } from "../../stores/projects";
import { SidePanel } from "../../components/layout/SidePanel";

const mockUseProjectsStore = vi.mocked(useProjectsStore);

// Mirrors ROW_CAP_STEP in useFileTreeRows.ts. Kept as a literal rather than
// imported from there: the test is asserting the user-visible contract ("a page
// at a time"), so it should fail if the page size silently changes.
const CAP = 100;
// Two full pages plus a short one, so the last click can assert that the footer
// reveals only the remainder and then retires.
const TOTAL = 250;

const ACTIVE_PROJECT = {
  id: "proj-1",
  name: "demoproj",
  status: "active",
  position: 0,
  local_file: "/tmp/demoproj/project.json",
};

function fileEntry(name: string) {
  return {
    name,
    path: `/tmp/demoproj/${name}`,
    is_dir: false,
    size: 10,
    extension: "csv",
    mime: null,
  };
}

/** `TOTAL` plain files, the shape of one sweep's results folder. */
const BIG_LISTING = Array.from({ length: TOTAL }, (_, i) =>
  fileEntry(`run_${String(i).padStart(5, "0")}.csv`),
);

function baseInvoke(cmd: string) {
  if (cmd === "list_dir") return Promise.resolve(BIG_LISTING);
  if (cmd === "git_file_statuses") return Promise.resolve({});
  if (cmd === "dir_size_breakdown") return Promise.resolve({ total: 0, ignored: 0 });
  if (cmd === "dir_size") return Promise.resolve(0);
  if (cmd === "git_status")
    return Promise.resolve({ staged: 0, unstaged: 0, untracked: 0, has_remote: false, is_repo: false });
  if (cmd === "git_unpushed_commits") return Promise.resolve([]);
  if (cmd === "load_project") return Promise.resolve({});
  if (cmd === "list_project_endings") return Promise.resolve([]);
  return Promise.resolve(null);
}

describe("file tree render cap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const state = {
      projects: [ACTIVE_PROJECT],
      activeId: "proj-1",
      sidePanelFolderByProject: {},
      setSidePanelFolder: vi.fn(),
    } as unknown as ReturnType<typeof useProjectsStore>;
    mockUseProjectsStore.mockImplementation(((selector?: (s: typeof state) => unknown) =>
      selector ? selector(state) : state) as typeof useProjectsStore);
    mockInvoke.mockImplementation(baseInvoke);
  });

  const rowCount = () => document.querySelectorAll(".file-entry").length;

  it("renders one page of a huge folder instead of all of it", async () => {
    await act(async () => {
      render(<SidePanel open={true} />);
    });
    expect(await screen.findByText("run_00000.csv")).toBeTruthy();

    // The bug: every one of the 1200 rows in the DOM. The fix: exactly one page.
    expect(rowCount()).toBe(CAP);
    // A row past the cap is genuinely absent, not merely hidden — the whole
    // point is that it costs no DOM.
    expect(screen.queryByText(`run_${String(CAP).padStart(5, "0")}.csv`)).toBeNull();
  });

  it("reveals another page per click, and says how many are held back", async () => {
    await act(async () => {
      render(<SidePanel open={true} />);
    });
    await screen.findByText("run_00000.csv");

    const more = () => document.querySelector<HTMLButtonElement>(".file-tree-more");

    // The footer names the remainder rather than leaving it a mystery.
    expect(more()?.textContent).toContain(String(TOTAL - CAP));

    await act(async () => {
      fireEvent.click(more()!);
    });
    expect(rowCount()).toBe(2 * CAP);
    // The revealed page EXTENDS the list — the first row is still the first row,
    // so raising the cap never reshuffles what the user was looking at.
    expect(screen.getByText("run_00000.csv")).toBeTruthy();
    expect(screen.getByText(`run_${String(CAP).padStart(5, "0")}.csv`)).toBeTruthy();

    // Last page: the folder is fully reachable and the footer retires.
    await act(async () => {
      fireEvent.click(more()!);
    });
    expect(rowCount()).toBe(TOTAL);
    expect(more()).toBeNull();
  });

  it("leaves an ordinary folder untouched — no cap footer, every row rendered", async () => {
    const small = Array.from({ length: 12 }, (_, i) => fileEntry(`a_${i}.csv`));
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "list_dir" ? Promise.resolve(small) : baseInvoke(cmd),
    );

    await act(async () => {
      render(<SidePanel open={true} />);
    });
    expect(await screen.findByText("a_0.csv")).toBeTruthy();

    expect(rowCount()).toBe(small.length);
    expect(document.querySelector(".file-tree-more")).toBeNull();
  });
});
