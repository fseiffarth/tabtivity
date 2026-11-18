/**
 * Pure helpers for the sync resolver's "Hand to an agent" export: the payload
 * the backend writes (`services::sync_handoff`), built from the two texts the
 * resolver (or the side panel) already holds. No DOM, no Tauri.
 */
import { diffLines, groupChanges, blockSideLines } from "./linediff";
import {
  blockSideTime,
  newerSide,
  type SideTime,
  type SideTimes,
} from "./syncSideTimes";

/** The payload, in the backend's camelCase shape. */
export interface HandoffStamp {
  secs: number;
  committed: boolean;
  /** `<short hash> <subject>` of the newest commit, when committed. */
  commit?: string;
}

export interface HandoffChange {
  index: number;
  localLines: string | null;
  remoteLines: string | null;
  local: HandoffStamp | null;
  remote: HandoffStamp | null;
  newer: "local" | "remote" | null;
}

export interface HandoffFile {
  relPath: string;
  localText: string;
  remoteText: string;
  localMtime: number | null;
  remoteMtime: number | null;
  newer: "local" | "remote" | null;
  newerBasis: "sync" | "time" | null;
  changes: HandoffChange[];
}

/** "12-14" for consecutive lines, "12" for one, null for none. */
export function lineSpan(lines: number[]): string | null {
  if (lines.length === 0) return null;
  const first = lines[0];
  const last = lines[lines.length - 1];
  return first === last ? String(first) : `${first}-${last}`;
}

function stamp(t: SideTime | null): HandoffStamp | null {
  if (!t) return null;
  return {
    secs: t.secs,
    committed: t.committed,
    ...(t.commit ? { commit: `${t.commit.short} ${t.commit.summary}`.trim() } : {}),
  };
}

/**
 * One diverged file as the export wants it. `times` may be absent (the side
 * panel has no blame): the file-level times and the changes' line spans are
 * still written, the per-change times just stay off. The diff is the
 * resolver's own (`diffLines(local, remote)`), so the numbers match its chips.
 */
export function buildHandoffFile(input: {
  relPath: string;
  localText: string;
  remoteText: string;
  times: SideTimes | null;
}): HandoffFile {
  const { relPath, localText, remoteText, times } = input;
  const rows = diffLines(localText, remoteText);
  const blocks = groupChanges(rows);
  const spans = blockSideLines(rows, blocks);
  const changes: HandoffChange[] = blocks.map((_, i) => {
    const local = times ? blockSideTime(spans[i]?.left ?? [], times.left.blame, times.left.mtime) : null;
    const remote = times ? blockSideTime(spans[i]?.right ?? [], times.right.blame, times.right.mtime) : null;
    const newer = newerSide(local, remote);
    return {
      index: i + 1,
      localLines: lineSpan(spans[i]?.left ?? []),
      remoteLines: lineSpan(spans[i]?.right ?? []),
      local: stamp(local),
      remote: stamp(remote),
      newer: newer === "left" ? "local" : newer === "right" ? "remote" : null,
    };
  });
  return {
    relPath,
    localText,
    remoteText,
    localMtime: times?.left.mtime ?? null,
    remoteMtime: times?.right.mtime ?? null,
    newer: times?.newer === "left" ? "local" : times?.newer === "right" ? "remote" : null,
    newerBasis: times?.newerBasis ?? null,
    changes,
  };
}
