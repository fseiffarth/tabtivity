/**
 * The root console hosts the same viewers a project does, and they must behave
 * as root's tabs even though root is not the active scope while the console
 * floats over a project:
 *
 *  - a file opened from the console (`openFileEntry` with the console's
 *    `TabScopeContext` scope) lands in ROOT, deduped there, not in the project;
 *  - a viewer link / compiled PDF (`openLinkedFile`) follows its linking tab's
 *    scope;
 *  - the key-addressed tab writes a viewer or Files tab makes about itself
 *    (`setViewerState`, `setTabFolder`, `setActive`, `removeTab`, …) reach the
 *    scope that owns the key instead of silently no-oping on the active one.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));

import { allGroups, findTabByKey, useTabsStore, type TabEntry } from "../../stores/tabs";
import { openFileEntry } from "../../components/files/openFileEntry";
import { openLinkedFile } from "../../components/embed/FileViewerPane";
import { openTabInScope } from "../../components/tabs/tabScopeContext";
import type { FileEntry } from "../../lib/viewers/fileUtils";
import { BRAND } from "../../lib/brand";

const pdf: FileEntry = {
  name: "paper.pdf",
  path: `/home/u/${BRAND.slug}/root/paper.pdf`,
  is_dir: false,
  size: 10,
  extension: ".pdf",
  mime: "application/pdf",
};

const tabsOf = (scope: string): TabEntry[] => useTabsStore.getState().tabsByScope[scope] ?? [];
const activeIn = (scope: string) =>
  allGroups(useTabsStore.getState().layoutByScope[scope] ?? null).map((g) => g.activeKey);

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
  // The project on screen has a tab of its own, so "nothing leaked" is a real check.
  useTabsStore.getState().addTab({ label: "Shell", cmd: "", cwd: "/p1", kind: "shell" });
});

describe("opening a viewer from the root console", () => {
  it("lands the viewer tab in root, not in the active project", () => {
    openFileEntry({
      entry: pdf,
      projectDir: `/home/u/${BRAND.slug}/root`,
      projectId: null,
      origin: "test",
      external: false,
      scope: "root",
    });
    expect(tabsOf("p1").map((t) => t.kind)).toEqual(["shell"]);
    const opened = tabsOf("root");
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ kind: "embed", viewer: "pdf", embedPath: pdf.path });
    expect(activeIn("root")).toContain(opened[0].key);
    expect(useTabsStore.getState().scope).toBe("p1");
  });

  it("focuses the file's existing root tab instead of stacking a copy", () => {
    const open = () =>
      openFileEntry({
        entry: pdf,
        projectDir: `/home/u/${BRAND.slug}/root`,
        projectId: null,
        origin: "test",
        external: false,
        scope: "root",
      });
    open();
    openTabInScope("root", { label: "Shell", cmd: "", cwd: "/r", kind: "shell" });
    open();
    expect(tabsOf("root").filter((t) => t.kind === "embed")).toHaveLength(1);
    const viewer = tabsOf("root").find((t) => t.kind === "embed")!;
    expect(activeIn("root")).toContain(viewer.key);
  });

  it("without a scope keeps the old active-scope behaviour", () => {
    openFileEntry({ entry: pdf, projectDir: "/p1", projectId: "p1", origin: "test", external: false });
    expect(tabsOf("p1").some((t) => t.kind === "embed")).toBe(true);
    expect(tabsOf("root")).toHaveLength(0);
  });

  it("a link followed from a root viewer opens beside it, in root", () => {
    const md = openTabInScope("root", {
      label: "notes.md",
      cmd: "",
      cwd: `/home/u/${BRAND.slug}/root`,
      kind: "embed",
      embedPath: `/home/u/${BRAND.slug}/root/notes.md`,
      viewer: "markdown",
    });
    openLinkedFile(md.key, `/home/u/${BRAND.slug}/root`, { path: pdf.path, viewer: "pdf", label: "paper.pdf" });
    expect(tabsOf("p1").some((t) => t.kind === "embed")).toBe(false);
    expect(tabsOf("root").some((t) => t.viewer === "pdf" && t.embedPath === pdf.path)).toBe(true);
  });
});

describe("key-addressed writes reach the tab's own scope", () => {
  it("viewer state, folder, url, viewer and label persist on a root tab", () => {
    const viewer = openTabInScope("root", {
      label: "paper.pdf",
      cmd: "",
      cwd: "/r",
      kind: "embed",
      embedPath: pdf.path,
      viewer: "text",
    });
    const files = openTabInScope("root", { label: "Files", cmd: "", cwd: "/r", kind: "projectfiles" });
    const s = useTabsStore.getState();
    s.setViewerState(viewer.key, { fontSize: 17 });
    s.setTabViewer(viewer.key, "markdown");
    s.setTabFolder(files.key, "sub/dir");
    s.renameTab(files.key, "Renamed");

    const st = useTabsStore.getState();
    expect(findTabByKey(st, viewer.key)?.viewerState).toMatchObject({ fontSize: 17 });
    expect(findTabByKey(st, viewer.key)?.viewer).toBe("markdown");
    expect(findTabByKey(st, files.key)?.folder).toBe("sub/dir");
    expect(findTabByKey(st, files.key)?.label).toBe("Renamed");
    // The active project's list is untouched and still its own.
    expect(st.tabs.map((t) => t.kind)).toEqual(["shell"]);
  });

  it("setActive reveals a root tab without moving the active scope", () => {
    const a = openTabInScope("root", { label: "A", cmd: "", cwd: "/r", kind: "projectfiles" });
    openTabInScope("root", { label: "B", cmd: "", cwd: "/r", kind: "monitor" });
    useTabsStore.getState().setActive(a.key);
    expect(activeIn("root")).toContain(a.key);
    expect(useTabsStore.getState().scope).toBe("p1");
  });

  it("removeTab closes a root tab in root", () => {
    const a = openTabInScope("root", { label: "A", cmd: "", cwd: "/r", kind: "projectfiles" });
    useTabsStore.getState().removeTab(a.key);
    expect(tabsOf("root")).toHaveLength(0);
    expect(tabsOf("p1")).toHaveLength(1);
  });
});
