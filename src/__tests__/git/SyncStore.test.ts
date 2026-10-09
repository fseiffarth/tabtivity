/**
 * SSH-sync Phase 1 — the frontend sync store. Locks that the manifest cache
 * indexes `sync_status` rows by path, that the actions invoke the matching
 * backend commands (and refresh afterwards), and that the `sync-progress` stream
 * updates the in-flight progress / refreshes on completion.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import {
  useSyncStore,
  listenSyncProgress,
  dirSyncAggregate,
  localNewPaths,
  type SyncEntryStatus,
} from "../../stores/remote/sync";

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

function reset() {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue([] as never);
  useSyncStore.setState({ byProject: {}, progressByProject: {} });
}

describe("sync store actions", () => {
  beforeEach(reset);

  it("refreshStatus indexes rows by rel_path", async () => {
    invokeMock.mockResolvedValueOnce([
      { rel_path: "src/main.rs", is_dir: false, selected: true, state: "green" },
      { rel_path: "docs", is_dir: true, selected: true, state: "green" },
    ] as never);
    await useSyncStore.getState().refreshStatus("p1");
    const m = useSyncStore.getState().byProject["p1"];
    expect(m["src/main.rs"]).toEqual({
      state: "green",
      selected: true,
      isDir: false,
      hostDiverged: false,
      localDiverged: false,
      hostChecked: false,
    });
    expect(m["docs"].isDir).toBe(true);
  });

  it("refreshStatus maps host_diverged/local_diverged/host_checked onto the row", async () => {
    invokeMock.mockResolvedValueOnce([
      {
        rel_path: "a.txt",
        is_dir: false,
        selected: true,
        state: "amber",
        host_diverged: true,
        local_diverged: false,
        host_checked: true,
      },
      // An older backend without the fields defaults all three to false.
      { rel_path: "b.txt", is_dir: false, selected: true, state: "amber" },
    ] as never);
    await useSyncStore.getState().refreshStatus("p1");
    const m = useSyncStore.getState().byProject["p1"];
    expect(m["a.txt"].hostDiverged).toBe(true);
    expect(m["a.txt"].localDiverged).toBe(false);
    expect(m["a.txt"].hostChecked).toBe(true);
    expect(m["b.txt"].hostDiverged).toBe(false);
    expect(m["b.txt"].localDiverged).toBe(false);
    expect(m["b.txt"].hostChecked).toBe(false);
  });

  it("pull invokes sync_pull then refreshes status", async () => {
    await useSyncStore.getState().pull("p1", "src/lib.rs");
    const calls = invokeMock.mock.calls.map((c) => c[0]);
    expect(calls).toContain("sync_pull");
    expect(calls).toContain("sync_status");
    const pullArgs = invokeMock.mock.calls.find((c) => c[0] === "sync_pull")![1];
    expect(pullArgs).toEqual({ projectId: "p1", relPath: "src/lib.rs" });
  });

  it("pull and syncWholeProject return the files left on the host as too large", async () => {
    const skipped = [{ rel: "data/big.bin", size: 70 * 1024 * 1024 }];
    invokeMock.mockImplementation(((cmd: string) =>
      Promise.resolve(
        cmd === "sync_pull" || cmd === "sync_whole_project"
          ? { pulled: 2, skippedTooLarge: skipped }
          : [],
      )) as never);
    expect(await useSyncStore.getState().pull("p1", "data")).toEqual({ pulled: 2, skippedTooLarge: skipped });
    expect(await useSyncStore.getState().syncWholeProject("p1")).toEqual({
      pulled: 2,
      skippedTooLarge: skipped,
    });
    // An answer without the field (an older backend) reads as nothing skipped.
    invokeMock.mockImplementation(((cmd: string) =>
      Promise.resolve(cmd === "sync_pull" ? 3 : [])) as never);
    expect(await useSyncStore.getState().pull("p1", "data")).toEqual({ pulled: 3, skippedTooLarge: [] });
  });

  it("resolveAll on the host side collects the files left on the host as too large", async () => {
    const big = { rel: "data/big.bin", size: 70 * 1024 * 1024 };
    invokeMock.mockImplementation(((cmd: string, args?: { relPath?: string }) => {
      if (cmd !== "sync_pull") return Promise.resolve([]);
      if (args?.relPath === "data/bad.txt") return Promise.reject(new Error("gone"));
      return Promise.resolve(
        args?.relPath === "data/big.bin" ? { pulled: 0, skippedTooLarge: [big] } : { pulled: 1, skippedTooLarge: [] },
      );
    }) as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      await useSyncStore.getState().resolveAll("p1", ["a.txt", "data/big.bin", "data/bad.txt"], "host"),
    ).toEqual([big]);
    err.mockRestore();
    // The local side pushes; nothing is pulled, nothing reported.
    expect(await useSyncStore.getState().resolveAll("p1", ["a.txt"], "local")).toEqual([]);
  });

  it("markSelected forwards the selection + dir flag", async () => {
    await useSyncStore.getState().markSelected("p1", ["a", "b"], false, true);
    const args = invokeMock.mock.calls.find((c) => c[0] === "sync_mark_selected")![1];
    expect(args).toEqual({ projectId: "p1", relPaths: ["a", "b"], selected: false, isDir: true });
  });

  it("syncWholeProject calls its command", async () => {
    await useSyncStore.getState().syncWholeProject("p1");
    const calls = invokeMock.mock.calls.map((c) => c[0]);
    expect(calls).toContain("sync_whole_project");
  });

  it("push forwards force + returns conflicts", async () => {
    invokeMock.mockResolvedValueOnce({
      pushed: 1,
      conflicts: ["a.txt"],
      skipped_excluded: 2,
    } as never);
    const res = await useSyncStore.getState().push("p1", "a.txt", false);
    // The result passes through untouched — `skipped_excluded` included, so the
    // "N excluded" report reads the backend's own count.
    expect(res).toEqual({ pushed: 1, conflicts: ["a.txt"], skipped_excluded: 2 });
    const args = invokeMock.mock.calls.find((c) => c[0] === "sync_push")![1];
    expect(args).toEqual({ projectId: "p1", relPath: "a.txt", force: false });
    // It refreshes status afterwards.
    expect(invokeMock.mock.calls.some((c) => c[0] === "sync_status")).toBe(true);
  });

  // The marker has to be on screen the moment the backend accepted it: the
  // refresh behind it re-stats every selected file over the pooled SFTP session
  // and can be blocked for minutes by an in-flight push, which is exactly when
  // "Exclude from sync" looked like a menu item that did nothing.
  it("setExcluded marks the path before sync_status answers", async () => {
    // A refresh that never resolves stands in for one queued behind a transfer.
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "sync_status" ? new Promise(() => {}) : Promise.resolve(undefined),
    );
    void useSyncStore.getState().setExcluded("p1", ["data/raw"], true);
    await Promise.resolve();
    await Promise.resolve();
    const row = useSyncStore.getState().byProject["p1"]?.["data/raw"];
    expect(row?.excluded).toBe(true);
    // `sync_set_excluded` marks every path a directory and clears auto-sync;
    // the cache has to say the same, or the tree's ✕ and ⟳ disagree with it.
    expect(row?.isDir).toBe(true);
    expect(row?.auto).toBe(false);
  });

  it("setExcluded(false) lifts the marker on an existing row", async () => {
    useSyncStore.setState({
      byProject: {
        p1: {
          "data/raw": {
            state: "green",
            selected: true,
            isDir: true,
            auto: false,
            excluded: true,
            hostMtime: null,
            localMtime: null,
            hostDiverged: false,
            localDiverged: false,
            hostChecked: false,
          },
        },
      },
    });
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "sync_status" ? new Promise(() => {}) : Promise.resolve(undefined),
    );
    void useSyncStore.getState().setExcluded("p1", ["data/raw"], false);
    await Promise.resolve();
    await Promise.resolve();
    const row = useSyncStore.getState().byProject["p1"]?.["data/raw"];
    expect(row?.excluded).toBe(false);
    // Lifting an exclusion restores no auto-sync — the backend's `auto_off`
    // stays set, so re-arming it is the user's own second action.
    expect(row?.auto).toBe(false);
    expect(row?.state).toBe("green");
  });

  it("setAuto on lifts the path's own exclusion, off leaves it", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "sync_status" ? new Promise(() => {}) : Promise.resolve(undefined),
    );
    // The giant-folder prompt's standing answer: excluded, auto off.
    useSyncStore.setState({
      byProject: {
        p1: {
          data: {
            state: "none",
            selected: false,
            isDir: true,
            auto: false,
            excluded: true,
            hostMtime: null,
            localMtime: null,
            hostDiverged: false,
            localDiverged: false,
            hostChecked: false,
          },
        },
      },
    });
    void useSyncStore.getState().setAuto("p1", ["data"], true, true);
    await Promise.resolve();
    await Promise.resolve();
    // The backend clears `excluded` on auto-on (the two markers cannot coexist —
    // an excluded entry stays excluded whatever its auto flag says); the cache
    // must say the same or the row keeps its "Include in sync" label.
    const on = useSyncStore.getState().byProject["p1"]?.["data"];
    expect(on?.auto).toBe(true);
    expect(on?.excluded).toBe(false);

    void useSyncStore.getState().setAuto("p1", ["data"], false, true);
    await Promise.resolve();
    await Promise.resolve();
    const off = useSyncStore.getState().byProject["p1"]?.["data"];
    expect(off?.auto).toBe(false);
    expect(off?.excluded).toBe(false);
  });

  it("setAuto marks the path before sync_status answers", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "sync_status" ? new Promise(() => {}) : Promise.resolve(undefined),
    );
    void useSyncStore.getState().setAuto("p1", ["data"], true, true);
    await Promise.resolve();
    await Promise.resolve();
    expect(useSyncStore.getState().byProject["p1"]?.["data"]?.auto).toBe(true);
  });
});

describe("dirSyncAggregate", () => {
  const row = (partial: Partial<SyncEntryStatus>): SyncEntryStatus => ({
    state: "green",
    selected: true,
    isDir: false,
    auto: false,
    excluded: false,
    hostMtime: null,
    localMtime: null,
    hostDiverged: false,
    localDiverged: false,
    hostChecked: false,
    ...partial,
  });

  it("a green file plus a 'none' sibling still reads all-green", () => {
    // The "none" row (untracked / deselected / excluded) must not vote — it used
    // to pin allGreen false forever, leaving the folder's push button red after
    // a successful push.
    const agg = dirSyncAggregate({
      "dir/a.txt": row({ state: "green" }),
      "dir/b.txt": row({ state: "none", selected: false }),
    });
    expect(agg["dir"]).toEqual({ any: true, allGreen: true, anyNew: false });
  });

  it("an amber descendant breaks allGreen", () => {
    const agg = dirSyncAggregate({
      "dir/sub/a.txt": row({ state: "amber" }),
      "dir/b.txt": row({ state: "green" }),
    });
    expect(agg["dir"]).toEqual({ any: true, allGreen: false, anyNew: false });
    expect(agg["dir/sub"]).toEqual({ any: true, allGreen: false, anyNew: false });
  });

  it("a folder with only 'none' descendants is absent from the aggregate", () => {
    const agg = dirSyncAggregate({
      "dir/a.txt": row({ state: "none", selected: false }),
    });
    expect(agg["dir"]).toBeUndefined();
  });

  it("rolls up onto the root, which has no row of its own", () => {
    // The tree head's folder-level slot reads agg[""] for the project root — the
    // one folder that is never an entry in any listing, and where the pull/push
    // control was therefore missing entirely.
    const agg = dirSyncAggregate({
      "top.txt": row({ state: "green" }),
      "dir/a.txt": row({ state: "green" }),
    });
    expect(agg[""]).toEqual({ any: true, allGreen: true, anyNew: false });
    expect(dirSyncAggregate({ "dir/a.txt": row({ state: "amber" }) })[""]).toEqual({
      any: true,
      allGreen: false,
      anyNew: false,
    });
  });

  it("dir rows do not vote", () => {
    // A directory's own entry is authoritative at the lookup site; it must not
    // feed the roll-up (a backend dir row is always green anyway).
    const agg = dirSyncAggregate({
      "dir/sub": row({ isDir: true, state: "green" }),
    });
    expect(agg["dir"]).toBeUndefined();
  });

  it("a NEW local-only file sets anyNew without breaking allGreen or any", () => {
    // `localnew` must not vote amber (the folder wants the actionable upload
    // affordance, not the inert ± marker) and must not set `any` either: a
    // folder with ONLY new files keeps any:false → state "none" → the red push
    // button, exactly what it showed before the state existed.
    const agg = dirSyncAggregate({
      "dir/a.txt": row({ state: "green" }),
      "dir/new.yml": row({ state: "localnew", selected: false }),
      "only-new/b.yml": row({ state: "localnew", selected: false }),
    });
    expect(agg["dir"]).toEqual({ any: true, allGreen: true, anyNew: true });
    expect(agg["only-new"]).toEqual({ any: false, allGreen: true, anyNew: true });
    expect(agg[""]).toEqual({ any: true, allGreen: true, anyNew: true });
  });
});

describe("localNewPaths", () => {
  const row = (partial: Partial<SyncEntryStatus>): SyncEntryStatus => ({
    state: "green",
    selected: true,
    isDir: false,
    auto: false,
    excluded: false,
    hostMtime: null,
    localMtime: null,
    hostDiverged: false,
    localDiverged: false,
    hostChecked: false,
    ...partial,
  });

  it("returns only localnew rows, sorted; separate from the amber list", () => {
    // A new file has one side only (upload or ignore) — mixing it into the
    // amber list would offer merge/take-remote actions with nothing to act on.
    const map = {
      "b/new.yml": row({ state: "localnew", selected: false }),
      "a/new.yml": row({ state: "localnew", selected: false }),
      "c/diverged.txt": row({ state: "amber" }),
      "d/ok.txt": row({ state: "green" }),
    };
    expect(localNewPaths(map)).toEqual(["a/new.yml", "b/new.yml"]);
    expect(localNewPaths(undefined)).toEqual([]);
  });
});

describe("sync-progress subscription", () => {
  beforeEach(() => {
    reset();
    listenMock.mockClear();
  });

  it("tracks in-flight progress and clears + refreshes on done", async () => {
    let handler: ((ev: { payload: unknown }) => void) | null = null;
    listenMock.mockImplementationOnce((_evt, cb) => {
      handler = cb as typeof handler;
      return Promise.resolve(() => {});
    });
    await listenSyncProgress();
    expect(handler).toBeTruthy();

    handler!({ payload: { project_id: "p1", phase: "file", rel_path: "a.txt", done: 1, total: 3 } });
    expect(useSyncStore.getState().progressByProject["p1"]).toEqual({ rel: "a.txt", done: 1, total: 3 });

    handler!({ payload: { project_id: "p1", phase: "done", rel_path: "", done: 3, total: 3 } });
    expect(useSyncStore.getState().progressByProject["p1"]).toBeNull();
    // The done event triggers a status refresh.
    expect(invokeMock.mock.calls.some((c) => c[0] === "sync_status")).toBe(true);
  });
});
