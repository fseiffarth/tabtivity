/**
 * Delete/rename tab-sync: when a file is deleted or renamed/moved from the file
 * tree/browser, its open viewer tabs must close (delete) or follow to the new
 * path (rename). Covers the `retargetTabs` store action and the current-scope
 * `closeTabsForDeletedPath`/`retargetTabsForRenamedPath` orchestration (no
 * detached popouts here — those are exercised via the detached protocol tests).
 * See src/components/files/fileTabSync.ts + tabs.ts retargetTabs.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(), listen: vi.fn() }));

import { useTabsStore, type GroupNode, type TabEntry } from "../../stores/tabs";
import {
  closeTabsForDeletedPath,
  retargetTabsForRenamedPath,
} from "../../components/files/fileTabSync";

function embedTab(key: string, embedPath: string, label = embedPath.slice(embedPath.lastIndexOf("/") + 1)): TabEntry {
  return { key, scope: "p", label, cmd: "", cwd: "/p", kind: "embed", embedPath, viewer: "markdown" };
}
function shellTab(key: string): TabEntry {
  return { key, scope: "p", label: key, cmd: "", cwd: "/p", kind: "shell" };
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

describe("tabs store — retargetTabs", () => {
  beforeEach(() => {
    seed([
      embedTab("t1", "/p/notes.md"),
      embedTab("t2", "/p/sub/a.md"),
      shellTab("t3"),
    ]);
  });

  it("rewrites an exact-match embedPath and refreshes the default label", () => {
    useTabsStore.getState().retargetTabs("/p/notes.md", "/p/renamed.md");
    const t1 = useTabsStore.getState().tabsByScope.p.find((t) => t.key === "t1")!;
    expect(t1.embedPath).toBe("/p/renamed.md");
    expect(t1.label).toBe("renamed.md");
    // Flat mirror stays in sync so the active-scope CenterPanel re-renders.
    expect(useTabsStore.getState().tabs.find((t) => t.key === "t1")!.embedPath).toBe("/p/renamed.md");
  });

  it("keeps a user-renamed label instead of clobbering it", () => {
    seed([embedTab("t1", "/p/notes.md", "My Notes")]);
    useTabsStore.getState().retargetTabs("/p/notes.md", "/p/renamed.md");
    const t1 = useTabsStore.getState().tabsByScope.p[0];
    expect(t1.embedPath).toBe("/p/renamed.md");
    expect(t1.label).toBe("My Notes");
  });

  it("prefix-swaps tabs under a renamed/moved directory (label untouched)", () => {
    useTabsStore.getState().retargetTabs("/p/sub", "/p/moved");
    const t2 = useTabsStore.getState().tabsByScope.p.find((t) => t.key === "t2")!;
    expect(t2.embedPath).toBe("/p/moved/a.md");
    expect(t2.label).toBe("a.md");
    // A sibling not under the directory is untouched.
    expect(useTabsStore.getState().tabsByScope.p.find((t) => t.key === "t1")!.embedPath).toBe("/p/notes.md");
  });

  it("ignores non-embed tabs and is a no-op when nothing matches", () => {
    const before = useTabsStore.getState().tabsByScope.p;
    useTabsStore.getState().retargetTabs("/p/absent.md", "/p/x.md");
    expect(useTabsStore.getState().tabsByScope.p).toBe(before);
  });

  it("swaps the directory prefix on a segment boundary and keeps the tail's bytes", () => {
    // `/p/sub2` is not under `/p/sub`; a POSIX file name may hold a `\`, which
    // must survive the swap (the normalising path helpers would read it as a
    // separator).
    seed([embedTab("t1", "/p/sub/a.md"), embedTab("t2", "/p/sub2/b.md"), embedTab("t3", "/p/sub/we\\ird.md")]);
    useTabsStore.getState().retargetTabs("/p/sub", "/p/sub2");
    const byKey = (k: string) => useTabsStore.getState().tabsByScope.p.find((t) => t.key === k)!;
    expect(byKey("t1").embedPath).toBe("/p/sub2/a.md");
    expect(byKey("t2").embedPath).toBe("/p/sub2/b.md");
    expect(byKey("t3").embedPath).toBe("/p/sub2/we\\ird.md");
  });
});

describe("fileTabSync — current scope, no popouts", () => {
  beforeEach(() => {
    seed([
      embedTab("t1", "/p/notes.md"),
      embedTab("t2", "/p/sub/a.md"),
      embedTab("t3", "/p/sub/b.md"),
    ]);
  });

  it("closeTabsForDeletedPath removes the exact viewer tab", () => {
    closeTabsForDeletedPath("/p/notes.md");
    const keys = useTabsStore.getState().tabsByScope.p.map((t) => t.key);
    expect(keys).toEqual(["t2", "t3"]);
  });

  it("closeTabsForDeletedPath removes every tab under a deleted folder", () => {
    closeTabsForDeletedPath("/p/sub");
    const keys = useTabsStore.getState().tabsByScope.p.map((t) => t.key);
    expect(keys).toEqual(["t1"]);
  });

  it("retargetTabsForRenamedPath follows the file to its new path", () => {
    retargetTabsForRenamedPath("/p/notes.md", "/p/renamed.md");
    const t1 = useTabsStore.getState().tabsByScope.p.find((t) => t.key === "t1")!;
    expect(t1.embedPath).toBe("/p/renamed.md");
  });
});
