import { invoke } from "@tauri-apps/api/core";
import { deleteSideOf } from "./remote/divergedRows";
import { useRemoteStatusStore } from "../stores/remote/remoteStatus";
import { amberPaths, localNewPaths, useSyncStore, type SyncEntryStatus, type SyncResolveOutcome } from "../stores/remote/sync";
import type { SyncDirection, SyncTransferPreview } from "../stores/remote/syncConfirm";

/**
 * The window's half of the phone's Diverged list (`mobile_control::diverged`):
 * it holds the SSH session, so the status pass, the previews and the transfers
 * all run here, over the commands and the store the orange view itself uses.
 * Project-relative paths only; why a command failed stays on this side, since
 * the backend's sentences may name a full path.
 */

export interface MobileDivergedFile {
  rel: string;
  state: "amber" | "localnew";
  host_mtime: number | null;
  local_mtime: number | null;
  host_diverged: boolean;
  local_diverged: boolean;
  host_checked: boolean;
}

export type MobileSyncOp = "pull" | "push" | "delete_host" | "delete_local" | "forget";

export interface MobileSyncPreview {
  files: number;
  bytes: number;
  overwrites: number;
  destructive: string[];
  destructive_total: number;
  conflicts: number;
  tracked: number;
  exact: boolean;
}

/** How long a list waits on the status pass before it goes out with the last
 *  known rows; the pass still lands in the store for the next. Under the
 *  sidecar's `SyncDiverged` deadline. */
const STATUS_WAIT_MS = 8_000;
/** The project screen's count refreshes at most this often. */
export const MOBILE_SYNC_PROBE_MS = 30_000;
/** A diff's longest answer, in characters: more than a phone reads. */
export const MOBILE_DIFF_CAP = 256 * 1024;

const lastProbe = new Map<string, number>();

function statusOf(projectId: string): Record<string, SyncEntryStatus> | undefined {
  return useSyncStore.getState().byProject[projectId];
}

/** The status pass, bounded. */
async function freshStatus(projectId: string): Promise<Record<string, SyncEntryStatus>> {
  lastProbe.set(projectId, Date.now());
  const pass = useSyncStore.getState().refreshStatus(projectId);
  await Promise.race([pass, new Promise((resolve) => setTimeout(resolve, STATUS_WAIT_MS))]);
  return statusOf(projectId) ?? {};
}

/** The project screen's count: what the last pass found, no wait. A project
 *  the desktop has no status for gets one for the next answer. */
export function divergedCount(projectId: string | undefined, now = Date.now()): number | undefined {
  if (!projectId) return undefined;
  if (now - (lastProbe.get(projectId) ?? 0) >= MOBILE_SYNC_PROBE_MS) {
    lastProbe.set(projectId, now);
    void useSyncStore.getState().refreshStatus(projectId);
  }
  const status = statusOf(projectId);
  return status ? amberPaths(status).length + localNewPaths(status).length : undefined;
}

/** Whether the window reaches the host. The lamp alone will not do: it is
 *  forgotten when the desktop switches away from a project whose session stays
 *  up, and a pass that stat'd any file on the host has its own answer. */
function hostReached(projectId: string, status: Record<string, SyncEntryStatus>): boolean {
  return useRemoteStatusStore.getState().byProject[projectId]?.ssh === "connected"
    || Object.values(status).some((entry) => entry.hostChecked);
}

export async function divergedList(projectId: string) {
  const status = await freshStatus(projectId);
  const row = (state: MobileDivergedFile["state"]) => (rel: string): MobileDivergedFile => {
    const entry = status[rel];
    return {
      rel,
      state,
      host_mtime: entry.hostMtime,
      local_mtime: entry.localMtime,
      host_diverged: entry.hostDiverged,
      local_diverged: entry.localDiverged,
      host_checked: entry.hostChecked,
    };
  };
  return {
    status: "diverged" as const,
    connected: hostReached(projectId, status),
    files: [...amberPaths(status).map(row("amber")), ...localNewPaths(status).map(row("localnew"))],
  };
}

export async function divergedPreview(projectId: string, direction: SyncDirection, paths: string[]) {
  const status = statusOf(projectId);
  const preview = await invoke<SyncTransferPreview>("sync_transfer_preview", {
    projectId,
    relPath: "",
    direction,
    // Only a diverged file overwrites the other side's changes on purpose.
    force: paths.some((rel) => status?.[rel]?.state === "amber"),
    relPaths: paths,
  });
  const { destructiveTotal, ...facts } = preview;
  return { status: "sync_preview" as const, preview: { ...facts, destructive_total: destructiveTotal } };
}

/** Whether `op` still does what the phone's row offered. A list can be minutes
 *  old by the time its confirmation is answered, and the row's side may have
 *  changed since: a file both sides hold again must not lose its copy to a
 *  deletion asked about before. */
export function stillStands(op: MobileSyncOp, entry: SyncEntryStatus | undefined): boolean {
  if (!entry) return false;
  if (op === "push" && entry.state === "localnew") return true;
  if (entry.state !== "amber") return false;
  switch (op) {
    case "pull": return entry.hostMtime != null;
    case "push": return entry.localMtime != null;
    case "delete_host": return deleteSideOf(entry) === "host";
    case "delete_local": return deleteSideOf(entry) === "local";
    case "forget": return entry.hostMtime == null && entry.localMtime == null;
  }
}

export async function divergedResolve(projectId: string, op: MobileSyncOp, paths: string[]) {
  const status = await freshStatus(projectId);
  const standing = paths.filter((rel) => stillStands(op, status[rel]));
  const store = useSyncStore.getState();
  const outcomes: SyncResolveOutcome[] = [];
  const failure = (error: unknown): SyncResolveOutcome => ({ failed: standing.length, firstError: String(error) });
  if (standing.length > 0) {
    if (op === "pull") {
      outcomes.push(await store.resolveAll(projectId, standing, "host"));
    } else if (op === "push") {
      const fresh = standing.filter((rel) => status[rel]?.state === "localnew");
      const diverged = standing.filter((rel) => status[rel]?.state === "amber");
      if (diverged.length > 0) outcomes.push(await store.resolveAll(projectId, diverged, "local"));
      // A new file was never the host's: one that appeared there since is a
      // conflict for the list to show, not a file to overwrite.
      if (fresh.length > 0) outcomes.push(await store.resolveAll(projectId, fresh, "local", false));
    } else if (op === "forget") {
      outcomes.push(await store.markSelected(projectId, standing, false, false).then(() => ({ failed: 0, firstError: null }), failure));
    } else {
      outcomes.push(await store.applyDeleteAll(projectId, standing, op === "delete_host" ? "host" : "local"));
    }
  }
  const failed = outcomes.reduce((count, outcome) => count + outcome.failed, 0);
  for (const outcome of outcomes) {
    if (outcome.firstError) console.error(`mobile sync ${op}: ${outcome.firstError}`);
  }
  return {
    status: "sync_resolved" as const,
    done: standing.length - failed,
    failed,
    skipped: paths.length - standing.length,
  };
}

export async function divergedDiff(projectId: string, path: string) {
  const diff = await invoke<string>("sync_diff", { projectId, relPath: path });
  const cut = diff.length > MOBILE_DIFF_CAP;
  return { status: "sync_diff" as const, diff: cut ? diff.slice(0, MOBILE_DIFF_CAP) : diff, cut };
}

/** Tests only. */
export function resetMobileSyncProbes(): void {
  lastProbe.clear();
}
