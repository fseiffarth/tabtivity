/**
 * One file, one viewer tab: every open-a-file path finds the tab already
 * showing a file, however the opener spelled its path, and a file dropped
 * while open moves that tab rather than adding a copy.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));

import { useTabsStore, type GroupNode, type TabEntry } from "../../stores/tabs";
import { openFileEntry } from "../../lib/files/openFileEntry";
import { openLinkedFile } from "../../components/embed/fileViewer/openLinked";
import { commitFileDrop } from "../../components/tabs/commitFileDrop";
import { isFileTab } from "../../lib/tabs/fileTab";
import { samePath } from "../../lib/paths";
import type { FileEntry } from "../../lib/viewers/fileUtils";
import type { TabDrag } from "../../stores/drag/drag";

const pdf = (path: string): FileEntry => ({ name: "form.pdf", path, is_dir: false, size: 1, extension: ".pdf", mime: null });
const pdfTabs = (): TabEntry[] => useTabsStore.getState().tabs.filter((t) => t.kind === "embed" && t.viewer === "pdf");
const open = (path: string) =>
  openFileEntry({ entry: pdf(path), projectDir: "/p", projectId: "p", origin: "test", external: false });

beforeEach(() => {
  useTabsStore.setState({
    scope: "p",
    tabs: [],
    layout: null,
    focusedGroupId: null,
    tabsByScope: { p: [] },
    layoutByScope: { p: null },
    focusedGroupByScope: { p: null },
  });
  useTabsStore.getState().addTab({ label: "sh", cmd: "bash", cwd: "/p", kind: "shell" });
});

describe("samePath", () => {
  it("reads one path through its spellings", () => {
    expect(samePath("/p/a/form.pdf", "/p//a/./form.pdf")).toBe(true);
    expect(samePath("/p/a/form.pdf", "/p/b/../a/form.pdf")).toBe(true);
    expect(samePath("/p/a/", "/p/a")).toBe(true);
    expect(samePath("C:\\P\\form.pdf", "c:/p/form.pdf")).toBe(true);
  });

  it("keeps different files apart", () => {
    expect(samePath("/p/a/form.pdf", "/p/A/form.pdf")).toBe(false);
    expect(samePath("/p/form.pdf", "/q/form.pdf")).toBe(false);
    expect(samePath("", "/p")).toBe(false);
  });
});

describe("isFileTab", () => {
  const tab = (viewer: TabEntry["viewer"]): TabEntry =>
    ({ key: "k", label: "x", cmd: "", cwd: "/p", kind: "embed", embedPath: "/p/main.tex", viewer }) as TabEntry;

  it("matches on viewer and path, a healed TeX workspace standing for its editor", () => {
    expect(isFileTab(tab("pdf"), "/p/main.tex", "pdf")).toBe(true);
    expect(isFileTab(tab("pdf"), "/p/main.tex", "text")).toBe(false);
    expect(isFileTab(tab("texworkspace"), "/p/./main.tex", "tex")).toBe(true);
  });
});

describe("opening a file that is already open", () => {
  it("focuses the tab a differently spelled path opened", () => {
    open("/p/docs/form.pdf");
    useTabsStore.getState().setActive(useTabsStore.getState().tabs[0].key);
    open("/p//docs/./form.pdf");
    expect(pdfTabs()).toHaveLength(1);
    expect(useTabsStore.getState().activeKey).toBe(pdfTabs()[0].key);
  });

  it("a followed link finds the tree's tab", () => {
    open("/p/docs/form.pdf");
    openLinkedFile(undefined, "/p", { path: "/p/notes/../docs/form.pdf", viewer: "pdf", label: "form.pdf" });
    expect(pdfTabs()).toHaveLength(1);
  });

  it("a drop moves the open tab to the drop slot instead of adding one", () => {
    open("/p/docs/form.pdf");
    const groupId = (useTabsStore.getState().layout as GroupNode).id;
    const drag: TabDrag = {
      kind: "file",
      key: "",
      fromGroup: "",
      label: "form.pdf",
      pointerX: 0,
      pointerY: 0,
      overGroup: null,
      edge: null,
      reorderGroup: groupId,
      reorderIndex: 0,
      filePath: "/p/docs/form.pdf",
      fileName: "form.pdf",
      viewer: "pdf",
    };
    commitFileDrop(drag, "p", "/p");
    expect(pdfTabs()).toHaveLength(1);
    const group = useTabsStore.getState().layout as GroupNode;
    expect(group.tabKeys[0]).toBe(pdfTabs()[0].key);
  });
});
