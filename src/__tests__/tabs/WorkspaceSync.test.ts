/**
 * The desktop's side of the workspace service (headless owner plan, H1/H3):
 * a sync answer hands this window the ids of the tabs it created, the new
 * version, and what another client changed meanwhile — a label or colour the
 * service kept over this window's older copy, and a close it never saw.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { invoke } from "@tauri-apps/api/core";
import { LEGACY_NAMES, NAMES } from "../../lib/brand";
import { MONITOR_TAB_CMD, _resetSyncBaseForTest, adoptSyncOutcome, applyWorkspacePatch, hydrateScopeFromDisk, refreshWorkspaceScope, useTabsStore, type TabEntry } from "../../stores/tabs";

// What a window last sent is remembered per scope and tab key, and these
// cases reuse both.
beforeEach(() => _resetSyncBaseForTest());

function tab(key: string, label: string, id?: string): TabEntry {
  return { key, id, label, cmd: "", cwd: "/tmp", kind: "shell", scope: "p" };
}

describe("adoptSyncOutcome", () => {
  beforeEach(() => {
    useTabsStore.setState({
      scope: "p",
      tabsByScope: { p: [tab("k1", "A", "id-a"), tab("k2", "B", "id-b"), tab("k3", "C")] },
      tabs: [tab("k1", "A", "id-a"), tab("k2", "B", "id-b"), tab("k3", "C")],
      layoutByScope: { p: { type: "group", id: "g", tabKeys: ["k1", "k2", "k3"], activeKey: "k1" } },
      focusedGroupByScope: { p: "g" },
      detachedGroupsByScope: {},
      hiddenGroupsByScope: {},
      workspaceVersionByScope: { p: 3 },
    });
  });

  it("records the version, adopts minted ids, takes a newer label and colour, and drops a tab closed elsewhere", () => {
    adoptSyncOutcome(
      "p",
      {
        version: 7,
        stale: true,
        ops: [],
        tabs: [
          { key: "k1", id: "id-a", label: "From the phone", cmd: "", cwd: "/tmp", kind: "shell", color: "teal" },
          { key: "k3", id: "id-c", label: "C", cmd: "", cwd: "/tmp", kind: "shell" },
        ],
      },
      new Set(["k1", "k2", "k3"]),
    );
    const state = useTabsStore.getState();
    expect(state.workspaceVersionByScope.p).toBe(7);
    const byKey = Object.fromEntries(state.tabsByScope.p.map((t) => [t.key, t]));
    expect(byKey.k1.label).toBe("From the phone");
    expect(byKey.k1.color).toBe("teal");
    expect(byKey.k3.id).toBe("id-c");
    expect(byKey.k2).toBeUndefined();
    // The flat mirror and the layout tree followed the close.
    expect(state.tabs.map((t) => t.key)).toEqual(["k1", "k3"]);
    const layout = state.layoutByScope.p;
    expect(layout && layout.type === "group" ? layout.tabKeys : []).toEqual(["k1", "k3"]);
  });

  it("adds a tab another client created after this window's base, without stealing the active tab (H3)", () => {
    adoptSyncOutcome(
      "p",
      {
        version: 9,
        stale: true,
        ops: [{ op: "created", id: "id-new" }],
        tabs: [
          { key: "k1", id: "id-a", label: "A", cmd: "", cwd: "/tmp", kind: "shell" },
          { key: "k2", id: "id-b", label: "B", cmd: "", cwd: "/tmp", kind: "shell" },
          { key: "k3", id: "id-c", label: "C", cmd: "", cwd: "/tmp", kind: "shell" },
          // Created at version 5, after this window's base of 3: a phone's ＋
          // through the owner. It keeps the owner's tmux name and session id.
          { key: "headless-1", id: "id-new", label: "Claude", cmd: "claude", cwd: "/work", kind: "agent", sessionId: "uid-1", tmuxSession: `${NAMES.tmuxPrefix}p--agent-x`, createdVersion: 5 },
          // Created at version 2, before the base: something this window
          // closed and has not persisted yet — never resurrected.
          { key: "old", id: "id-old", label: "Old", cmd: "", cwd: "/tmp", kind: "shell", createdVersion: 2 },
        ],
      },
      new Set(["k1", "k2", "k3"]),
    );
    const state = useTabsStore.getState();
    expect(state.tabsByScope.p.map((t) => t.label)).toEqual(["A", "B", "C", "Claude"]);
    const added = state.tabsByScope.p[3];
    expect(added.id).toBe("id-new");
    expect(added.key).not.toBe("headless-1");
    expect(added.tmuxSession).toBe(`${NAMES.tmuxPrefix}p--agent-x`);
    expect(added.sessionId).toBe("uid-1");
    expect(added.args).toEqual(["--resume", "uid-1"]);
    expect(added.scope).toBe("p");
    const layout = state.layoutByScope.p;
    expect(layout && layout.type === "group" ? layout.tabKeys : []).toEqual(["k1", "k2", "k3", added.key]);
    expect(layout && layout.type === "group" ? layout.activeKey : null).toBe("k1");
    expect(state.tabs.map((t) => t.key)).toContain(added.key);
    expect(state.workspaceVersionByScope.p).toBe(9);
  });

  it("gives the window's own new tab its minted id instead of opening it a second time", () => {
    adoptSyncOutcome(
      "p",
      {
        version: 4,
        stale: false,
        ops: [{ op: "created", id: "id-c" }],
        tabs: [
          { key: "k1", id: "id-a", label: "A", cmd: "", cwd: "/tmp", kind: "shell" },
          { key: "k2", id: "id-b", label: "B", cmd: "", cwd: "/tmp", kind: "shell" },
          // k3 is this window's id-less new tab, created at the answer's version.
          { key: "k3", id: "id-c", label: "C", cmd: "", cwd: "/tmp", kind: "shell", tmuxSession: `${NAMES.tmuxPrefix}p--shell-1`, createdVersion: 4 },
        ],
      },
      new Set(["k1", "k2", "k3"]),
    );
    const state = useTabsStore.getState();
    expect(state.tabsByScope.p.map((t) => [t.key, t.id])).toEqual([["k1", "id-a"], ["k2", "id-b"], ["k3", "id-c"]]);
    const layout = state.layoutByScope.p;
    expect(layout && layout.type === "group" ? layout.tabKeys : []).toEqual(["k1", "k2", "k3"]);
  });

  it("restores an arriving built-in tab under its current command and drops a retired one, as a hydrate does", () => {
    adoptSyncOutcome(
      "p",
      {
        version: 9,
        stale: true,
        ops: [{ op: "created", id: "id-mon" }, { op: "created", id: "id-mail" }],
        tabs: [
          { key: "k1", id: "id-a", label: "A", cmd: "", cwd: "/tmp", kind: "shell" },
          { key: "k2", id: "id-b", label: "B", cmd: "", cwd: "/tmp", kind: "shell" },
          { key: "k3", id: "id-c", label: "C", cmd: "", cwd: "/tmp", kind: "shell" },
          // Written by an older build under the app's old name.
          { key: "mon", id: "id-mon", label: "Monitor", cmd: `${LEGACY_NAMES.tabCommandPrefix}monitor__`, cwd: "/tmp", kind: "monitor", createdVersion: 5 },
          // A retired kind, however it is spelled, never comes back.
          { key: "mail", id: "id-mail", label: "Mail", cmd: `${LEGACY_NAMES.tabCommandPrefix}mail__`, cwd: "/tmp", createdVersion: 5 },
        ],
      },
      new Set(["k1", "k2", "k3"]),
    );
    const state = useTabsStore.getState();
    expect(state.tabsByScope.p.map((t) => t.label)).toEqual(["A", "B", "C", "Monitor"]);
    expect(state.tabsByScope.p[3].cmd).toBe(MONITOR_TAB_CMD);
    expect(state.tabsByScope.p[3].kind).toBe("monitor");
  });

  it("never closes a tab this window did not send, and ignores a colour outside the palette", () => {
    adoptSyncOutcome(
      "p",
      { version: 4, stale: false, ops: [], tabs: [{ key: "k1", id: "id-a", label: "A", cmd: "", cwd: "/tmp", kind: "shell", color: "not-a-colour" as never }] },
      new Set(["k1"]),
    );
    const state = useTabsStore.getState();
    expect(state.tabsByScope.p.map((t) => t.key)).toEqual(["k1", "k2", "k3"]);
    expect(state.tabsByScope.p[0].color).toBeUndefined();
    expect(state.workspaceVersionByScope.p).toBe(4);
  });
});

describe("applyWorkspacePatch", () => {
  const seed = () =>
    useTabsStore.setState({
      scope: "p",
      tabsByScope: { p: [tab("k1", "A", "id-a"), tab("k2", "B", "id-b")] },
      tabs: [tab("k1", "A", "id-a"), tab("k2", "B", "id-b")],
      layoutByScope: { p: { type: "group", id: "g", tabKeys: ["k1", "k2"], activeKey: "k1" } },
      focusedGroupByScope: { p: "g" },
      detachedGroupsByScope: {},
      hiddenGroupsByScope: {},
      workspaceVersionByScope: { p: 3 },
    });

  beforeEach(() => {
    seed();
    vi.mocked(invoke).mockReset();
  });

  it("fetches the snapshot for a newer version and reconciles every tab this window holds", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      version: 5,
      tabLayout: [{ key: "x", id: "id-a", label: "Renamed elsewhere", cmd: "", cwd: "/tmp", kind: "shell" }],
    });
    await applyWorkspacePatch({ scope: "p", version: 5, ops: [{ op: "updated", id: "id-a" }, { op: "closed", id: "id-b" }] });
    expect(invoke).toHaveBeenCalledWith("workspace_snapshot", { projectId: "p" });
    const state = useTabsStore.getState();
    expect(state.workspaceVersionByScope.p).toBe(5);
    expect(state.tabsByScope.p.map((t) => [t.key, t.label])).toEqual([["k1", "Renamed elsewhere"]]);
  });

  it("refreshWorkspaceScope re-reads a loaded scope when the file moved on (the sidecar's poke)", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      version: 6,
      tabLayout: [
        { key: "x", id: "id-a", label: "A", cmd: "", cwd: "/tmp", kind: "shell" },
        { key: "y", id: "id-b", label: "B", cmd: "", cwd: "/tmp", kind: "shell" },
        { key: "z", id: "id-new", label: "Shell", cmd: "", cwd: "/tmp", kind: "shell", tmuxSession: `${NAMES.tmuxPrefix}p--shell-1`, createdVersion: 6 },
      ],
    });
    await refreshWorkspaceScope("p");
    expect(invoke).toHaveBeenCalledWith("workspace_snapshot", { projectId: "p" });
    expect(useTabsStore.getState().tabsByScope.p.map((t) => t.label)).toEqual(["A", "B", "Shell"]);
    expect(useTabsStore.getState().workspaceVersionByScope.p).toBe(6);
    await refreshWorkspaceScope("other");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("does not open the window's own new tab twice when its sync's patch echo lands before the answer", async () => {
    useTabsStore.setState((s) => ({
      tabsByScope: { p: [...s.tabsByScope.p, tab("k3", "Claude")] },
      tabs: [...s.tabs, tab("k3", "Claude")],
      layoutByScope: { p: { type: "group", id: "g", tabKeys: ["k1", "k2", "k3"], activeKey: "k3" } },
    }));
    vi.mocked(invoke).mockResolvedValueOnce({
      version: 4,
      tabLayout: [
        { key: "k1", id: "id-a", label: "A", cmd: "", cwd: "/tmp", kind: "shell" },
        { key: "k2", id: "id-b", label: "B", cmd: "", cwd: "/tmp", kind: "shell" },
        { key: "k3", id: "id-c", label: "Claude", cmd: "", cwd: "/tmp", kind: "shell", createdVersion: 4 },
      ],
    });
    await applyWorkspacePatch({ scope: "p", version: 4, ops: [{ op: "created", id: "id-c" }] });
    const state = useTabsStore.getState();
    expect(state.tabsByScope.p.map((t) => [t.key, t.id])).toEqual([["k1", "id-a"], ["k2", "id-b"], ["k3", "id-c"]]);
    expect(state.tabs.map((t) => t.key)).toEqual(["k1", "k2", "k3"]);
  });

  it("ignores a patch this window already knows, or for a scope it has not loaded", async () => {
    await applyWorkspacePatch({ scope: "p", version: 3, ops: [{ op: "reordered" }] });
    await applyWorkspacePatch({ scope: "other", version: 9, ops: [{ op: "reordered" }] });
    expect(invoke).not.toHaveBeenCalled();
    expect(useTabsStore.getState().tabsByScope.p.map((t) => t.key)).toEqual(["k1", "k2"]);
  });
});

describe("one tab stays one tab", () => {
  const embed = (key: string, path: string, id?: string): TabEntry => ({
    key, id, label: path, cmd: "", cwd: "/tmp", kind: "embed", scope: "p", embedPath: path, viewer: "text",
  });

  beforeEach(() => {
    useTabsStore.setState({
      scope: "p",
      tabsByScope: { p: [tab("k1", "A", "id-a"), embed("k2", "/w/notes.md", "id-b")] },
      tabs: [tab("k1", "A", "id-a"), embed("k2", "/w/notes.md", "id-b")],
      layoutByScope: { p: { type: "group", id: "g", tabKeys: ["k1", "k2"], activeKey: "k1" } },
      focusedGroupByScope: { p: "g" },
      detachedGroupsByScope: {},
      hiddenGroupsByScope: {},
      workspaceVersionByScope: { p: 3 },
    });
    vi.mocked(invoke).mockReset();
  });

  it("sends a scope's syncs one at a time, so a new tab is never minted a second id", async () => {
    // k3 is new and id-less; two saves fire before the first answer lands.
    useTabsStore.setState((s) => ({
      tabsByScope: { p: [...s.tabsByScope.p, { ...tab("k3", "Shell"), tmuxSession: "t-3" }] },
      tabs: [...s.tabs, { ...tab("k3", "Shell"), tmuxSession: "t-3" }],
      layoutByScope: { p: { type: "group", id: "g", tabKeys: ["k1", "k2", "k3"], activeKey: "k3" } },
    }));
    let answerFirst: (v: unknown) => void = () => {};
    const sent: Array<{ baseVersion?: number; tabs: Array<{ key: string; id?: string }> }> = [];
    vi.mocked(invoke).mockImplementation((cmd: string, args?: unknown) => {
      if (cmd !== "workspace_sync") return Promise.resolve(undefined);
      const payload = args as { baseVersion?: number; tabs: Array<{ key: string; id?: string }> };
      sent.push(payload);
      const answer = (version: number) => ({
        version,
        stale: false,
        ops: [],
        tabs: payload.tabs.map((t) => ({ ...t, id: t.id ?? "id-c", createdVersion: t.id ? 1 : 4 })),
      });
      if (sent.length === 1) return new Promise((resolve) => { answerFirst = () => resolve(answer(4)); });
      return Promise.resolve(answer(5));
    });
    const store = useTabsStore.getState();
    const first = store.persistScope("p", "/p/project.json");
    const second = store.persistScope("p", "/p/project.json");
    await Promise.resolve();
    expect(sent).toHaveLength(1);
    answerFirst(undefined);
    await Promise.all([first, second]);
    expect(sent).toHaveLength(2);
    expect(sent[1].baseVersion).toBe(4);
    expect(sent[1].tabs.find((t) => t.key === "k3")?.id).toBe("id-c");
    expect(useTabsStore.getState().tabsByScope.p.map((t) => t.key)).toEqual(["k1", "k2", "k3"]);
  });

  it("never opens an arriving copy of a tab this window holds — same key, file, tmux session or conversation", () => {
    useTabsStore.setState((s) => ({
      tabsByScope: { p: [...s.tabsByScope.p, { ...tab("k3", "Claude", "id-c"), kind: "agent", cmd: "claude", sessionId: "uid-1", tmuxSession: "t-3" }] },
    }));
    adoptSyncOutcome(
      "p",
      {
        version: 6,
        stale: true,
        ops: [],
        tabs: [
          { key: "k1", id: "id-a", label: "A", cmd: "", cwd: "/tmp", kind: "shell" },
          { key: "k2", id: "id-b", label: "/w/notes.md", cmd: "", cwd: "/tmp", kind: "embed", embedPath: "/w/notes.md", viewer: "text" },
          { key: "k3", id: "id-c", label: "Claude", cmd: "claude", cwd: "/tmp", kind: "agent", sessionId: "uid-1", tmuxSession: "t-3" },
          // The race's second id for k1, and copies of the file and the agent
          // under another client's keys.
          { key: "k1", id: "id-a2", label: "A", cmd: "", cwd: "/tmp", kind: "shell", createdVersion: 5 },
          { key: "headless-1", id: "id-b2", label: "notes", cmd: "", cwd: "/tmp", kind: "embed", embedPath: "/w/notes.md", viewer: "text", createdVersion: 5 },
          { key: "headless-2", id: "id-c2", label: "Claude", cmd: "claude", cwd: "/tmp", kind: "agent", sessionId: "uid-1", tmuxSession: "t-9", createdVersion: 5 },
          { key: "headless-3", id: "id-d2", label: "Shell", cmd: "", cwd: "/tmp", kind: "shell", tmuxSession: "t-3", createdVersion: 5 },
        ],
      },
      new Set(["k1", "k2", "k3"]),
    );
    expect(useTabsStore.getState().tabsByScope.p.map((t) => t.key)).toEqual(["k1", "k2", "k3"]);
  });

  it("keeps the tab array when an answer changes nothing, so the answer schedules no further save", () => {
    const before = useTabsStore.getState();
    adoptSyncOutcome(
      "p",
      {
        version: 4,
        stale: false,
        ops: [],
        tabs: [
          { key: "k1", id: "id-a", label: "A", cmd: "", cwd: "/tmp", kind: "shell" },
          { key: "k2", id: "id-b", label: "/w/notes.md", cmd: "", cwd: "/tmp", kind: "embed", embedPath: "/w/notes.md", viewer: "text" },
        ],
      },
      new Set(["k1", "k2"]),
    );
    const after = useTabsStore.getState();
    expect(after.workspaceVersionByScope.p).toBe(4);
    expect(after.tabs).toBe(before.tabs);
    expect(after.tabsByScope.p).toBe(before.tabsByScope.p);
  });

  it("restores a tab a raced save wrote twice only once", () => {
    useTabsStore.setState({ tabsByScope: {}, layoutByScope: {}, tabs: [], layout: null });
    useTabsStore.getState().loadFromLayout(
      [
        { key: "a", id: "id-a", label: "notes", cmd: "", cwd: "/w", kind: "embed", embedPath: "/w/notes.md", viewer: "text" },
        { key: "b", id: "id-b", label: "Claude", cmd: "claude", cwd: "/w", kind: "agent", sessionId: "uid-1", tmuxSession: "t-1" },
        { key: "c", id: "id-a2", label: "notes", cmd: "", cwd: "/w", kind: "embed", embedPath: "/w/notes.md", viewer: "text" },
        { key: "d", id: "id-b2", label: "Claude", cmd: "claude", cwd: "/w", kind: "agent", sessionId: "uid-1", tmuxSession: "t-1" },
        { key: "b", id: "id-b3", label: "Claude", cmd: "claude", cwd: "/w", kind: "agent", sessionId: "uid-2", tmuxSession: "t-2" },
      ],
      "/w",
      "p",
    );
    expect(useTabsStore.getState().tabsByScope.p.map((t) => t.id)).toEqual(["id-a", "id-b"]);
  });
});

describe("an answer never undoes what this window did since", () => {
  type Sent = { baseVersion?: number; tabs: Array<{ key: string; id?: string; label: string }> };
  const shell = (key: string, label: string, id: string) => ({ key, id, label, cmd: "", cwd: "/tmp", kind: "shell" as const });

  const seed = (scope: string) => {
    const tabs = [{ ...tab("k1", "A", "id-a"), scope }, { ...tab("k2", "B", "id-b"), scope }];
    useTabsStore.setState({
      scope,
      tabsByScope: { [scope]: tabs },
      tabs,
      layoutByScope: { [scope]: { type: "group", id: "g", tabKeys: ["k1", "k2"], activeKey: "k1" } },
      focusedGroupByScope: { [scope]: "g" },
      detachedGroupsByScope: {},
      hiddenGroupsByScope: {},
      workspaceVersionByScope: { [scope]: 3 },
    });
  };

  /** `workspace_sync` answers are held until `answer(i, …)` releases them. */
  const holdSyncs = (snapshot?: unknown) => {
    const sent: Sent[] = [];
    const release: Array<(v: unknown) => void> = [];
    vi.mocked(invoke).mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === "workspace_snapshot") return Promise.resolve(snapshot);
      if (cmd !== "workspace_sync") return Promise.resolve(undefined);
      sent.push(args as Sent);
      return new Promise((resolve) => release.push(resolve));
    });
    const answer = async (i: number, version: number, tabs: unknown[]) => {
      while (!release[i]) await Promise.resolve();
      release[i]({ version, stale: false, ops: [], tabs });
    };
    return { sent, answer };
  };

  const order = (scope: string) => {
    const layout = useTabsStore.getState().layoutByScope[scope];
    return layout && layout.type === "group" ? layout.tabKeys : [];
  };

  beforeEach(() => vi.mocked(invoke).mockReset());

  it("keeps a rename made while its save was in flight, and the next save carries it", async () => {
    seed("s1");
    const { sent, answer } = holdSyncs();
    const first = useTabsStore.getState().persistScope("s1", "");
    useTabsStore.getState().renameTabInScope("s1", "k1", "New name");
    await answer(0, 4, [shell("k1", "A", "id-a"), shell("k2", "B", "id-b")]);
    await first;
    const state = useTabsStore.getState();
    expect(state.tabsByScope.s1.find((t) => t.key === "k1")?.label).toBe("New name");
    expect(state.workspaceVersionByScope.s1).toBe(4);
    const second = state.persistScope("s1", "");
    await answer(1, 5, [shell("k1", "New name", "id-a"), shell("k2", "B", "id-b")]);
    await second;
    expect(sent[1].tabs.find((t) => t.key === "k1")?.label).toBe("New name");
    expect(sent[1].baseVersion).toBe(4);
  });

  it("ignores an answer older than a patch it already took: no old fields, no version going back", async () => {
    seed("s2");
    const { answer } = holdSyncs({ version: 5, tabLayout: [shell("x", "From the phone", "id-a"), shell("y", "B", "id-b")] });
    const save = useTabsStore.getState().persistScope("s2", "");
    await applyWorkspacePatch({ scope: "s2", version: 5, ops: [{ op: "updated", id: "id-a" }] });
    expect(useTabsStore.getState().tabsByScope.s2[0].label).toBe("From the phone");
    await answer(0, 4, [shell("k1", "A", "id-a"), shell("k2", "B", "id-b")]);
    await save;
    const state = useTabsStore.getState();
    expect(state.tabsByScope.s2[0].label).toBe("From the phone");
    expect(state.workspaceVersionByScope.s2).toBe(5);
  });

  it("takes the owner's reorder into the panes, so the next save sends it rather than the tree's old order", async () => {
    seed("s3");
    const { sent, answer } = holdSyncs({ version: 5, tabLayout: [shell("y", "B", "id-b"), shell("x", "A", "id-a")] });
    const save = useTabsStore.getState().persistScope("s3", "");
    await answer(0, 4, [shell("k1", "A", "id-a"), shell("k2", "B", "id-b")]);
    await save;
    await applyWorkspacePatch({ scope: "s3", version: 5, ops: [{ op: "reordered" }] });
    expect(order("s3")).toEqual(["k2", "k1"]);
    expect(useTabsStore.getState().tabsByScope.s3.map((t) => t.key)).toEqual(["k2", "k1"]);
    const strict = useTabsStore.getState().persistScopeStrict("s3", "");
    await answer(1, 5, [shell("k2", "B", "id-b"), shell("k1", "A", "id-a")]);
    await strict;
    expect(sent[1].tabs.map((t) => t.key)).toEqual(["k2", "k1"]);
    expect(sent[1].baseVersion).toBe(5);
  });

  it("keeps a tab-bar reorder made while its save was in flight", async () => {
    seed("s4");
    const { sent, answer } = holdSyncs();
    const first = useTabsStore.getState().persistScope("s4", "");
    useTabsStore.getState().reorderInGroup("g", 1, 0);
    await answer(0, 4, [shell("k1", "A", "id-a"), shell("k2", "B", "id-b")]);
    await first;
    expect(order("s4")).toEqual(["k2", "k1"]);
    const second = useTabsStore.getState().persistScope("s4", "");
    await answer(1, 5, [shell("k2", "B", "id-b"), shell("k1", "A", "id-a")]);
    await second;
    expect(sent[1].tabs.map((t) => t.key)).toEqual(["k2", "k1"]);
  });

  it("restores the owner's order from the tree it moved, and saves that order back", async () => {
    useTabsStore.setState({ scope: "s5", tabsByScope: {}, layoutByScope: {}, tabs: [], layout: null, workspaceVersionByScope: {} });
    const { sent, answer } = holdSyncs({
      version: 5,
      tabLayout: [shell("b", "B", "id-b"), shell("a", "A", "id-a")],
      tabGroups: { type: "group", tabKeys: ["b", "a"], activeKey: "a" },
    });
    expect(await hydrateScopeFromDisk("s5", "/tmp")).toBe(true);
    const state = useTabsStore.getState();
    const labels = (keys: string[]) => keys.map((k) => state.tabsByScope.s5.find((t) => t.key === k)?.label);
    expect(labels(order("s5"))).toEqual(["B", "A"]);
    const strict = state.persistScopeStrict("s5", "");
    await answer(0, 5, [shell("b", "B", "id-b"), shell("a", "A", "id-a")]);
    await strict;
    expect(sent[0].tabs.map((t) => t.label)).toEqual(["B", "A"]);
    expect(sent[0].baseVersion).toBe(5);
  });
});
