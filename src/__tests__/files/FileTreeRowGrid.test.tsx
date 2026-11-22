/**
 * The file tree's row grid and the wide layout's column header
 * (docs/files_panel_redesign_plan.md, step A).
 *
 * - Every row reserves the same two leading cells — the git chip and the one
 *   action slot — folders and files alike. The bug this replaces: the remark
 *   slot was rendered on file rows only, so file icons sat one slot right of
 *   folder icons and read as nested under the folder above.
 * - Git state is a letter chip with the word in its title; an ignored entry has
 *   no chip and a muted name.
 * - The column header's cells sort: a click sorts by that column, a second
 *   click reverses it, and `aria-sort` says which. (The header is hidden below
 *   720 px by a container query; jsdom runs none, so this tests structure.)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor, fireEvent } from "@testing-library/react";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("../../stores/projects", () => ({ useProjectsStore: vi.fn() }));
vi.mock("../../stores/windows", () => ({
  useWindowsStore: () => ({ windows: [], refresh: vi.fn(), untrack: vi.fn(), closeApp: vi.fn() }),
}));
vi.mock("../../stores/settings", () => {
  const state = { settings: null, updateSettings: async () => {} };
  return {
    useSettingsStore: (selector?: (s: typeof state) => unknown) =>
      selector ? selector(state) : state,
  };
});

import { useProjectsStore } from "../../stores/projects";
import { SidePanel } from "../../components/layout/SidePanel";
import { clearFileViewSnapshots } from "../../lib/projects/fileViewSnapshots";

const mockUseProjectsStore = vi.mocked(useProjectsStore);

const ACTIVE_PROJECT = {
  id: "proj-1",
  name: "demoproj",
  status: "active",
  position: 0,
  local_file: "/tmp/demoproj/project.json",
};

function entry(name: string, opts: { dir?: boolean; size?: number; modified?: number } = {}) {
  const dot = name.lastIndexOf(".");
  return {
    name,
    path: `/tmp/demoproj/${name}`,
    is_dir: !!opts.dir,
    size: opts.size ?? 0,
    extension: opts.dir || dot <= 0 ? null : name.slice(dot),
    mime: null,
    modified_secs: opts.modified ?? 1_700_000_000,
  };
}

function setup(listing: ReturnType<typeof entry>[], statuses: Record<string, string> = {}) {
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "list_dir") return Promise.resolve(listing);
    if (cmd === "git_file_statuses") return Promise.resolve(statuses);
    if (cmd === "dir_size_breakdown") return Promise.resolve({ total: 4096, ignored: 0 });
    if (cmd === "dir_size") return Promise.resolve(4096);
    if (cmd === "git_status")
      return Promise.resolve({ staged: 0, unstaged: 0, untracked: 0, has_remote: false, is_repo: true });
    if (cmd === "git_unpushed_commits") return Promise.resolve([]);
    if (cmd === "get_project_panel_prefs") return Promise.resolve({});
    if (cmd === "list_project_endings") return Promise.resolve([]);
    return Promise.resolve(null);
  });
}

async function renderPanel() {
  const r = await act(async () => render(<SidePanel open={true} />));
  return r.container;
}

const rowOf = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll<HTMLElement>(".file-tree .file-entry")].find(
    (r) => r.querySelector(".file-name")?.textContent === name,
  ) as HTMLElement;

const rowNames = (container: HTMLElement) =>
  [...container.querySelectorAll(".file-tree .file-entry.file-grid .file-name")].map((n) => n.textContent);

describe("file tree row grid", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The tree seeds from a module-level snapshot of the last listing of the
    // same project (lib/projects/fileViewSnapshots); every case lists anew.
    clearFileViewSnapshots();
    const state = {
      projects: [ACTIVE_PROJECT],
      activeId: "proj-1",
      sidePanelFolderByProject: {},
      setSidePanelFolder: vi.fn(),
    } as unknown as ReturnType<typeof useProjectsStore>;
    mockUseProjectsStore.mockImplementation(((selector?: (s: typeof state) => unknown) =>
      selector ? selector(state) : state) as typeof useProjectsStore);
  });

  it("gives folders and files the same leading slots: chip, action, then the name", async () => {
    setup(
      [entry("src", { dir: true }), entry("notes.txt", { size: 10 }), entry("plain.md", { size: 20 })],
      { src: "modified", "notes.txt": "untracked" },
    );
    const container = await renderPanel();
    await screen.findByText("plain.md");
    const rows = [...container.querySelectorAll<HTMLElement>(".file-tree .file-entry.file-grid")];
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const [state, act, main] = Array.from(row.children);
      expect(state.classList.contains("file-state")).toBe(true);
      expect(act.classList.contains("file-act")).toBe(true);
      expect(main.classList.contains("file-main")).toBe(true);
      expect(main.querySelector(".file-name")).not.toBeNull();
    }
  });

  it("draws git state as a letter chip, the word in its title; a clean row has an empty chip cell", async () => {
    setup(
      [entry("src", { dir: true }), entry("notes.txt", { size: 10 }), entry("plain.md", { size: 20 })],
      { src: "modified", "notes.txt": "untracked" },
    );
    const container = await renderPanel();
    await waitFor(() => expect(rowOf(container, "src").querySelector(".sp-chip")).not.toBeNull());
    const chip = rowOf(container, "src").querySelector(".sp-chip") as HTMLElement;
    expect(chip.textContent).toBe("M");
    expect(chip.getAttribute("title")).toMatch(/^Modified/);
    expect(chip.style.color).toBe("var(--warning)");
    expect(rowOf(container, "notes.txt").querySelector(".sp-chip")?.textContent).toBe("U");
    const clean = rowOf(container, "plain.md");
    expect(clean.querySelector(".file-state")).not.toBeNull();
    expect(clean.querySelector(".sp-chip")).toBeNull();
  });

  it("shows sizes as neutral text with a share bar, never a heat colour", async () => {
    setup([entry("big.bin", { size: 300 }), entry("small.bin", { size: 100 })]);
    const container = await renderPanel();
    await screen.findByText("small.bin");
    const big = rowOf(container, "big.bin");
    const size = big.querySelector(".file-size") as HTMLElement;
    expect(size.className).not.toMatch(/size-(small|medium|large|huge)/);
    // 300 of the folder's 400 bytes.
    const fill = big.querySelector(".file-share .sp-bar > span") as HTMLElement;
    expect(fill.style.width).toBe("75%");
  });

  it("an ignored entry has no chip and a muted name", async () => {
    setup([entry("cache.log", { size: 10 }), entry("kept.txt", { size: 10 })], { "cache.log": "ignored" });
    const container = await renderPanel();
    const head = (await screen.findByText("Gitignored")).closest("button") as HTMLElement;
    fireEvent.click(head);
    const row = await waitFor(() => {
      const r = rowOf(container, "cache.log");
      expect(r).toBeTruthy();
      return r;
    });
    expect(row.classList.contains("git-ignored")).toBe(true);
    expect(row.querySelector(".sp-chip")).toBeNull();
    expect(row.querySelector(".file-git")?.textContent).toBe("Ignored");
  });
});

describe("file tree column header (wide layout)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The tree seeds from a module-level snapshot of the last listing of the
    // same project (lib/projects/fileViewSnapshots); every case lists anew.
    clearFileViewSnapshots();
    const state = {
      projects: [ACTIVE_PROJECT],
      activeId: "proj-1",
      sidePanelFolderByProject: {},
      setSidePanelFolder: vi.fn(),
    } as unknown as ReturnType<typeof useProjectsStore>;
    mockUseProjectsStore.mockImplementation(((selector?: (s: typeof state) => unknown) =>
      selector ? selector(state) : state) as typeof useProjectsStore);
  });

  const header = (container: HTMLElement, label: string) =>
    [...container.querySelectorAll<HTMLElement>(".file-cols [role='columnheader']")].find(
      (h) => h.querySelector("button")?.getAttribute("aria-label") === `Sort by ${label}`,
    ) as HTMLElement;

  it("sorts by a clicked column, reverses on a second click, and says so with aria-sort", async () => {
    setup([
      entry("a.txt", { size: 300, modified: 1_700_000_300 }),
      entry("b.txt", { size: 100, modified: 1_700_000_100 }),
      entry("c.txt", { size: 200, modified: 1_700_000_200 }),
    ]);
    const container = await renderPanel();
    await screen.findByText("c.txt");
    expect(rowNames(container)).toEqual(["a.txt", "b.txt", "c.txt"]);
    expect(header(container, "Name").getAttribute("aria-sort")).toBe("ascending");
    expect(header(container, "Size").getAttribute("aria-sort")).toBe("none");

    fireEvent.click(header(container, "Size").querySelector("button")!);
    expect(rowNames(container)).toEqual(["b.txt", "c.txt", "a.txt"]);
    expect(header(container, "Size").getAttribute("aria-sort")).toBe("ascending");
    expect(header(container, "Name").getAttribute("aria-sort")).toBe("none");

    fireEvent.click(header(container, "Size").querySelector("button")!);
    expect(rowNames(container)).toEqual(["a.txt", "c.txt", "b.txt"]);
    expect(header(container, "Size").getAttribute("aria-sort")).toBe("descending");

    // Another column starts ascending again.
    fireEvent.click(header(container, "Modified").querySelector("button")!);
    expect(rowNames(container)).toEqual(["b.txt", "c.txt", "a.txt"]);
    expect(header(container, "Modified").getAttribute("aria-sort")).toBe("ascending");
  });

  it("sorts by git state in the order the git bar acts on it", async () => {
    setup(
      [entry("a.txt", { size: 1 }), entry("b.txt", { size: 1 }), entry("c.txt", { size: 1 }), entry("d.txt", { size: 1 })],
      { "b.txt": "staged", "c.txt": "untracked", "d.txt": "modified" },
    );
    const container = await renderPanel();
    await waitFor(() => expect(rowOf(container, "d.txt")?.querySelector(".sp-chip")).not.toBeNull());
    fireEvent.click(header(container, "Git").querySelector("button")!);
    expect(rowNames(container)).toEqual(["c.txt", "d.txt", "b.txt", "a.txt"]);
    expect(header(container, "Git").getAttribute("aria-sort")).toBe("ascending");
    fireEvent.click(header(container, "Git").querySelector("button")!);
    expect(rowNames(container)).toEqual(["a.txt", "b.txt", "d.txt", "c.txt"]);
    expect(header(container, "Git").getAttribute("aria-sort")).toBe("descending");
  });

  it("shows the state word and the modified time in their own columns", async () => {
    setup([entry("a.txt", { size: 1 })], { "a.txt": "unpushed" });
    const container = await renderPanel();
    await waitFor(() => expect(rowOf(container, "a.txt")?.querySelector(".sp-chip")).not.toBeNull());
    const row = rowOf(container, "a.txt");
    expect(row.querySelector(".file-git")?.textContent).toBe("Not pushed");
    expect(row.querySelector(".file-mod")?.textContent).not.toBe("");
  });
});
