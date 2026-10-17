/**
 * Store-side regressions from the 2026-10-15 Medium screen (M3):
 *
 * - every close path forgets the closed tab's prompt state and link routes —
 *   `closeHiddenGroup`, `closeGroup` and a popout's `close` edit skipped it, so
 *   a later tab under the same PTY id inherited the closed one's state;
 * - a failed non-strict layout save surfaces once per session, not never and
 *   not once per write;
 * - a malformed saved tree (or tab record) is rejected by a typed guard
 *   instead of being dereferenced;
 * - `attachGroup` docks from the state it updates.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("../../lib/agents/promptCount", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/agents/promptCount")>();
  return { ...actual, forgetPty: vi.fn() };
});

import { forgetPty } from "../../lib/agents/promptCount";
import {
  activeLayoutPersistTarget,
  allGroups,
  isSavedTabEntry,
  orderedTabKeys,
  restorableSavedTabs,
  savedLayoutTreeOf,
  useTabsStore,
  type DetachedGroup,
  type SavedLayoutTree,
  type SavedTabEntry,
  type TabEntry,
} from "../../stores/tabs";

const invokeMock = vi.mocked(invoke);
const forgetPtyMock = vi.mocked(forgetPty);

function shell(label: string) {
  return { label, cmd: "bash", cwd: "/p", kind: "shell" as const };
}

function reset() {
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
    layoutPersistNotice: null,
  });
}

beforeEach(() => {
  reset();
  forgetPtyMock.mockClear();
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
});

describe("closing a tab for good forgets its PTY state on every path", () => {
  it("closeHiddenGroup drops the payloads and forgets each hidden tab's PTY", () => {
    const a = useTabsStore.getState().addTab(shell("a"));
    const b = useTabsStore.getState().addTab(shell("b"));
    const gid = allGroups(useTabsStore.getState().layout)[0].id;
    useTabsStore.getState().hideGroup(gid);
    const hidden = useTabsStore.getState().hiddenGroupsByScope.p ?? [];
    expect(hidden).toHaveLength(1);

    useTabsStore.getState().closeHiddenGroup(hidden[0].id);

    expect(useTabsStore.getState().tabs).toEqual([]);
    expect(useTabsStore.getState().hiddenGroupsByScope.p).toEqual([]);
    expect(forgetPtyMock).toHaveBeenCalledWith(`p:${a.key}`);
    expect(forgetPtyMock).toHaveBeenCalledWith(`p:${b.key}`);
  });

  it("closeGroup forgets each closed tab's PTY", () => {
    const a = useTabsStore.getState().addTab(shell("a"));
    const gid = allGroups(useTabsStore.getState().layout)[0].id;
    useTabsStore.getState().closeGroup(gid);
    expect(forgetPtyMock).toHaveBeenCalledWith(`p:${a.key}`);
  });

  it("a popout's close edit forgets the closed tab's PTY, and only for a key it holds", () => {
    const a = useTabsStore.getState().addTab(shell("a"));
    const b = useTabsStore.getState().addTab(shell("b"));
    const entry: DetachedGroup = {
      id: "d1",
      label: "popout-d1",
      subtree: { type: "group", id: "dg", tabKeys: [a.key, b.key], activeKey: a.key },
    } as DetachedGroup;
    useTabsStore.setState({ detachedGroupsByScope: { p: [entry] } });

    useTabsStore.getState().applyDetachedEdit("p", "d1", { kind: "close", key: "not-there" });
    expect(forgetPtyMock).not.toHaveBeenCalled();

    useTabsStore.getState().applyDetachedEdit("p", "d1", { kind: "close", key: a.key });
    expect(forgetPtyMock).toHaveBeenCalledWith(`p:${a.key}`);
    expect(useTabsStore.getState().tabs.map((t) => t.key)).toEqual([b.key]);
    const left = useTabsStore.getState().detachedGroupsByScope.p ?? [];
    expect(orderedTabKeys(left[0].subtree)).toEqual([b.key]);
  });

  it("closeDetachedGroup (a popout's WM ×) forgets every closed tab's PTY", () => {
    const a = useTabsStore.getState().addTab(shell("a"));
    const b = useTabsStore.getState().addTab(shell("b"));
    const entry: DetachedGroup = {
      id: "d1",
      label: "popout-d1",
      subtree: { type: "group", id: "dg", tabKeys: [a.key, b.key], activeKey: a.key },
    } as DetachedGroup;
    useTabsStore.setState({ detachedGroupsByScope: { p: [entry] } });

    useTabsStore.getState().closeDetachedGroup("p", "d1");

    expect(useTabsStore.getState().tabs).toEqual([]);
    expect(forgetPtyMock).toHaveBeenCalledWith(`p:${a.key}`);
    expect(forgetPtyMock).toHaveBeenCalledWith(`p:${b.key}`);
  });
});

describe("activeLayoutPersistTarget (CenterPanel's save and AppShell's quit flush)", () => {
  it("names an open box's own scope with no file, not the active project", () => {
    expect(activeLayoutPersistTarget("box:b1", "proj", "/p/project.json")).toEqual({
      scope: "box:b1",
      localFile: "",
    });
  });

  it("names the active project with its own file, root without one, and waits for a file", () => {
    expect(activeLayoutPersistTarget("proj", "proj", "/p/project.json")).toEqual({
      scope: "proj",
      localFile: "/p/project.json",
    });
    expect(activeLayoutPersistTarget("root", null, undefined)).toEqual({ scope: "root", localFile: "" });
    expect(activeLayoutPersistTarget("proj", "proj", undefined)).toBeNull();
  });
});

describe("a failed layout autosave", () => {
  it("raises one notice per session, however many saves fail", async () => {
    useTabsStore.getState().addTab(shell("a"));
    invokeMock.mockImplementation(() => Promise.reject(new Error("disk full")));

    await useTabsStore.getState().persistScope("p", "/p/project.json");
    const notice = useTabsStore.getState().layoutPersistNotice;
    expect(typeof notice).toBe("string");
    expect(notice).not.toBe("");

    useTabsStore.getState().clearLayoutPersistNotice();
    await useTabsStore.getState().persistScope("p", "/p/project.json");
    await useTabsStore.getState().persistScope("p", "/p/project.json");
    expect(useTabsStore.getState().layoutPersistNotice).toBeNull();
  });

  it("still throws for a strict save", async () => {
    useTabsStore.getState().addTab(shell("a"));
    invokeMock.mockImplementation(() => Promise.reject(new Error("disk full")));
    await expect(useTabsStore.getState().persistScopeStrict("p", "/p/project.json")).rejects.toThrow("disk full");
  });
});

describe("restoring a saved layout reads it through typed guards", () => {
  const saved: SavedTabEntry[] = [
    { key: "s1", label: "one", cmd: "bash", cwd: "/p", kind: "shell" },
    { key: "s2", label: "two", cmd: "bash", cwd: "/p", kind: "shell" },
  ];

  function restore(groups: unknown) {
    useTabsStore.getState().loadFromLayout(saved, "/p", "p", groups as SavedLayoutTree);
    const layout = useTabsStore.getState().layoutByScope.p ?? null;
    return { layout, keys: orderedTabKeys(layout) };
  }

  it.each([
    ["a group without tabKeys", { type: "group", activeKey: null }],
    ["a group whose tabKeys is not an array", { type: "group", tabKeys: "s1", activeKey: null }],
    ["a split without children", { type: "split", dir: "row", sizes: [1] }],
    ["a split with an unknown dir", { type: "split", dir: "diagonal", children: [], sizes: [] }],
    ["a node of no known type", { type: "window" }],
    ["a bare string", "group"],
  ])("falls back to one group holding every tab for %s", (_name, groups) => {
    const { layout, keys } = restore(groups);
    expect(layout?.type).toBe("group");
    expect(keys).toHaveLength(2);
  });

  it("drops a malformed child alone and still places every tab", () => {
    const { layout, keys } = restore({
      type: "split",
      dir: "row",
      sizes: ["wide", null],
      children: [
        { type: "group", tabKeys: ["s1"], activeKey: "s1" },
        { type: "group", tabKeys: 7, activeKey: null },
      ],
    });
    expect(layout).not.toBeNull();
    expect(keys).toHaveLength(2);
  });

  it("keeps unusable split sizes out of the restored tree", () => {
    const { layout } = restore({
      type: "split",
      dir: "column",
      sizes: ["a", "b"],
      children: [
        { type: "group", tabKeys: ["s1"], activeKey: "s1" },
        { type: "group", tabKeys: ["s2"], activeKey: "s2" },
      ],
    });
    expect(layout?.type).toBe("split");
    if (layout?.type === "split") expect(layout.sizes).toEqual([0.5, 0.5]);
  });

  it("savedLayoutTreeOf and isSavedTabEntry reject what a folder file could forge", () => {
    expect(savedLayoutTreeOf({ type: "group", tabKeys: [1], activeKey: null })).toBeUndefined();
    expect(savedLayoutTreeOf(null)).toBeUndefined();
    expect(savedLayoutTreeOf({ type: "group", tabKeys: ["k"], activeKey: "k" })).toBeDefined();
    expect(isSavedTabEntry({ key: "k", label: "l", cmd: "bash", cwd: "/p" })).toBe(true);
    expect(isSavedTabEntry({ key: "k", label: "l", cmd: ["bash"], cwd: "/p" })).toBe(false);
    expect(isSavedTabEntry({ key: "k", label: "l", cmd: "bash", cwd: "/p", resumeArgs: [1] })).toBe(false);
    expect(isSavedTabEntry({ key: "k", label: "l", cmd: "bash", cwd: "/p", kind: { x: 1 } })).toBe(false);
  });

  it("restorableSavedTabs drops malformed records and non-arrays", () => {
    expect(restorableSavedTabs("nope")).toEqual([]);
    const kept = restorableSavedTabs([
      { key: "s1", label: "one", cmd: "bash", cwd: "/p", kind: "shell" },
      { key: "s2", label: 2, cmd: "bash", cwd: "/p" },
      null,
    ]);
    expect(kept.map((t) => t.key)).toEqual(["s1"]);
  });
});

describe("attachGroup", () => {
  it("docks from the state it updates and leaves no stale popout behind", () => {
    const a = useTabsStore.getState().addTab(shell("a"));
    const b = useTabsStore.getState().addTab(shell("b"));
    const gid = allGroups(useTabsStore.getState().layout)[0].id;
    // b lives in a popout; the live layout holds only a.
    useTabsStore.setState((s) => ({
      layoutByScope: { ...s.layoutByScope, p: { type: "group", id: gid, tabKeys: [a.key], activeKey: a.key } },
      layout: { type: "group", id: gid, tabKeys: [a.key], activeKey: a.key },
      detachedGroupsByScope: {
        p: [{ id: "d1", label: "popout-d1", subtree: { type: "group", id: "dg", tabKeys: [b.key], activeKey: b.key } } as DetachedGroup],
      },
    }));
    useTabsStore.getState().attachGroup("d1", { edge: "center" });
    expect(useTabsStore.getState().detachedGroupsByScope.p).toEqual([]);
    expect(orderedTabKeys(useTabsStore.getState().layout)).toEqual([a.key, b.key]);
    expect(invokeMock).toHaveBeenCalledWith("attach_subwindow", { registryId: "popout-d1" });

    // A second dock of the same, now gone, popout changes nothing and calls nothing.
    invokeMock.mockClear();
    useTabsStore.getState().attachGroup("d1");
    expect(invokeMock).not.toHaveBeenCalledWith("attach_subwindow", expect.anything());
  });
});

describe("payload writes go through writeScope", () => {
  it("setTabTmuxName on an unknown key leaves the store untouched", () => {
    useTabsStore.getState().addTab(shell("a"));
    const before = useTabsStore.getState().tabsByScope;
    useTabsStore.getState().setTabTmuxName("p", "missing", "x");
    expect(useTabsStore.getState().tabsByScope).toBe(before);
  });

  it("setTabTmuxName and retargetTabs keep the flat mirror and the scope binding", () => {
    const t = useTabsStore.getState().addTab(shell("a"));
    useTabsStore.getState().setTabTmuxName("p", t.key, "sess");
    const state = useTabsStore.getState();
    expect(state.tabs.find((x) => x.key === t.key)?.tmuxSession).toBe("sess");
    expect(state.tabsByScope.p?.every((x: TabEntry) => x.scope === "p")).toBe(true);

    const e = useTabsStore.getState().addTab({ label: "f.pdf", cmd: "", cwd: "/p", kind: "embed", embedPath: "/p/d/f.pdf" } as Omit<TabEntry, "key">);
    useTabsStore.getState().retargetTabs("/p/d", "/p/e");
    const moved = useTabsStore.getState().tabs.find((x) => x.key === e.key);
    expect(moved?.embedPath).toBe("/p/e/f.pdf");
    expect(useTabsStore.getState().tabsByScope.p?.find((x) => x.key === e.key)?.embedPath).toBe("/p/e/f.pdf");
  });
});
