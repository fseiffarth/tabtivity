/**
 * Absolute paths reach the frontend with the host's own separators (`C:\p\a.txt`
 * on Windows); the sites that derive a sibling, a parent or a label from one
 * must read both styles. Covers the helpers the fixed sites compose from
 * `lib/paths` plus the two exported ones, and `retargetTabs` with native paths.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { containingFolderLabel } from "../../components/files/RenameDialog";
import { parentDir } from "../../components/monitoring/DiskUsagePane";
import { basename, dirname, resolvePath } from "../../lib/paths";
import { useTabsStore, type GroupNode, type TabEntry } from "../../stores/tabs";

describe("containing folder label (rename dialog)", () => {
  it("names the parent folder on either OS", () => {
    expect(containingFolderLabel("/home/u/p/notes.md", "root")).toBe("p");
    expect(containingFolderLabel("C:\\Users\\u\\p\\notes.md", "root")).toBe("p");
    expect(containingFolderLabel("C:/Users/u/p/notes.md", "root")).toBe("p");
  });

  it("falls back to the root phrase at a root", () => {
    expect(containingFolderLabel("/notes.md", "root")).toBe("root");
    expect(containingFolderLabel("C:\\notes.md", "root")).toBe("root");
    expect(containingFolderLabel("notes.md", "root")).toBe("root");
  });
});

describe("parent directory (disk usage)", () => {
  it("keeps the drive root and the POSIX root", () => {
    expect(parentDir("/home/u/p/big.bin")).toBe("/home/u/p");
    expect(parentDir("/big.bin")).toBe("/");
    expect(parentDir("C:\\Users\\u\\big.bin")).toBe("C:\\Users\\u");
    expect(parentDir("C:\\big.bin")).toBe("C:\\");
    expect(parentDir("big.bin")).toBe("/");
  });
});

describe("the renamed file's new path (file tree)", () => {
  // `FileTree` derives the retarget path as `resolvePath(dirname(oldAbs), name)`.
  const renamed = (oldAbs: string, name: string) => resolvePath(dirname(oldAbs), name);

  it("swaps the leaf in the path's own separator style", () => {
    expect(renamed("/home/u/p/a.txt", "b.txt")).toBe("/home/u/p/b.txt");
    expect(renamed("/a.txt", "b.txt")).toBe("/b.txt");
    expect(renamed("C:\\p\\a.txt", "b.txt")).toBe("C:\\p\\b.txt");
    expect(renamed("C:\\a.txt", "b.txt")).toBe("C:\\b.txt");
  });

  it("labels a picked folder by its leaf on either OS", () => {
    expect(basename("C:\\Users\\u\\Downloads") || "x").toBe("Downloads");
    expect(basename("/home/u/Downloads/") || "x").toBe("Downloads");
    expect(basename("C:\\") || "C:\\").toBe("C:\\");
  });
});

function embedTab(key: string, embedPath: string, label = basename(embedPath)): TabEntry {
  return { key, scope: "p", label, cmd: "", cwd: "C:\\p", kind: "embed", embedPath, viewer: "markdown" };
}
function group(id: string, tabKeys: string[]): GroupNode {
  return { type: "group", id, tabKeys, activeKey: tabKeys[0] ?? null };
}
function seed(tabs: TabEntry[]) {
  useTabsStore.setState({
    scope: "p",
    tabs,
    activeKey: tabs[0]?.key ?? null,
    layout: group("g", tabs.map((t) => t.key)),
    focusedGroupId: "g",
    tabsByScope: { p: tabs },
    layoutByScope: { p: group("g", tabs.map((t) => t.key)) },
    focusedGroupByScope: { p: "g" },
    detachedGroupsByScope: {},
  });
}
const tab = (key: string) => useTabsStore.getState().tabsByScope.p.find((t) => t.key === key)!;

describe("tabs store — retargetTabs with native Windows paths", () => {
  beforeEach(() => {
    seed([
      embedTab("t1", "C:\\p\\a.txt"),
      embedTab("t2", "C:\\p\\sub\\x.md"),
      embedTab("t3", "C:\\p\\sub\\deep\\y.md"),
      embedTab("t4", "C:\\p\\subway\\z.md"),
    ]);
  });

  it("rewrites a renamed file and its default label", () => {
    useTabsStore.getState().retargetTabs("C:\\p\\a.txt", "C:\\p\\b.txt");
    expect(tab("t1").embedPath).toBe("C:\\p\\b.txt");
    expect(tab("t1").label).toBe("b.txt");
    expect(tab("t2").embedPath).toBe("C:\\p\\sub\\x.md");
  });

  it("prefix-swaps tabs under a renamed directory on segment boundaries", () => {
    useTabsStore.getState().retargetTabs("C:\\p\\sub", "C:\\p\\moved");
    expect(tab("t2").embedPath).toBe("C:\\p\\moved\\x.md");
    expect(tab("t2").label).toBe("x.md");
    expect(tab("t3").embedPath).toBe("C:\\p\\moved\\deep\\y.md");
    // `subway` is not under `sub`.
    expect(tab("t4").embedPath).toBe("C:\\p\\subway\\z.md");
    expect(tab("t1").embedPath).toBe("C:\\p\\a.txt");
  });

  it("matches a Windows path case-insensitively, as the filesystem does", () => {
    useTabsStore.getState().retargetTabs("c:\\P\\sub", "C:\\p\\moved");
    expect(tab("t2").embedPath).toBe("C:\\p\\moved\\x.md");
  });

  it("is a no-op when nothing lies under the old path", () => {
    const before = useTabsStore.getState().tabsByScope.p;
    useTabsStore.getState().retargetTabs("C:\\p\\absent", "C:\\p\\other");
    expect(useTabsStore.getState().tabsByScope.p).toBe(before);
  });
});
