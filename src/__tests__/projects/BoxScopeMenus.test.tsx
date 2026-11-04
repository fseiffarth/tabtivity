/**
 * Phase-5 box-scope polish (#41):
 *  - the box "+" menu offers per-member rows ("Files — ⟨m⟩" / "Shell — ⟨m⟩")
 *    whose tabs land at the MEMBER's root, while plain entries keep the box
 *    folder cwd;
 *  - cross-root copy-paste sends the cross-project invoke shape
 *    (srcProjectDir ≠ destProjectDir) — no copy-path code changes, this pins
 *    the contract the box multi-root view relies on;
 *  - the PDF merge picker's multi-root mode lists per-root and reports which
 *    root a pick came from.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup, fireEvent } from "@testing-library/react";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    scaleFactor: () => Promise.resolve(1),
    innerPosition: () => Promise.resolve({ toLogical: () => ({ x: 0, y: 0 }) }),
    onMoved: () => Promise.resolve(() => {}),
    onResized: () => Promise.resolve(() => {}),
  }),
  cursorPosition: () => Promise.resolve({ x: 0, y: 0 }),
}));

import { TabBar } from "../../components/tabs/TabBar";
import { FileTree } from "../../components/files/FileTree";
import { ContextFilePicker } from "../../components/embed/ContextFilePicker";
import { useTabsStore } from "../../stores/tabs";
import { useProjectsStore } from "../../stores/projects";
import { useBoxesStore } from "../../stores/boxes";
import { useFileClipboardStore } from "../../stores/fileClipboard";
import type { ProjectBox, ProjectEntry } from "../../types";

function proj(id: string, dir: string): ProjectEntry {
  return {
    id,
    name: id,
    status: "active",
    position: 10,
    local_file: `${dir}/project.json`,
  };
}

function box(id: string, members: string[], folder: string): ProjectBox {
  return { id, name: id, member_ids: members, position: 5, folder };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "list_agents") {
      return Promise.resolve([{ id: "claude", bin: "claude", installed: true }]);
    }
    if (cmd === "list_dir") return Promise.resolve([]);
    if (cmd === "list_project_paths") return Promise.resolve([]);
    if (cmd === "git_file_statuses") return Promise.resolve({});
    if (cmd === "git_status") {
      return Promise.resolve({ staged: 0, unstaged: 0, untracked: 0, has_remote: false, is_repo: false });
    }
    if (cmd === "list_project_endings") return Promise.resolve([]);
    return Promise.resolve(null);
  });
  useProjectsStore.setState({
    projects: [proj("p1", "/p/p1"), proj("p2", "/p/p2")],
    activeId: null,
    loaded: true,
  });
  useBoxesStore.setState({ boxes: [box("b1", ["p1", "p2"], "/boxes/b1")], loaded: true });
  useTabsStore.setState({
    scope: "box:b1",
    tabsByScope: {},
    layoutByScope: {},
    focusedGroupByScope: {},
    tabs: [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
  });
  useFileClipboardStore.getState().clear();
});
afterEach(() => cleanup());

describe("box '+' menu — per-member entries via Start in… (5a, AS3b)", () => {
  async function openMenu() {
    useTabsStore.getState().setScope("box:b1");
    useTabsStore
      .getState()
      .addTab({ label: "b1", cmd: "", args: [], env: {}, cwd: "/boxes/b1", kind: "shell" });
    const groupId = useTabsStore.getState().focusedGroupId!;
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<TabBar groupId={groupId} projectCwd="/boxes/b1" showGroupClose={false} />));
    });
    await act(async () => {
      fireEvent.click(container.querySelector(".tab-new-btn")!);
    });
    return container;
  }
  const labelOf = (el: Element) => el.querySelector(".tab-new-menu-dot")?.nextSibling?.textContent ?? "";
  /** Open the ▾ "Start in…" list of the row called `row`, return its entries. */
  async function flyout(row: string) {
    const rowEl = [...document.querySelectorAll(".tab-new-menu-item")].find((el) => labelOf(el) === row)!;
    await act(async () => {
      fireEvent.click(rowEl.parentElement!.querySelector(".tab-new-menu-split-caret")!);
    });
    return [...document.querySelectorAll<HTMLButtonElement>(".tab-new-menu-more .tab-new-menu-item")];
  }

  it("offers Files/Shell fly-out entries per member and lands the shell at the member root", async () => {
    await openMenu();
    expect((await flyout("Files")).map(labelOf)).toEqual(
      expect.arrayContaining(["Files in p1", "Files in p2"]),
    );
    const shells = await flyout("Shell");
    expect(shells.map(labelOf)).toEqual(expect.arrayContaining(["Shell in p1", "Shell in p2"]));
    await act(async () => {
      fireEvent.click(shells.find((el) => labelOf(el) === "Shell in p2")!);
    });
    const tabs = useTabsStore.getState().tabsByScope["box:b1"];
    const created = tabs[tabs.length - 1];
    expect(created.kind).toBe("shell");
    expect(created.cwd).toBe("/p/p2");
  });

  it("lands a member Files entry as a projectfiles tab at the member root", async () => {
    await openMenu();
    const files = await flyout("Files");
    await act(async () => {
      fireEvent.click(files.find((el) => labelOf(el) === "Files in p1")!);
    });
    const tabs = useTabsStore.getState().tabsByScope["box:b1"];
    const created = tabs[tabs.length - 1];
    expect(created.kind).toBe("projectfiles");
    expect(created.cwd).toBe("/p/p1");
  });
});

describe("cross-root paste invoke shape (5c)", () => {
  it("a multi-item paste into another member's tree sends src≠dest project dirs", async () => {
    // Two entries copied from p1's tree, pasted into p2's tree.
    useFileClipboardStore.getState().setEntries([
      { projectDir: "/p/p1", relPath: "a.txt", path: "/p/p1/a.txt", name: "a.txt", isDir: false, op: "copy" },
      { projectDir: "/p/p1", relPath: "b.txt", path: "/p/p1/b.txt", name: "b.txt", isDir: false, op: "copy" },
    ]);

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(
        <FileTree
          projectDir="/p/p2"
          projectId="p2"
          sortKey="name"
          descending={false}
          hiddenEndings={[]}
          hiddenPaths={[]}
          shownPaths={[]}
          initialRelPath=""
          onRelPathChange={() => {}}
          active
        />,
      ));
    });
    await act(async () => {
      fireEvent.contextMenu(container.querySelector(".file-tree, .file-tree-root, [class]")!);
    });
    const paste = [...document.querySelectorAll("button")].find((el) =>
      el.textContent?.toLowerCase().includes("paste"),
    );
    expect(paste, "paste entry should be offered with a loaded clipboard").toBeTruthy();
    await act(async () => {
      fireEvent.click(paste!);
    });
    const calls = mockInvoke.mock.calls.filter((c) => c[0] === "copy_path");
    expect(calls).toHaveLength(2);
    expect(calls[0][1]).toMatchObject({
      srcProjectDir: "/p/p1",
      srcRel: "a.txt",
      destProjectDir: "/p/p2",
      destRel: "a.txt",
    });
  });
});

describe("multi-root merge picker (5b)", () => {
  it("lists the active root and reports the picked root's dir", async () => {
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "list_project_paths") {
        return Promise.resolve(
          args?.projectDir === "/p/p2"
            ? [{ path: "figs/other.pdf", is_dir: false }]
            : [{ path: "notes.pdf", is_dir: false }],
        );
      }
      return Promise.resolve(null);
    });
    const onPick = vi.fn();
    await act(async () => {
      render(
        <ContextFilePicker
          projectDir="/boxes/b1"
          roots={[
            { label: "b1", dir: "/boxes/b1" },
            { label: "p2", dir: "/p/p2" },
          ]}
          attached={[]}
          onPick={onPick}
          onClose={() => {}}
        />,
      );
    });
    // Root selector renders; the first root's listing is up.
    const rootBtns = [...document.querySelectorAll(".qo-root-btn")];
    expect(rootBtns.map((b) => b.textContent)).toEqual(["b1", "p2"]);
    expect(document.body.textContent).toContain("notes.pdf");

    // Switch to the member root: its listing replaces the box folder's.
    await act(async () => {
      fireEvent.click(rootBtns[1]);
    });
    expect(document.body.textContent).toContain("figs/other.pdf");

    const row = [...document.querySelectorAll(".qo-row")].find((el) =>
      el.textContent?.includes("figs/other.pdf"),
    )!;
    await act(async () => {
      fireEvent.mouseDown(row);
    });
    expect(onPick).toHaveBeenCalledWith("figs/other.pdf", "/p/p2");
  });
});
