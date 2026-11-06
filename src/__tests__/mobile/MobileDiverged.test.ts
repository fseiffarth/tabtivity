/**
 * The window's half of the phone's Diverged list (`lib/mobileDiverged`): the
 * same sync commands the orange view calls, with a fresh status pass in front
 * of every act, because the phone's list can be minutes old.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { MOBILE_HOST_KEY } from "../../lib/brand";
import {
  divergedCount,
  divergedDiff,
  divergedList,
  divergedPreview,
  divergedResolve,
  MOBILE_DIFF_CAP,
  MOBILE_SYNC_PROBE_MS,
  previewFingerprint,
  resetMobileSyncProbes,
  stillStands,
  type MobileSyncOp,
} from "../../lib/mobileDiverged";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import { useSettingsStore } from "../../stores/settings";
import { useSyncStore, type SyncEntryStatus } from "../../stores/remote/sync";

const row = (rel: string, over: Record<string, unknown> = {}) => ({
  rel_path: rel,
  is_dir: false,
  selected: true,
  state: "amber",
  auto_sync: false,
  excluded: false,
  host_mtime: 20,
  local_mtime: 10,
  host_diverged: true,
  local_diverged: false,
  host_checked: true,
  ...over,
});

const pushed = { pushed: 1, conflicts: [], failed_total: 0, failed: [], first_error: null, skipped_excluded: 0, skipped_tracked: 0 };

function desktopWith(rows: ReturnType<typeof row>[], answers: Record<string, unknown> = {}) {
  invoke.mockImplementation(async (command: string) => {
    if (command === "sync_status") return rows;
    if (command === "sync_push") return pushed;
    if (command in answers) {
      const answer = answers[command];
      if (answer instanceof Error) throw answer;
      return answer;
    }
    return undefined;
  });
}

const calls = (command: string) => invoke.mock.calls.filter(([name]) => name === command).map(([, args]) => args);

/** The phone's switches and the host the project lives on. A remote host is
 *  careful until the user says it is theirs, so the default fixture says so. */
function configure(host: Record<string, unknown> = {}, settings: Record<string, unknown> = { careful_hosts: { "u@h.example:22": false } }) {
  useSettingsStore.setState({
    settings: { ...settings, [MOBILE_HOST_KEY]: { enabled: true, project_files: true, project_sync: true, ...host } } as never,
  });
  useProjectsStore.setState({ projects: [{ id: "p", remote: { user: "u", host: "h.example", port: 22 } }] as never });
}

beforeEach(() => {
  invoke.mockReset();
  resetMobileSyncProbes();
  useSyncStore.setState({ byProject: {} });
  useRemoteStatusStore.setState({ byProject: {} });
  configure();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

/** The receipt a preview would have handed out for `paths` as the store reads them now. */
async function fingerprintOf(op: MobileSyncOp, paths: string[]) {
  await useSyncStore.getState().refreshStatus("p");
  return previewFingerprint(op, paths, useSyncStore.getState().byProject.p);
}

/** A resolve the phone confirmed: its preview's fingerprint echoed. */
async function resolve(op: MobileSyncOp, paths: string[]) {
  return divergedResolve("p", op, paths, await fingerprintOf(op, paths));
}

describe("the list", () => {
  it("reads a fresh pass and names both kinds of row", async () => {
    desktopWith([row("a.txt"), row("new.txt", { state: "localnew", host_mtime: null, host_checked: false }), row("ok.txt", { state: "green" })]);
    const list = await divergedList("p");
    expect(list.files.map((file) => [file.rel, file.state])).toEqual([["a.txt", "amber"], ["new.txt", "localnew"]]);
    expect(list.files[0]).toMatchObject({ host_mtime: 20, local_mtime: 10, host_diverged: true, host_checked: true });
  });

  it("counts a pass that reached the host as connected, whatever the lamp says", async () => {
    desktopWith([row("ok.txt", { state: "green" })]);
    expect((await divergedList("p")).connected).toBe(true);
  });

  it("is not connected on a cold pool with the lamp off, and the lamp alone will do", async () => {
    desktopWith([row("a.txt", { host_mtime: null, host_checked: false })]);
    expect((await divergedList("p")).connected).toBe(false);
    useRemoteStatusStore.getState().setSsh("p", "connected");
    expect((await divergedList("p")).connected).toBe(true);
  });

  it("gives the project screen the last count, and asks at most once a while", async () => {
    desktopWith([row("a.txt"), row("new.txt", { state: "localnew" })]);
    expect(divergedCount("p", 1_000_000)).toBeUndefined();
    await vi.waitFor(() => expect(useSyncStore.getState().byProject.p).toBeTruthy());
    expect(divergedCount("p", 1_000_000 + MOBILE_SYNC_PROBE_MS - 1)).toBe(2);
    expect(calls("sync_status")).toHaveLength(1);
    divergedCount("p", 1_000_000 + MOBILE_SYNC_PROBE_MS);
    expect(calls("sync_status")).toHaveLength(2);
    expect(divergedCount(undefined)).toBeUndefined();
  });
});

describe("what still stands", () => {
  const entry = (over: Partial<SyncEntryStatus>): SyncEntryStatus => ({
    state: "amber", selected: true, isDir: false, auto: false, excluded: false,
    hostMtime: 20, localMtime: 10, hostDiverged: true, localDiverged: false, hostChecked: true, ...over,
  });

  it.each([
    ["pull", entry({}), true],
    ["pull", entry({ hostMtime: null }), false],
    ["pull", entry({ state: "green" }), false],
    ["pull", undefined, false],
    ["push", entry({}), true],
    ["push", entry({ localMtime: null }), false],
    ["push", entry({ state: "localnew", hostMtime: null }), true],
    ["delete_host", entry({ localMtime: null }), true],
    ["delete_host", entry({}), false],
    ["delete_local", entry({ hostMtime: null }), true],
    ["delete_local", entry({ hostMtime: null, hostChecked: false }), false],
    ["delete_local", entry({}), false],
    ["forget", entry({ hostMtime: null, localMtime: null }), true],
    ["forget", entry({}), false],
  ] as const)("%s over %j is %s", (op, status, expected) => {
    expect(stillStands(op, status)).toBe(expected);
  });
});

describe("acting", () => {
  it("takes the host's copy of each named file, and of nothing else", async () => {
    desktopWith([row("a.txt"), row("b.txt")]);
    await expect(resolve("pull", ["a.txt"])).resolves.toEqual({ status: "sync_resolved", done: 1, failed: 0, skipped: 0 });
    expect(calls("sync_pull")).toEqual([{ projectId: "p", relPath: "a.txt" }]);
  });

  it("forces a diverged file over the host, and never a new one", async () => {
    desktopWith([row("old.txt"), row("new.txt", { state: "localnew", host_mtime: null })]);
    await resolve("push", ["old.txt", "new.txt"]);
    expect(calls("sync_push")).toEqual([
      { projectId: "p", relPath: "old.txt", force: true },
      { projectId: "p", relPath: "new.txt", force: false },
    ]);
  });

  it("reports a new file the host now holds as failed, not done", async () => {
    desktopWith([row("new.txt", { state: "localnew", host_mtime: null })], {});
    invoke.mockImplementation(async (command: string) => {
      if (command === "sync_status") return [row("new.txt", { state: "localnew", host_mtime: null })];
      if (command === "sync_push") return { ...pushed, pushed: 0, conflicts: ["new.txt"] };
      return undefined;
    });
    await expect(resolve("push", ["new.txt"])).resolves.toMatchObject({ done: 0, failed: 1 });
  });

  it("leaves a file alone that changed since the list was read", async () => {
    // Asked to delete the host copy of a file the mirror holds again.
    desktopWith([row("a.txt")]);
    await expect(resolve("delete_host", ["a.txt", "gone.txt"])).resolves.toMatchObject({ done: 0, failed: 0, skipped: 2 });
    expect(calls("sync_apply_delete")).toEqual([]);
  });

  it("completes a deletion only on the side it was asked about", async () => {
    desktopWith([row("a.txt", { local_mtime: null }), row("b.txt", { host_mtime: null })]);
    await expect(resolve("delete_host", ["a.txt", "b.txt"])).resolves.toMatchObject({ done: 1, skipped: 1 });
    expect(calls("sync_apply_delete")).toEqual([{ projectId: "p", relPath: "a.txt", side: "host" }]);
  });

  it("forgets a file gone from both sides", async () => {
    desktopWith([row("a.txt", { host_mtime: null, local_mtime: null })]);
    await expect(resolve("forget", ["a.txt"])).resolves.toMatchObject({ done: 1 });
    expect(calls("sync_mark_selected")).toEqual([{ projectId: "p", relPaths: ["a.txt"], selected: false, isDir: false }]);
  });

  it("counts failures without carrying their words, which may name a path", async () => {
    desktopWith([row("a.txt"), row("b.txt")], { sync_pull: new Error("/home/me/secret failed") });
    const answer = await resolve("pull", ["a.txt", "b.txt"]);
    expect(answer).toEqual({ status: "sync_resolved", done: 0, failed: 2, skipped: 0 });
    expect(JSON.stringify(answer)).not.toContain("/home/me");
  });
});

describe("pricing and comparing", () => {
  it("forces the preview of a diverged file and not of a new one, in the sidecar's spelling", async () => {
    const preview = { files: 1, bytes: 4, overwrites: 1, destructive: ["a.txt"], destructiveTotal: 1, conflicts: 0, tracked: 0, exact: true };
    desktopWith([row("a.txt"), row("new.txt", { state: "localnew", host_mtime: null })], { sync_transfer_preview: preview });
    await useSyncStore.getState().refreshStatus("p");
    const answer = await divergedPreview("p", "push", ["a.txt"]);
    expect(answer).toHaveProperty("status", "sync_preview");
    expect("preview" in answer && answer.preview).toEqual({ files: 1, bytes: 4, overwrites: 1, destructive: ["a.txt"], destructive_total: 1, conflicts: 0, tracked: 0, exact: true });
    await divergedPreview("p", "push", ["new.txt"]);
    expect(calls("sync_transfer_preview").map((args) => (args as { force: boolean }).force)).toEqual([true, false]);
    expect(calls("sync_transfer_preview")[0]).toMatchObject({ projectId: "p", relPath: "", direction: "push", relPaths: ["a.txt"] });
  });

  it("prices a deletion by the files that still stand, with no transfer to size", async () => {
    desktopWith([row("a.txt", { local_mtime: null }), row("b.txt")]);
    const answer = await divergedPreview("p", "delete_host", ["a.txt", "b.txt"]);
    expect(answer).toMatchObject({ status: "sync_preview", preview: { files: 1, destructive: ["a.txt"], destructive_total: 1, exact: true } });
    expect(calls("sync_transfer_preview")).toEqual([]);
    expect(answer).toHaveProperty("fingerprint", await fingerprintOf("delete_host", ["a.txt", "b.txt"]));
  });

  it("cuts a diff to what a phone can hold, and says so", async () => {
    desktopWith([], { sync_diff: "x".repeat(MOBILE_DIFF_CAP + 5) });
    const cut = await divergedDiff("p", "a.txt");
    expect(cut.cut).toBe(true);
    expect(cut.diff).toHaveLength(MOBILE_DIFF_CAP);
    desktopWith([], { sync_diff: "short" });
    await expect(divergedDiff("p", "a.txt")).resolves.toMatchObject({ diff: "short", cut: false });
  });
});


describe("the receipt of a preview (gap 97)", () => {
  const moved = [row("a.txt", { local_mtime: null }), row("b.txt", { local_mtime: null })];

  it("moves nothing without the preview's fingerprint, or with one for other rows", async () => {
    desktopWith(moved);
    for (const bad of [undefined, null, "", "00ff"]) {
      await expect(divergedResolve("p", "delete_host", ["a.txt"], bad)).resolves.toMatchObject({ status: "error", code: "preview_stale" });
    }
    // Other files than the ones previewed, and another op than the one previewed.
    const forB = await fingerprintOf("delete_host", ["b.txt"]);
    await expect(divergedResolve("p", "delete_host", ["a.txt"], forB)).resolves.toMatchObject({ code: "preview_stale" });
    const forPull = await fingerprintOf("pull", ["a.txt"]);
    await expect(divergedResolve("p", "delete_host", ["a.txt"], forPull)).resolves.toMatchObject({ code: "preview_stale" });
    expect(calls("sync_apply_delete")).toEqual([]);
    expect(calls("sync_pull")).toEqual([]);
  });

  it("refuses when a row moved between the preview and the resolve, and acts when none did", async () => {
    desktopWith(moved);
    const receipt = await fingerprintOf("delete_host", ["a.txt"]);
    // The mirror holds the file again by the time the confirmation is answered.
    desktopWith([row("a.txt", { local_mtime: 99 }), moved[1]]);
    await expect(divergedResolve("p", "delete_host", ["a.txt"], receipt)).resolves.toMatchObject({ status: "error", code: "preview_stale" });
    // The host copy changed.
    desktopWith([row("a.txt", { local_mtime: null, host_mtime: 21 }), moved[1]]);
    await expect(divergedResolve("p", "delete_host", ["a.txt"], receipt)).resolves.toMatchObject({ code: "preview_stale" });
    expect(calls("sync_apply_delete")).toEqual([]);
    desktopWith(moved);
    await expect(divergedResolve("p", "delete_host", ["a.txt"], receipt)).resolves.toMatchObject({ status: "sync_resolved", done: 1 });
    expect(calls("sync_apply_delete")).toEqual([{ projectId: "p", relPath: "a.txt", side: "host" }]);
  });

  it("holds a take-a-side to its receipt too, and a forget needs none", async () => {
    desktopWith([row("a.txt"), row("gone.txt", { host_mtime: null, local_mtime: null })]);
    await expect(divergedResolve("p", "pull", ["a.txt"])).resolves.toMatchObject({ code: "preview_stale" });
    await expect(divergedResolve("p", "push", ["a.txt"])).resolves.toMatchObject({ code: "preview_stale" });
    expect(calls("sync_pull")).toEqual([]);
    await expect(divergedResolve("p", "forget", ["gone.txt"])).resolves.toMatchObject({ status: "sync_resolved", done: 1 });
  });

  it("repeats the project_sync switch, with the browser switch under it", async () => {
    desktopWith(moved);
    const receipt = await fingerprintOf("delete_host", ["a.txt"]);
    for (const host of [{ project_sync: false }, { project_sync: undefined }, { project_files: false }]) {
      configure(host);
      await expect(divergedPreview("p", "pull", ["a.txt"])).resolves.toMatchObject({ status: "error", code: "sync_off" });
      await expect(divergedResolve("p", "delete_host", ["a.txt"], receipt)).resolves.toMatchObject({ code: "sync_off" });
      await expect(divergedResolve("p", "forget", ["a.txt"])).resolves.toMatchObject({ code: "sync_off" });
    }
    useSettingsStore.setState({ settings: null });
    await expect(divergedResolve("p", "forget", ["a.txt"])).resolves.toMatchObject({ code: "sync_off" });
    expect(calls("sync_apply_delete")).toEqual([]);
    expect(calls("sync_mark_selected")).toEqual([]);
  });

  describe("careful and HPC hosts refuse a phone-driven delete", () => {
    const attempt = async () => {
      desktopWith(moved);
      const receipt = await fingerprintOf("delete_host", ["a.txt"]);
      const localReceipt = await fingerprintOf("delete_local", ["a.txt"]);
      return [
        await divergedPreview("p", "delete_host", ["a.txt"]),
        await divergedPreview("p", "delete_local", ["a.txt"]),
        await divergedResolve("p", "delete_host", ["a.txt"], receipt),
        await divergedResolve("p", "delete_local", ["a.txt"], localReceipt),
      ];
    };

    it("by default, since every remote host is careful until the user says it is theirs", async () => {
      configure({}, {});
      for (const answer of await attempt()) expect(answer).toMatchObject({ status: "error", code: "careful_host" });
      expect(calls("sync_apply_delete")).toEqual([]);
    });

    it("whatever careful_hosts says, when the host is tagged HPC", async () => {
      configure({}, { careful_hosts: { "u@h.example:22": false }, hpc_hosts: { "u@h.example:22": true } });
      for (const answer of await attempt()) expect(answer).toMatchObject({ code: "careful_host" });
      expect(calls("sync_apply_delete")).toEqual([]);
    });

    it("for a project the window cannot place", async () => {
      useProjectsStore.setState({ projects: [] });
      for (const answer of await attempt()) expect(answer).toMatchObject({ code: "careful_host" });
    });

    it("but not a take-a-side or a forget, and not on a host the user called their own", async () => {
      configure({}, {});
      desktopWith(moved);
      await expect(resolve("pull", ["a.txt"])).resolves.toMatchObject({ status: "sync_resolved", done: 1 });
      configure();
      const answers = await attempt();
      expect(answers[0]).toMatchObject({ status: "sync_preview" });
      expect(answers[2]).toMatchObject({ status: "sync_resolved", done: 1 });
    });
  });

  it("records the loss of local files through the commands that file it", async () => {
    // The phone adds no destructive path of its own: a take-the-host's-copy is
    // `sync_pull` (which files `Overwritten` for unsynced edits before it
    // writes), and completing a host deletion is `sync_apply_delete` with
    // side "local" (which files `Deleted` after it removes the mirror copy).
    // The Rust side pins both (`commands::sync` tests); this pins the mapping.
    desktopWith([row("a.txt"), row("b.txt", { host_mtime: null })]);
    await resolve("pull", ["a.txt"]);
    await resolve("delete_local", ["b.txt"]);
    expect(calls("sync_pull")).toEqual([{ projectId: "p", relPath: "a.txt" }]);
    expect(calls("sync_apply_delete")).toEqual([{ projectId: "p", relPath: "b.txt", side: "local" }]);
  });
});
