/**
 * Ctrl+click on an agent tab's file link (`openFileEntry({ newSubwindow })` →
 * `openTabInNewSubwindow`): the viewer tab lands in a new subwindow split off
 * the focused one, and a file already open is moved there or focused, never
 * duplicated.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));

import { allGroups, useTabsStore, type TabEntry } from "../../stores/tabs";
import { openFileEntry } from "../../lib/files/openFileEntry";
import type { FileEntry } from "../../lib/viewers/fileUtils";

const md: FileEntry = { name: "plan.md", path: "/p1/plan.md", is_dir: false, size: 1, extension: ".md", mime: null };

const groupsOf = (scope: string) => allGroups(useTabsStore.getState().layoutByScope[scope] ?? null);
const tabsOf = (scope: string): TabEntry[] => useTabsStore.getState().tabsByScope[scope] ?? [];
const open = (scope?: string) =>
  openFileEntry({ entry: md, projectDir: "/p1", projectId: "p1", origin: "test", external: false, scope, newSubwindow: true });

beforeEach(() => {
  useTabsStore.setState({
    scope: "p1",
    tabs: [],
    layout: null,
    focusedGroupId: null,
    tabsByScope: { p1: [], root: [] },
    layoutByScope: { p1: null, root: null },
    focusedGroupByScope: { p1: null, root: null },
  });
  useTabsStore.getState().addTab({ label: "Claude", cmd: "claude", cwd: "/p1", kind: "agent" });
  useTabsStore.getState().addTabToScope("root", { label: "Shell", cmd: "", cwd: "/", kind: "shell" });
});

describe("opening a file in a new subwindow", () => {
  it("splits the viewer tab off into a subwindow of its own, focused", () => {
    open();
    const groups = groupsOf("p1");
    expect(groups).toHaveLength(2);
    const viewer = tabsOf("p1").find((t) => t.embedPath === md.path)!;
    expect(groups[1].tabKeys).toEqual([viewer.key]);
    expect(useTabsStore.getState().focusedGroupByScope.p1).toBe(groups[1].id);
  });

  it("focuses the file's own subwindow instead of opening a second copy", () => {
    open();
    open();
    expect(groupsOf("p1")).toHaveLength(2);
    expect(tabsOf("p1").filter((t) => t.embedPath === md.path)).toHaveLength(1);
  });

  it("moves a file open beside other tabs into a new subwindow", () => {
    openFileEntry({ entry: md, projectDir: "/p1", projectId: "p1", origin: "test", external: false });
    expect(groupsOf("p1")).toHaveLength(1);
    open();
    const groups = groupsOf("p1");
    expect(groups).toHaveLength(2);
    expect(tabsOf("p1").filter((t) => t.embedPath === md.path)).toHaveLength(1);
    expect(groups[1].tabKeys).toEqual([tabsOf("p1").find((t) => t.embedPath === md.path)!.key]);
  });

  it("splits in the link's own scope when that is not the shown one", () => {
    open("root");
    expect(groupsOf("root")).toHaveLength(2);
    expect(groupsOf("p1")).toHaveLength(1);
    expect(tabsOf("p1").some((t) => t.embedPath === md.path)).toBe(false);
  });
});
