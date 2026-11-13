import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSyncStore, type SyncFileMeta } from "../../stores/remote/sync";
import { sshOf, useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import {
  contentKey,
  newerFileSide,
  type BlameEntry,
  type SideTimes,
} from "../../lib/viewers/syncSideTimes";

/** How many file+content blames to keep (each is one `git blame` per side, so
 *  the last three files opened). Each holds a whole file's blame map. */
const CACHE_MAX = 6;
const blameCache = new Map<string, Promise<Map<number, BlameEntry>>>();

/** One `git_blame`, cached per side + directory + file + content. A failure is
 *  dropped from the cache so a later open can retry. `git_blame` runs git on the
 *  mirror for a local directory and over SSH on the host for a remote project's
 *  own directory (it resolves remoteness itself), bounded by the git verb's
 *  ceiling — a stalled host just never lands, and the block times stay off. */
function blameOnce(
  side: "local" | "remote",
  projectDir: string,
  relPath: string,
  text: string,
): Promise<Map<number, BlameEntry>> {
  const key = `${side}\0${projectDir}\0${relPath}\0${contentKey(text)}`;
  const hit = blameCache.get(key);
  if (hit) return hit;
  const p = invoke<BlameEntry[]>("git_blame", { projectDir, relPath }).then((lines) => {
    const m = new Map<number, BlameEntry>();
    for (const l of lines) m.set(l.line_no, l);
    return m;
  });
  blameCache.set(key, p);
  if (blameCache.size > CACHE_MAX) {
    const oldest = blameCache.keys().next().value;
    if (oldest !== undefined) blameCache.delete(oldest);
  }
  p.catch(() => blameCache.delete(key));
  return p;
}

/**
 * The resolver's time cues for one diverged file: each side's last-modified time
 * (`sync_file_meta` — a fresh stat of both; the host's only while connected) and
 * a per-line git blame per side for the per-change commit times. One blame per
 * side per file, never per block. Everything arrives independently and any piece
 * may stay null (cold pool, no git on the host, a timeout): the UI then simply
 * shows less. Returns null until something is known.
 */
export function useSyncSideTimes({
  projectId,
  rel,
  mirrorRoot,
  projectDir,
  localText,
  hostText,
}: {
  projectId: string | null;
  rel: string | null;
  /** The local mirror's root (a git repo when lockstep is on). */
  mirrorRoot: string | null;
  /** The project's own directory — the key `git_blame` resolves the host by. */
  projectDir: string | null;
  localText: string | null;
  hostText: string | null;
}): SideTimes | null {
  const connected = useRemoteStatusStore((s) =>
    projectId ? sshOf(s, projectId) === "connected" : false,
  );
  const status = useSyncStore((s) => (projectId && rel ? s.byProject[projectId]?.[rel] : undefined));

  const [meta, setMeta] = useState<SyncFileMeta | null>(null);
  const [localBlame, setLocalBlame] = useState<Map<number, BlameEntry> | null>(null);
  const [hostBlame, setHostBlame] = useState<Map<number, BlameEntry> | null>(null);

  const loaded = localText != null && hostText != null;

  // Both sides' mtimes: a stat of the host, so only on a live session.
  useEffect(() => {
    setMeta(null);
    if (!loaded || !connected || !projectId || !rel) return;
    let cancelled = false;
    invoke<SyncFileMeta>("sync_file_meta", { projectId, relPath: rel })
      .then((m) => {
        if (!cancelled) setMeta(m);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [loaded, connected, projectId, rel]);

  // Local blame: git on the mirror, no network.
  useEffect(() => {
    setLocalBlame(null);
    if (localText == null || !mirrorRoot || !rel) return;
    let cancelled = false;
    blameOnce("local", mirrorRoot, rel, localText)
      .then((m) => {
        if (!cancelled) setLocalBlame(m);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [localText, mirrorRoot, rel]);

  // Remote blame: git over SSH on the host — only while connected.
  useEffect(() => {
    setHostBlame(null);
    if (hostText == null || !connected || !projectDir || !rel) return;
    let cancelled = false;
    blameOnce("remote", projectDir, rel, hostText)
      .then((m) => {
        if (!cancelled) setHostBlame(m);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [hostText, connected, projectDir, rel]);

  return useMemo(() => {
    // The fresh stat wins; the last status pass fills in for the mirror when the
    // stat has not landed (the host's cached value is not shown while offline).
    const localMtime = meta?.local.exists ? meta.local.mtime : (status?.localMtime ?? null);
    const hostMtime = connected ? (meta ? (meta.host.exists ? meta.host.mtime : null) : (status?.hostMtime ?? null)) : null;
    if (localMtime == null && hostMtime == null && !localBlame && !hostBlame) return null;
    const newer = newerFileSide({
      hostMtime,
      localMtime,
      hostDiverged: status?.hostDiverged ?? false,
      localDiverged: status?.localDiverged ?? false,
    });
    return {
      left: { mtime: localMtime, blame: localBlame },
      right: { mtime: hostMtime, blame: hostBlame },
      newer: newer ? (newer.side === "local" ? "left" : "right") : null,
      newerBasis: newer ? newer.basis : null,
    };
  }, [meta, status, connected, localBlame, hostBlame]);
}
