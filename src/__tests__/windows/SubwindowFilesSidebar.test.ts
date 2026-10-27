/**
 * Per-subwindow right file viewer (◫): the open flag + column width live on the
 * group NODE (GroupNode.filesOpen/filesWidth), so they must (1) flip via the
 * store actions, (2) survive serialize → prune → restore (a restart), (3) travel
 * with a detach (pop-out), and (4) be reachable from a popout via the streamed
 * "files" detached edit.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  useTabsStore,
  pruneSavedTree,
  findGroup,
  allGroups,
  type GroupNode,
  type LayoutNode,
} from "../../stores/tabs";
import { serializeTree } from "../../stores/tabs/savedLayout";
import { applyEditToSubtree } from "../../stores/detached";
import {
  clampFilesWidth,
  MIN_GROUP_FILES_WIDTH,
  MAX_GROUP_FILES_WIDTH,
} from "../../components/files/SubwindowFilesSidebar";

function tab(label: string) {
  return { label, cmd: "bash", cwd: "/p", kind: "shell" as const };
}

/** Build a single-group scope holding a,b and select it. */
function seed() {
  useTabsStore.setState({
    scope: "p",
    tabsByScope: {},
    layoutByScope: {},
    focusedGroupByScope: {},
    detachedGroupsByScope: {},
    hiddenGroupsByScope: {},
    tabs: [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
  });
  for (const k of ["a", "b"]) useTabsStore.getState().addTab(tab(k));
}

function group(): GroupNode {
  return useTabsStore.getState().layout as GroupNode;
}

describe("tabs store — per-subwindow file viewer (setGroupFiles/setGroupFilesWidth)", () => {
  beforeEach(seed);

  it("toggles filesOpen on the group node and mirrors it into the scope layout", () => {
    expect(group().filesOpen).toBeUndefined();
    useTabsStore.getState().setGroupFiles(group().id, true);
    expect(group().filesOpen).toBe(true);
    const stored = useTabsStore.getState().layoutByScope["p"] as GroupNode;
    expect(stored.filesOpen).toBe(true);
    useTabsStore.getState().setGroupFiles(group().id, false);
    expect(group().filesOpen).toBe(false);
  });

  it("stores the column width", () => {
    useTabsStore.getState().setGroupFilesWidth(group().id, 420);
    expect(group().filesWidth).toBe(420);
  });

  it("stores the browsed folder and no-ops on an unchanged one", () => {
    useTabsStore.getState().setGroupFilesFolder(group().id, "src/lib");
    expect(group().filesFolder).toBe("src/lib");
    // Unchanged → same layout object (no churn / debounce wake), like setTabFolder.
    const before = useTabsStore.getState().layout;
    useTabsStore.getState().setGroupFilesFolder(group().id, "src/lib");
    expect(useTabsStore.getState().layout).toBe(before);
  });

  it("is a no-op for a group that isn't in the live layout", () => {
    const before = useTabsStore.getState().layout;
    useTabsStore.getState().setGroupFiles("nope", true);
    expect(useTabsStore.getState().layout).toBe(before);
  });
});

describe("per-subwindow file viewer — persistence round-trip", () => {
  beforeEach(seed);

  it("serializeTree carries filesOpen/filesWidth/filesFolder, and pruneSavedTree keeps them", () => {
    useTabsStore.getState().setGroupFiles(group().id, true);
    useTabsStore.getState().setGroupFilesWidth(group().id, 350);
    useTabsStore.getState().setGroupFilesFolder(group().id, "src/lib");
    const saved = serializeTree(useTabsStore.getState().layout)!;
    expect(saved).toMatchObject({
      type: "group",
      filesOpen: true,
      filesWidth: 350,
      filesFolder: "src/lib",
    });
    const keep = new Set(group().tabKeys);
    const pruned = pruneSavedTree(saved, keep)!;
    expect(pruned).toMatchObject({ filesOpen: true, filesWidth: 350, filesFolder: "src/lib" });
  });

  it("a closed viewer serializes with no filesOpen/filesFolder key at all", () => {
    const saved = serializeTree(useTabsStore.getState().layout)!;
    expect("filesOpen" in saved).toBe(false);
    expect("filesWidth" in saved).toBe(false);
    expect("filesFolder" in saved).toBe(false);
  });

  it("loadFromLayout restores the flag + width + folder onto the rebuilt group", () => {
    useTabsStore.getState().setGroupFiles(group().id, true);
    useTabsStore.getState().setGroupFilesWidth(group().id, 350);
    useTabsStore.getState().setGroupFilesFolder(group().id, "src/lib");
    const savedTabs = useTabsStore.getState().tabs.map((t) => ({ ...t }));
    const savedTree = serializeTree(useTabsStore.getState().layout);
    useTabsStore.getState().loadFromLayout(savedTabs as never, "/p", "p", savedTree as never);
    const restored = useTabsStore.getState().layout as GroupNode;
    expect(restored.filesOpen).toBe(true);
    expect(restored.filesWidth).toBe(350);
    expect(restored.filesFolder).toBe("src/lib");
  });
});

describe("per-subwindow file viewer — detach + popout edits", () => {
  beforeEach(seed);

  it("detachGroup carries the flag into the detached record", () => {
    // A second group so the detach isn't refused (can't detach the lone group).
    const gid = group().id;
    useTabsStore.getState().setGroupFiles(gid, true);
    const b = useTabsStore.getState().tabs[1];
    useTabsStore.getState().splitWithTab(b.key, gid, "right");
    expect(allGroups(useTabsStore.getState().layout).length).toBe(2);
    const label = useTabsStore.getState().detachGroup(gid, { skipBackend: true });
    expect(label).toBeTruthy();
    const rec = useTabsStore.getState().detachedGroupsByScope["p"][0];
    expect(findGroup(rec.subtree, gid)?.filesOpen).toBe(true);
  });

  it('applyEditToSubtree("files") flips the flag / sets the width on the target group', () => {
    const sub: LayoutNode = {
      type: "group",
      id: "g1",
      tabKeys: ["t1"],
      activeKey: "t1",
    };
    const opened = applyEditToSubtree(sub, { kind: "files", groupId: "g1", open: true })!;
    expect((opened as GroupNode).filesOpen).toBe(true);
    const resized = applyEditToSubtree(opened, { kind: "files", groupId: "g1", width: 400 })!;
    expect((resized as GroupNode).filesWidth).toBe(400);
    // The open flag survives a width-only edit.
    expect((resized as GroupNode).filesOpen).toBe(true);
    const browsed = applyEditToSubtree(resized, {
      kind: "files",
      groupId: "g1",
      folder: "docs",
    })!;
    expect((browsed as GroupNode).filesFolder).toBe("docs");
    // The open flag + width survive a folder-only edit.
    expect((browsed as GroupNode).filesOpen).toBe(true);
    expect((browsed as GroupNode).filesWidth).toBe(400);
    // An edit for an unknown group leaves the subtree unchanged.
    const noop = applyEditToSubtree(resized, { kind: "files", groupId: "gX", open: false })!;
    expect((noop as GroupNode).filesOpen).toBe(true);
  });

  it('applyDetachedEdit("files") updates the main-side detached record', () => {
    useTabsStore.setState({
      detachedGroupsByScope: {
        p: [
          {
            id: "d1",
            label: "detached-p-d1",
            subtree: { type: "group", id: "gd", tabKeys: ["x"], activeKey: "x" },
          },
        ],
      },
    });
    useTabsStore
      .getState()
      .applyDetachedEdit("p", "d1", {
        kind: "files",
        groupId: "gd",
        open: true,
        width: 280,
        folder: "src",
      });
    const rec = useTabsStore.getState().detachedGroupsByScope["p"][0];
    const g = findGroup(rec.subtree, "gd")!;
    expect(g.filesOpen).toBe(true);
    expect(g.filesWidth).toBe(280);
    expect(g.filesFolder).toBe("src");
  });
});

describe("clampFilesWidth", () => {
  it("clamps into the sidebar's min/max range", () => {
    expect(clampFilesWidth(10)).toBe(MIN_GROUP_FILES_WIDTH);
    expect(clampFilesWidth(10_000)).toBe(MAX_GROUP_FILES_WIDTH);
    expect(clampFilesWidth(333.4)).toBe(333);
  });
});
