/**
 * Box tab scopes are persisted first-class (`box:<id>` → sessions/box_<id>/):
 *  - persistScope sends the box scope id with an empty localFile (no project-tree
 *    export copy — the root-scope pattern),
 *  - restoreBoxScope hydrates the scope from load_tab_session on first entry,
 *  - nothing restorable seeds one shell at the box folder (the seed lives in
 *    restoreBoxScope, NOT in openBox, so restore and seed cannot race),
 *  - a pill click on the already-active project leaves an open box scope
 *    (the switchGeneration dep on CenterPanel's restore effect),
 *  - new tabs in a box scope default to the box folder (boxFolderOfScope).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(undefined)) }));
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
vi.mock("../../components/terminal/TerminalView", () => ({
  TerminalView: () => <div className="mock-terminal" />,
}));
vi.mock("../../components/files/FileBrowser", () => ({
  FileBrowser: () => <div className="mock-files" />,
}));

import { invoke } from "@tauri-apps/api/core";
import { CenterPanel } from "../../components/layout/CenterPanel";
import { useTabsStore } from "../../stores/tabs";
import { useProjectsStore } from "../../stores/projects";
import { boxFolderOfScope, restoreBoxScope, useBoxesStore } from "../../stores/boxes";
import type { ProjectBox } from "../../types";

const mockInvoke = invoke as ReturnType<typeof vi.fn>;

function box(id: string, folder: string, members: string[] = []): ProjectBox {
  return { id, name: id, member_ids: members, position: 10, folder };
}

function resetStores() {
  useProjectsStore.setState({
    projects: [
      { id: "p", name: "P", status: "current", position: 10, local_file: "/p/project.json" } as never,
    ],
    activeId: "p",
    switchGeneration: 0,
    loaded: true,
  });
  useBoxesStore.setState({ boxes: [box("b1", "/boxes/b1", ["p"])], loaded: true });
  useTabsStore.setState({
    scope: "p",
    tabsByScope: {},
    layoutByScope: {},
    focusedGroupByScope: {},
    tabs: [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInvoke.mockImplementation(() => Promise.resolve(undefined));
  resetStores();
});
afterEach(() => cleanup());

describe("persistScope — box scope payload", () => {
  it("persists under the box scope id with an empty localFile", async () => {
    useTabsStore.getState().loadFromLayout(
      [{ key: "s1", label: "sh", cmd: "", cwd: "/boxes/b1", kind: "shell" as const }],
      "/boxes/b1",
      "box:b1",
    );
    await useTabsStore.getState().persistScope("box:b1", "");
    const call = mockInvoke.mock.calls.find((c) => c[0] === "workspace_sync");
    expect(call).toBeTruthy();
    const payload = call![1] as Record<string, unknown>;
    expect(payload.projectId).toBe("box:b1");
    expect(payload.localFile).toBe("");
    expect((payload.tabs as unknown[]).length).toBe(1);
  });
});

describe("restoreBoxScope", () => {
  it("hydrates the box scope from load_tab_session", async () => {
    useTabsStore.getState().setScope("box:b1");
    mockInvoke.mockImplementation((cmd: string) =>
      Promise.resolve(
        cmd === "workspace_snapshot"
          ? {
              tabLayout: [
                { key: "s1", label: "sh", cmd: "", cwd: "/boxes/b1/sub", kind: "shell" },
              ],
            }
          : undefined,
      ),
    );
    await restoreBoxScope("box:b1");
    const tabs = useTabsStore.getState().tabsByScope["box:b1"];
    expect(tabs).toHaveLength(1);
    expect(tabs[0].kind).toBe("shell");
    expect(tabs[0].cwd).toBe("/boxes/b1/sub");
  });

  it("keeps a member-root Claude tab in the member root, and resets a stale agent cwd", async () => {
    // The "+" menu's per-member Claude tab starts in the member's root; a
    // relaunch used to move it to the box folder.
    useProjectsStore.setState((s) => ({
      projects: s.projects.map((p) => ({ ...p, directory: "/members/p" })),
    }));
    useTabsStore.getState().setScope("box:b1");
    mockInvoke.mockImplementation((cmd: string) =>
      Promise.resolve(
        cmd === "workspace_snapshot"
          ? {
              tabLayout: [
                { key: "a1", label: "Claude — P", cmd: "claude", cwd: "/members/p", kind: "agent", sessionId: "11111111-1111-1111-1111-111111111111" },
                { key: "a2", label: "Claude", cmd: "claude", cwd: "/old/place", kind: "agent", sessionId: "22222222-2222-2222-2222-222222222222" },
              ],
            }
          : undefined,
      ),
    );
    await restoreBoxScope("box:b1");
    const tabs = useTabsStore.getState().tabsByScope["box:b1"];
    expect(tabs.map((t) => t.cwd)).toEqual(["/members/p", "/boxes/b1"]);
  });

  it("seeds one shell at the box folder when nothing restorable was saved", async () => {
    useTabsStore.getState().setScope("box:b1");
    mockInvoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "workspace_snapshot" ? { tabLayout: [] } : undefined),
    );
    await restoreBoxScope("box:b1");
    const tabs = useTabsStore.getState().tabsByScope["box:b1"];
    expect(tabs).toHaveLength(1);
    expect(tabs[0].kind).toBe("shell");
    expect(tabs[0].cwd).toBe("/boxes/b1");
  });

  it("does not seed when the user navigated away during the load", async () => {
    // The scope in the tabs store is NOT the box scope any more.
    useTabsStore.getState().setScope("p");
    mockInvoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "workspace_snapshot" ? { tabLayout: [] } : undefined),
    );
    await restoreBoxScope("box:b1");
    expect(useTabsStore.getState().tabsByScope["box:b1"]).toBeUndefined();
  });

  it("does not overwrite an already-hydrated box scope", async () => {
    useTabsStore.getState().setScope("box:b1");
    useTabsStore.getState().addTab({ label: "live", cmd: "", cwd: "/boxes/b1", kind: "shell" });
    mockInvoke.mockImplementation((cmd: string) =>
      Promise.resolve(
        cmd === "workspace_snapshot"
          ? { tabLayout: [{ key: "x", label: "stale", cmd: "", cwd: "/stale", kind: "shell" }] }
          : undefined,
      ),
    );
    await restoreBoxScope("box:b1");
    const tabs = useTabsStore.getState().tabsByScope["box:b1"];
    expect(tabs).toHaveLength(1);
    expect(tabs[0].label).toBe("live");
  });
});

describe("boxFolderOfScope — new-tab cwd in a box scope", () => {
  it("resolves the box folder for a box scope and nothing else", () => {
    const boxes = [box("b1", "/boxes/b1")];
    expect(boxFolderOfScope("box:b1", boxes)).toBe("/boxes/b1");
    expect(boxFolderOfScope("p", boxes)).toBe("");
    expect(boxFolderOfScope("root", boxes)).toBe("");
    expect(boxFolderOfScope("box:ghost", boxes)).toBe("");
  });
});

describe("openBox — reopening closed members box-locally", () => {
  it("restores a closed member's tabs without reopening it globally", async () => {
    useProjectsStore.setState({
      projects: [
        { id: "p", name: "P", status: "current", position: 10, local_file: "/p/project.json" },
        {
          id: "q",
          name: "Q",
          status: "inactive",
          position: 20,
          local_file: "/q/project.json",
          directory: "/q",
        },
      ] as never,
      activeId: "p",
    });
    useBoxesStore.setState({ boxes: [box("b1", "/boxes/b1", ["p", "q"])], loaded: true });
    mockInvoke.mockImplementation((cmd: string) =>
      Promise.resolve(
        cmd === "ensure_box_folder"
          ? "/boxes/b1"
          : cmd === "workspace_snapshot"
            ? { tabLayout: [{ key: "t1", label: "sh", cmd: "", cwd: "/q", kind: "shell" }] }
            : undefined,
      ),
    );
    await useBoxesStore.getState().openBox("b1");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // The closed member's tabs are back (reachable from the box slice) …
    expect(useTabsStore.getState().tabsByScope["q"]).toHaveLength(1);
    // … but its persisted status is untouched: it joins the general strip only
    // if it was already there. No save_projects, no status flip, no focus steal.
    const statusById = new Map(
      useProjectsStore.getState().projects.map((p) => [p.id, p.status]),
    );
    expect(statusById.get("q")).toBe("inactive");
    expect(statusById.get("p")).toBe("current");
    expect(useProjectsStore.getState().activeId).toBe("p");
    expect(useTabsStore.getState().scope).toBe("box:b1");
    expect(mockInvoke.mock.calls.some(([cmd]) => cmd === "save_projects")).toBe(false);
  });

  it("leaves a box with no closed members alone", async () => {
    await useBoxesStore.getState().openBox("b1");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // The only member is open already: nothing restored, nothing persisted.
    expect(useTabsStore.getState().tabsByScope["p"]).toBeUndefined();
    expect(mockInvoke.mock.calls.some(([cmd]) => cmd === "save_projects")).toBe(false);
    expect(useTabsStore.getState().scope).toBe("box:b1");
  });
});

describe("CenterPanel — leaving a box scope", () => {
  it("a pill click on the already-active project (switchGeneration bump) leaves the box", async () => {
    render(<CenterPanel />);
    await act(async () => {
      await Promise.resolve();
    });
    // openBox: only a scope switch now.
    act(() => {
      useTabsStore.getState().setScope("box:b1");
    });
    expect(useTabsStore.getState().scope).toBe("box:b1");
    // Clicking the active project's pill bumps switchGeneration without
    // changing activeId; the restore effect must re-run its setScope.
    act(() => {
      useProjectsStore.setState((s) => ({ switchGeneration: s.switchGeneration + 1 }));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(useTabsStore.getState().scope).toBe("p");
  });
});
