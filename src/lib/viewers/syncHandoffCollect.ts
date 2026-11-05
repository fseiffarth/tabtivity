/**
 * Read the two copies of several diverged files for "Hand to an agent" from the
 * orange list (the resolver already holds its own). The mirror copy is read
 * locally, the host copy over SFTP, both through `read_file_text`; a file that
 * cannot be read, or is over the export's size cap, is left out and counted —
 * one bad file does not sink the rest. Remote text is data only.
 */
import { invoke } from "@tauri-apps/api/core";
import type { SyncEntryStatus } from "../../stores/remote/sync";
import { buildHandoffFile, type HandoffFile } from "./syncHandoff";
import { newerFileSide, type SideTimes } from "./syncSideTimes";

/** The export's per-text cap (`services::sync_handoff::MAX_FILE_BYTES`). */
export const HANDOFF_MAX_TEXT_BYTES = 8 * 1024 * 1024;

/** Join a remote directory and a project-relative path with a single `/`
 *  (POSIX — the host is always Unix here), tolerating a trailing slash on the
 *  root and a leading one on the rel. */
export function joinRemote(root: string, rel: string): string {
  return `${root.replace(/\/+$/, "")}/${rel.replace(/^\/+/, "")}`;
}

/** File-level times from a status row (no blame outside the resolver). */
export function timesFromStatus(e: SyncEntryStatus | undefined): SideTimes | null {
  if (!e || (e.localMtime == null && e.hostMtime == null)) return null;
  const newer = newerFileSide(e);
  return {
    left: { mtime: e.localMtime, blame: null },
    right: { mtime: e.hostMtime, blame: null },
    newer: newer ? (newer.side === "local" ? "left" : "right") : null,
    newerBasis: newer ? newer.basis : null,
  };
}

function tooBig(text: string): boolean {
  // `length` is a lower bound of the UTF-8 size; measure only when it could matter.
  return text.length * 3 > HANDOFF_MAX_TEXT_BYTES && new Blob([text]).size > HANDOFF_MAX_TEXT_BYTES;
}

export async function collectHandoffFiles(input: {
  projectId: string;
  rels: string[];
  mirrorRoot: string;
  remotePath: string;
  byPath: Record<string, SyncEntryStatus> | undefined;
  progress?: (done: number, total: number) => void;
}): Promise<{ files: HandoffFile[]; skipped: number }> {
  const { projectId, rels, mirrorRoot, remotePath, byPath, progress } = input;
  const files: HandoffFile[] = [];
  let skipped = 0;
  for (let i = 0; i < rels.length; i++) {
    progress?.(i, rels.length);
    const rel = rels[i];
    try {
      const [localText, remoteText] = await Promise.all([
        invoke<string>("read_file_text", { path: `${mirrorRoot}/${rel}`, projectId }),
        invoke<string>("read_file_text", { path: joinRemote(remotePath, rel), projectId }),
      ]);
      if (tooBig(localText) || tooBig(remoteText)) {
        skipped++;
        continue;
      }
      files.push(buildHandoffFile({ relPath: rel, localText, remoteText, times: timesFromStatus(byPath?.[rel]) }));
    } catch {
      skipped++;
    }
  }
  progress?.(rels.length, rels.length);
  return { files, skipped };
}
