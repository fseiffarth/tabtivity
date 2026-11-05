/**
 * The sync resolver's time cues: dating a change block per side from blame,
 * naming the newer side, and the whole-file verdict that prefers the backend's
 * per-side flags over cross-machine mtimes.
 */
import { describe, it, expect } from "vitest";
import {
  absoluteWhen,
  blockSideTime,
  contentKey,
  isUncommittedHash,
  newerFileSide,
  newerSide,
  relativeWhen,
  type BlameEntry,
} from "../../lib/viewers/syncSideTimes";

const ZERO = "0".repeat(40);
const entry = (line_no: number, hash: string, author_time: number): BlameEntry => ({
  line_no,
  hash,
  short: hash.slice(0, 8),
  author: "Ada",
  author_time,
  summary: `subject ${hash.slice(0, 2)}`,
});
const blameOf = (...es: BlameEntry[]) => new Map(es.map((e) => [e.line_no, e]));

describe("blockSideTime", () => {
  it("is off without blame or without lines on the side", () => {
    expect(blockSideTime([1], null, 500)).toBeNull();
    expect(blockSideTime([], blameOf(entry(1, "ab".repeat(20), 100)), 500)).toBeNull();
  });

  it("takes the newest commit of a fully committed block", () => {
    const b = blameOf(entry(1, "aa".repeat(20), 100), entry(2, "bb".repeat(20), 300), entry(3, "cc".repeat(20), 200));
    const t = blockSideTime([1, 2, 3], b, 999);
    expect(t).toMatchObject({ secs: 300, committed: true });
    expect(t?.commit?.short).toBe("bbbbbbbb");
  });

  it("dates a block with any uncommitted line by the file's save time", () => {
    const b = blameOf(entry(1, "aa".repeat(20), 100), entry(2, ZERO, 777));
    expect(blockSideTime([1, 2], b, 900)).toEqual({ secs: 900, committed: false });
  });

  it("never invents a time: uncommitted with no mtime is null", () => {
    expect(blockSideTime([1], blameOf(entry(1, ZERO, 5)), null)).toBeNull();
    expect(blockSideTime([1], blameOf(entry(1, ZERO, 5)), 0)).toBeNull();
  });

  it("reads an empty blame (not a repo) as not committed", () => {
    expect(blockSideTime([1, 2], new Map(), 42)).toEqual({ secs: 42, committed: false });
  });

  it("is null when blame covers none of the lines", () => {
    expect(blockSideTime([9], blameOf(entry(1, "aa".repeat(20), 100)), 5)).toBeNull();
  });
});

describe("newerSide", () => {
  const at = (secs: number) => ({ secs, committed: true });
  it("needs both sides dated", () => {
    expect(newerSide(null, at(5))).toBeNull();
    expect(newerSide(at(5), null)).toBeNull();
  });
  it("names the later side, and calls a tie no side", () => {
    expect(newerSide(at(10), at(5))).toBe("left");
    expect(newerSide(at(5), at(10))).toBe("right");
    expect(newerSide(at(5), at(5))).toBeNull();
    expect(newerSide(at(5), at(6))).toBeNull(); // within a second
  });
});

describe("newerFileSide", () => {
  it("prefers the side that moved from its own base over mtimes", () => {
    expect(
      newerFileSide({ hostMtime: 100, localMtime: 900, hostDiverged: true, localDiverged: false }),
    ).toEqual({ side: "host", basis: "sync" });
    expect(
      newerFileSide({ hostMtime: 900, localMtime: 100, hostDiverged: false, localDiverged: true }),
    ).toEqual({ side: "local", basis: "sync" });
  });
  it("falls back to mtimes when both moved", () => {
    expect(
      newerFileSide({ hostMtime: 200, localMtime: 100, hostDiverged: true, localDiverged: true }),
    ).toEqual({ side: "host", basis: "time" });
    expect(
      newerFileSide({ hostMtime: 100, localMtime: 100, hostDiverged: true, localDiverged: true }),
    ).toBeNull();
  });
  it("says nothing when a side is missing", () => {
    expect(
      newerFileSide({ hostMtime: null, localMtime: 100, hostDiverged: true, localDiverged: false }),
    ).toBeNull();
  });
});

describe("helpers", () => {
  it("recognises git's not-committed pseudo hash", () => {
    expect(isUncommittedHash(ZERO)).toBe(true);
    expect(isUncommittedHash("")).toBe(true);
    expect(isUncommittedHash("ab".repeat(20))).toBe(false);
  });

  it("fingerprints content: equal text, equal key; any edit, new key", () => {
    expect(contentKey("a\nb")).toBe(contentKey("a\nb"));
    expect(contentKey("a\nb")).not.toBe(contentKey("a\nc"));
  });

  it("spells relative times against a given clock", () => {
    const now = Date.UTC(2026, 10, 5, 12, 0, 0);
    const secs = now / 1000;
    expect(relativeWhen(secs - 3 * 3600, now, "en")).toBe("3 hours ago");
    expect(relativeWhen(secs - 2 * 86400, now, "en")).toBe("2 days ago");
    expect(relativeWhen(secs - 3 * 3600, now, "en", "narrow")).toMatch(/3\s?h/);
    expect(absoluteWhen(secs, "en")).toContain("2026");
  });
});
