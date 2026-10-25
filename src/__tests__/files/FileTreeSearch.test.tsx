/**
 * Render tests for the in-tree project search — since the redundant toolbar
 * "Search" view (`SearchPanel`) was folded into it, the app's ONE project
 * search:
 * - name mode lists ranked filename hits with the match highlighted;
 * - content mode debounces into `project_search` (case toggle, folder/root
 *   scope) and opens hits through the shared `openFileEntry` policy;
 * - the view-switcher toolbar no longer offers a Search view (tripwire);
 * - a remote-source listing shows the "switch to Local" hint instead of the
 *   search box (its backends walk the local path).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react";
import type { ProjectEntry } from "../../types";

const { mockInvoke, mockOpenFileEntry } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockOpenFileEntry: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("../../components/files/openFileEntry", () => ({ openFileEntry: mockOpenFileEntry }));

import { SidePanel } from "../../components/layout/SidePanel";
import { useProjectsStore } from "../../stores/projects";
import { useTabsStore } from "../../stores/tabs";
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import { useFileSourcePrefStore } from "../../stores/remote/fileSourcePref";
import { clearFileViewSnapshots } from "../../lib/projects/fileViewSnapshots";

const PROJECT: ProjectEntry = {
  id: "p1",
  name: "p1",
  status: "active",
  position: 0,
  local_file: "/p/p1/project.json",
} as ProjectEntry;

function fileEntry(name: string, is_dir = false) {
  return {
    name,
    path: `/p/p1/${name}`,
    is_dir,
    size: 1,
    extension: !is_dir && name.includes(".") ? name.slice(name.lastIndexOf(".")) : null,
    mime: null,
  };
}

function setupInvoke() {
  mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "list_dir") {
      return Promise.resolve(
        args?.relPath === "sub" ? [fileEntry("deep.txt")] : [fileEntry("sub", true), fileEntry("main.py")],
      );
    }
    if (cmd === "list_project_paths") {
      return Promise.resolve([
        { path: "docs/readme-notes/other.txt", is_dir: false },
        { path: "readme.md", is_dir: false },
        { path: "src/big-readme-helper.ts", is_dir: false },
      ]);
    }
    if (cmd === "project_search") {
      return Promise.resolve([
        { path: "/p/p1/readme.md", rel: "readme.md", line: 3, col: 5, text: "see hello there" },
        { path: "/p/p1/main.py", rel: "main.py", line: 1, col: 1, text: "hello()" },
      ]);
    }
    if (cmd === "git_status") {
      return Promise.resolve({ staged: 0, unstaged: 0, untracked: 0, has_remote: false, is_repo: false });
    }
    if (cmd === "git_repo_root") return Promise.resolve(null);
    if (cmd === "git_unpushed_commits") return Promise.resolve([]);
    if (cmd === "git_file_statuses") return Promise.resolve({});
    if (cmd === "list_project_endings") return Promise.resolve([]);
    if (cmd === "get_opened_windows") return Promise.resolve([]);
    // The tree's Python __main__ scan writes verdicts via the real settings
    // store, whose baseForWrite() re-reads settings — a null here would throw.
    if (cmd === "get_settings") return Promise.resolve({});
    return Promise.resolve(null);
  });
}

async function renderPanel() {
  await act(async () => {
    render(<SidePanel open={true} />);
  });
}

/** A toolbar button by its glyph, or — for the drawn search icon, which has
 *  no text — by its label. The search fold and the ↻ re-list both live in
 *  the panel's action row (below the view tabs), not in a row of the tree's
 *  own. */
function toolbarBtn(glyph: string): HTMLButtonElement {
  const toolbar = document.querySelector(".side-panel-actions");
  expect(toolbar).toBeTruthy();
  const btn = [...toolbar!.querySelectorAll("button")].find((b) =>
    glyph === "🔍"
      ? /^(Show|Hide) search$/.test(b.getAttribute("aria-label") ?? "")
      : (b.textContent ?? "").includes(glyph),
  );
  expect(btn).toBeTruthy();
  return btn as HTMLButtonElement;
}

/**
 * The search box folds away and starts CLOSED, so every test that types into it
 * has to open it first. Opening is idempotent here: the toolbar's 🔍 is only
 * clicked when the input isn't already mounted.
 */
function searchInput(): HTMLInputElement {
  let input = document.querySelector<HTMLInputElement>(".file-tree-search-input");
  if (!input) {
    fireEvent.click(toolbarBtn("🔍"));
    input = document.querySelector<HTMLInputElement>(".file-tree-search-input");
  }
  expect(input).toBeTruthy();
  return input!;
}

/** Wait for the debounced content search to reach the backend. */
async function waitForSearchCalls(count: number) {
  await waitFor(() => {
    expect(mockInvoke.mock.calls.filter(([cmd]) => cmd === "project_search")).toHaveLength(count);
  });
  return mockInvoke.mock.calls.filter(([cmd]) => cmd === "project_search").map(([, args]) => args);
}

describe("in-tree project search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearFileViewSnapshots();
    setupInvoke();
    // The browsed folder is store state, not component state: without this the
    // "scope" test's walk into `sub/` leaks into whatever runs next, which then
    // searches a subfolder it never opened.
    useProjectsStore.setState({
      projects: [PROJECT],
      activeId: "p1",
      loaded: true,
      sidePanelFolderByProject: {},
    });
    useTabsStore.setState({ scope: "root" });
    useRemoteStatusStore.setState({ byProject: {}, byHost: {} });
    useFileSourcePrefStore.setState({ byProject: {}, byViewer: {} });
  });

  it("name mode lists ranked hits with the match marked; ↗ opens via openFileEntry", async () => {
    await renderPanel();
    fireEvent.change(searchInput(), { target: { value: "readme" } });

    // Rows come from list_project_paths, best (basename prefix) first, with the
    // literal hit wrapped in the highlight mark.
    const rows = await waitFor(() => {
      const r = document.querySelectorAll(".file-search-row");
      expect(r.length).toBe(3);
      return r;
    });
    expect(rows[0].textContent).toContain("readme.md");
    expect(rows[0].querySelector("mark.file-search-hl")?.textContent).toBe("readme");
    expect(document.querySelector(".file-search-count")?.textContent).toBe("3 files");

    // The trailing ↗ opens the file through the shared open policy.
    fireEvent.click(rows[0].querySelector(".file-search-act")!);
    expect(mockOpenFileEntry).toHaveBeenCalledTimes(1);
    expect(mockOpenFileEntry.mock.calls[0][0].entry.path).toBe("/p/p1/readme.md");
  });

  it("content mode debounces one project_search per settled query and opens hits at their line", async () => {
    await renderPanel();
    searchInput(); // the mode pills only exist once the box is unfolded
    fireEvent.click(screen.getByRole("button", { name: "Content" }));

    // Two quick keystrokes settle into exactly ONE backend call.
    fireEvent.change(searchInput(), { target: { value: "hell" } });
    fireEvent.change(searchInput(), { target: { value: "hello" } });
    const [args] = await waitForSearchCalls(1);
    expect(args).toEqual({
      projectDir: "/p/p1",
      query: "hello",
      caseSensitive: false,
      maxResults: 500,
    });

    const rows = await waitFor(() => {
      const r = document.querySelectorAll(".file-search-row.file-search-content");
      expect(r.length).toBe(2);
      return r;
    });
    expect(rows[0].textContent).toContain("readme.md:3");
    expect(rows[0].querySelector("mark.file-search-hl")?.textContent).toBe("hello");

    // Clicking a hit opens the file (the jump itself rides the editor-jump store).
    fireEvent.click(rows[0]);
    expect(mockOpenFileEntry).toHaveBeenCalledTimes(1);
    expect(mockOpenFileEntry.mock.calls[0][0].entry.path).toBe("/p/p1/readme.md");
  });

  it("the Aa toggle re-searches case-sensitively", async () => {
    await renderPanel();
    searchInput(); // the mode pills only exist once the box is unfolded
    fireEvent.click(screen.getByRole("button", { name: "Content" }));
    fireEvent.change(searchInput(), { target: { value: "hello" } });
    await waitForSearchCalls(1);

    fireEvent.click(screen.getByRole("button", { name: "Aa" }));
    const calls = await waitForSearchCalls(2);
    expect(calls[1]).toMatchObject({ query: "hello", caseSensitive: true });
  });

  it("a too-short content query renders the hint and never reaches the backend", async () => {
    await renderPanel();
    searchInput(); // the mode pills only exist once the box is unfolded
    fireEvent.click(screen.getByRole("button", { name: "Content" }));
    fireEvent.change(searchInput(), { target: { value: "h" } });

    expect(await screen.findByText("Type at least 2 characters")).toBeTruthy();
    // Give the debounce window time to (wrongly) fire before asserting silence.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(mockInvoke.mock.calls.filter(([cmd]) => cmd === "project_search")).toHaveLength(0);
  });

  it("scopes the content search to the browsed folder, with root opting back out", async () => {
    await renderPanel();
    // Enter the subfolder, then search: the walk is confined to it.
    fireEvent.click(await screen.findByText("sub"));
    await screen.findByText("deep.txt");
    searchInput(); // the mode pills only exist once the box is unfolded
    fireEvent.click(screen.getByRole("button", { name: "Content" }));
    fireEvent.change(searchInput(), { target: { value: "hello" } });
    const [scoped] = await waitForSearchCalls(1);
    expect(scoped).toMatchObject({ projectDir: "/p/p1/sub" });

    // The root scope button widens it back to the whole project.
    fireEvent.click(screen.getByRole("button", { name: "root" }));
    const calls = await waitForSearchCalls(2);
    expect(calls[1]).toMatchObject({ projectDir: "/p/p1" });
  });

  it("tripwire: the view-switcher toolbar offers no Search view any more", async () => {
    await renderPanel();
    const toolbar = document.querySelector(".side-panel-toolbar");
    expect(toolbar).toBeTruthy();
    const labels = [...toolbar!.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toEqual(expect.arrayContaining(["Files", "Git", "Apps"]));
    expect(labels).not.toContain("Search");
    // …while the tree's own search is there, one click behind the toolbar's 🔍.
    expect(toolbarBtn("🔍")).toBeTruthy();
    expect(searchInput()).toBeTruthy();
  });

  it("the box is hidden by default, opens from the toolbar, and folds back away clearing the query", async () => {
    await renderPanel();
    // Closed on arrival: the tree spends no row at all on search chrome.
    expect(document.querySelector(".file-tree-search")).toBeNull();
    expect(document.querySelector(".file-tree-search-input")).toBeNull();
    expect(document.querySelector(".file-tree-search-modes")).toBeNull();
    const toggle = toolbarBtn("🔍");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // 🔍 and ↻ both moved into the Files/Git/Apps row; the tree draws neither.
    expect(toolbarBtn("↻")).toBeTruthy();
    expect(document.querySelector(".file-tree-refresh")).toBeNull();

    fireEvent.change(searchInput(), { target: { value: "readme" } });
    await waitFor(() => {
      expect(document.querySelector(".file-search-results")).toBeTruthy();
    });
    expect(toolbarBtn("🔍").getAttribute("aria-expanded")).toBe("true");

    // Closing folds the box AND drops the query, so the tree is what comes back.
    fireEvent.click(toolbarBtn("🔍"));
    expect(document.querySelector(".file-tree-search-input")).toBeNull();
    expect(document.querySelector(".file-search-results")).toBeNull();
    expect(searchInput().value).toBe("");
  });

  it("the toolbar's ↻ re-lists the tree", async () => {
    await renderPanel();
    const before = mockInvoke.mock.calls.filter(([cmd]) => cmd === "list_dir").length;
    await act(async () => {
      fireEvent.click(toolbarBtn("↻"));
    });
    await waitFor(() => {
      expect(
        mockInvoke.mock.calls.filter(([cmd]) => cmd === "list_dir").length,
      ).toBeGreaterThan(before);
    });
  });

  it("a remote-source listing shows the switch-to-Local hint instead of the box", async () => {
    const remoteProject = {
      ...PROJECT,
      remote: { host: "h", user: "u", remote_path: "/srv/p1" },
    } as ProjectEntry;
    useProjectsStore.setState({ projects: [remoteProject], activeId: "p1", loaded: true });
    useRemoteStatusStore.setState({ byProject: { p1: { ssh: "connected", vpn: "off" } } });
    useFileSourcePrefStore.setState({ byProject: { p1: "remote" }, byViewer: {} });

    await renderPanel();
    expect(document.querySelector(".file-tree-search-input")).toBeNull();
    const hint = document.querySelector(".file-tree-search-remote-hint");
    expect(hint).toBeTruthy();
    expect(hint!.textContent).toContain("switch the source to Local");
  });
});
