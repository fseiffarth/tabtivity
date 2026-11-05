/**
 * "Hand to an agent": the export payload built from the resolver's two texts and
 * times, the side panel's file collection, and which orange rows count as true
 * conflicts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));

import { buildHandoffFile, lineSpan } from "../../lib/viewers/syncHandoff";
import { collectHandoffFiles, joinRemote, timesFromStatus } from "../../lib/viewers/syncHandoffCollect";
import { bothChangedPaths } from "../../lib/remote/divergedRows";
import type { SideTimes } from "../../lib/viewers/syncSideTimes";
import type { SyncEntryStatus } from "../../stores/remote/sync";

const ZERO = "0".repeat(40);
const row = (over: Partial<SyncEntryStatus>): SyncEntryStatus => ({
  state: "amber",
  selected: true,
  isDir: false,
  auto: false,
  excluded: false,
  hostMtime: 200,
  localMtime: 100,
  hostDiverged: true,
  localDiverged: true,
  hostChecked: true,
  ...over,
});

describe("lineSpan", () => {
  it("spells one line, a run and nothing", () => {
    expect(lineSpan([4])).toBe("4");
    expect(lineSpan([4, 5, 6])).toBe("4-6");
    expect(lineSpan([])).toBeNull();
  });
});

describe("buildHandoffFile", () => {
  const times: SideTimes = {
    left: {
      mtime: 1000,
      blame: new Map([[2, { line_no: 2, hash: "ab".repeat(20), short: "abababab", author: "A", author_time: 500, summary: "tune lr" }]]),
    },
    right: {
      mtime: 2000,
      blame: new Map([[2, { line_no: 2, hash: ZERO, short: "00000000", author: "", author_time: 0, summary: "" }]]),
    },
    newer: "right",
    newerBasis: "time",
  };

  it("numbers the changes like the resolver and dates each side", () => {
    const f = buildHandoffFile({ relPath: "a.py", localText: "x\nlocal\ny", remoteText: "x\nremote\ny", times });
    expect(f).toMatchObject({ relPath: "a.py", localMtime: 1000, remoteMtime: 2000, newer: "remote", newerBasis: "time" });
    expect(f.changes).toEqual([
      {
        index: 1,
        localLines: "2",
        remoteLines: "2",
        local: { secs: 500, committed: true, commit: "abababab tune lr" },
        remote: { secs: 2000, committed: false },
        newer: "remote",
      },
    ]);
  });

  it("keeps the line spans but no per-change times without blame", () => {
    const f = buildHandoffFile({ relPath: "a.py", localText: "x\nlocal\ny", remoteText: "x\nremote\ny", times: null });
    expect(f.localMtime).toBeNull();
    expect(f.newer).toBeNull();
    expect(f.changes[0]).toMatchObject({ localLines: "2", remoteLines: "2", local: null, remote: null, newer: null });
  });

  it("leaves the absent side of a pure insertion without lines", () => {
    const f = buildHandoffFile({ relPath: "a", localText: "x\ny", remoteText: "x\nnew\ny", times: null });
    expect(f.changes[0]).toMatchObject({ localLines: null, remoteLines: "2" });
  });
});

describe("bothChangedPaths", () => {
  it("keeps only rows both sides moved, with both copies present", () => {
    const byPath = {
      both: row({}),
      hostOnly: row({ localDiverged: false }),
      goneLocal: row({ localMtime: null }),
    };
    expect(bothChangedPaths(byPath, ["both", "hostOnly", "goneLocal", "unknown"])).toEqual(["both"]);
  });
});

describe("collectHandoffFiles", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("reads both copies of each file and skips one that cannot be read", async () => {
    mockInvoke.mockImplementation((cmd: string, args: { path: string }) => {
      if (cmd !== "read_file_text") return Promise.reject(new Error("unexpected " + cmd));
      if (args.path.includes("broken")) return Promise.reject(new Error("gone"));
      return Promise.resolve(args.path.startsWith("/m/") ? "local" : "remote");
    });
    const progress = vi.fn();
    const out = await collectHandoffFiles({
      projectId: "p",
      rels: ["src/a.py", "broken.py"],
      mirrorRoot: "/m",
      remotePath: "/data/proj/",
      byPath: { "src/a.py": row({}) },
      progress,
    });
    expect(out.skipped).toBe(1);
    expect(out.files).toHaveLength(1);
    expect(out.files[0]).toMatchObject({ relPath: "src/a.py", localText: "local", remoteText: "remote", localMtime: 100, remoteMtime: 200, newer: "remote" });
    expect(mockInvoke).toHaveBeenCalledWith("read_file_text", { path: "/data/proj/src/a.py", projectId: "p" });
    expect(progress).toHaveBeenLastCalledWith(2, 2);
  });
});

describe("helpers", () => {
  it("joins a remote root and a rel with one slash", () => {
    expect(joinRemote("/a/b/", "/c/d")).toBe("/a/b/c/d");
  });
  it("derives file-level times from a status row, or nothing", () => {
    expect(timesFromStatus(undefined)).toBeNull();
    expect(timesFromStatus(row({ hostDiverged: true, localDiverged: false }))).toMatchObject({ newer: "right", newerBasis: "sync" });
  });
});
