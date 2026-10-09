import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";

/**
 * SSH-sync Phase 1 — frontend cache of each remote project's sync manifest plus a
 * subscription to the backend `sync-progress` stream. The remote file view reads
 * `byProject[projectId][relPath]` to overlay green/amber beside the git marker and
 * to drive the "sync this / stop syncing" affordance; `progressByProject` drives
 * the in-flight transfer indicator. The backend (`commands::sync`) is the source
 * of truth — every action here calls it, then refreshes the cached status.
 * Plan: docs/ssh_sync_plan.md.
 */

/** `localnew` = exists in the local mirror but was never synced (no manifest
 *  entry): a NEW local file the host doesn't have yet, offered for upload.
 *  Reported by the backend's `sync_status` new-local-file pass. */
export type SyncFileState = "green" | "amber" | "none" | "localnew";

/** One status row as returned by the `sync_status` command. */
interface SyncStatusEntry {
  rel_path: string;
  is_dir: boolean;
  selected: boolean;
  state: SyncFileState;
  /** Effective auto-sync (own entry or an ancestor auto folder marker). */
  auto_sync: boolean;
  /** This path's OWN byte-sync exclusion marker (not an inherited one). */
  excluded: boolean;
  /** Current host modification time, when the sync-status probe reported one. */
  host_mtime: number | null;
  /** Current local-mirror modification time, when known. */
  local_mtime: number | null;
  /** Host side moved from its recorded base (optional — older backend tolerated). */
  host_diverged?: boolean;
  /** Local mirror moved from its recorded base (optional — older backend tolerated). */
  local_diverged?: boolean;
  /** Whether this pass actually stat'd the host for this row and got an answer
   *  (optional — older backend tolerated). */
  host_checked?: boolean;
}

/** Payload of the backend `sync-progress` event. */
interface SyncProgress {
  project_id: string;
  /** "start" | "file" | "done" */
  phase: string;
  rel_path: string;
  done: number;
  total: number;
}

/** Cached per-path status (the shape consumers read). */
export interface SyncEntryStatus {
  state: SyncFileState;
  selected: boolean;
  isDir: boolean;
  /** Whether this path auto-syncs (own flag or an ancestor auto folder). */
  auto: boolean;
  /** Carries its own "excluded from byte-sync" marker (giant-folder prompt or
   *  the tree's own Exclude item). Inherited exclusion is the backend's to
   *  resolve; this is what flips the menu item's label. */
  excluded: boolean;
  /** Current host modification time, for the diverged-files list. */
  hostMtime: number | null;
  /** Current local-mirror modification time, for the diverged-files list. */
  localMtime: number | null;
  /** Which side moved from its recorded base — the backend's clock-skew-safe
   *  direction; only meaningful on amber rows. */
  hostDiverged: boolean;
  /** Local twin of `hostDiverged` — the mirror moved from its recorded base. */
  localDiverged: boolean;
  /** Whether the status pass actually consulted the host for this row (false on
   *  a cold pool or an errored stat) — what keeps "gone on both sides" from
   *  being asserted about a host nobody asked. */
  hostChecked: boolean;
}

/** One side (local mirror or host) of a tracked file, from `sync_file_meta`. */
export interface SyncSideMeta {
  exists: boolean;
  size: number;
  /** Unix seconds, or null when the side reports none. */
  mtime: number | null;
}

/** Local + host metadata for a tracked file (backs the amber resolve popup). */
export interface SyncFileMeta {
  rel_path: string;
  local: SyncSideMeta;
  host: SyncSideMeta;
  base_size: number;
  base_mtime: number | null;
}

/** Size of the host subtree an auto-sync toggle would put in scope
 *  (`sync_auto_preview`). Byte-sync ignores `.gitignore`, so this is what stands
 *  between a right-click and a multi-GB experiment tree landing in the mirror. */
export interface AutoSyncPreview {
  files: number;
  bytes: number;
}

/** One folder big enough to be worth asking about before the first sync pass
 *  (`sync_big_folders`), with what each side holds. A folder present on only one
 *  side reports zeros for the other — which is itself the useful answer. */
export interface BigFolderRow {
  rel: string;
  localFiles: number;
  localBytes: number;
  hostFiles: number;
  hostBytes: number;
  excluded: boolean;
}

/** The giant-folder census. `hostScanned` is false when the project was not
 *  connected — the rows then carry local numbers only and the caller re-runs
 *  once the pool comes up. */
export interface BigFolderScan {
  folders: BigFolderRow[];
  hostScanned: boolean;
  hostError: string | null;
}

/** Live transfer progress for a project (null when idle). */
export interface SyncProgressState {
  rel: string;
  done: number;
  total: number;
}

/**
 * What a local→remote push actually did — mirrors the backend `SyncPushResult`.
 *
 * All three outcomes are reported because a push has three of them and only one
 * is an `Err`: files written, files *skipped* because the host moved past the
 * recorded base (never clobbered), and files the transfer itself failed on. A
 * caller that reads only `pushed` cannot tell a clean 0-file push (nothing to
 * do) from a push where every single write was refused.
 */
export interface SyncPushResult {
  pushed: number;
  /** Host-diverged paths, skipped rather than overwritten (force=false only). */
  conflicts: string[];
  failed_total: number;
  /** Capped sample of the failed paths (the backend caps at 24). */
  failed: string[];
  /** The first failure's message — the actionable half of `failed_total`. */
  first_error: string | null;
  /** Files dropped by the exclusion filter before any transfer was attempted —
   *  what distinguishes "pushed nothing because nothing qualified" from
   *  "pushed everything". */
  skipped_excluded: number;
  /** Git-tracked files omitted because enabled lockstep carries them as commits. */
  skipped_tracked: number;
}

/** A host file a pull left on the host because it is over the 64 MiB cap. */
export interface SyncSkippedFile {
  /** Project-relative path. */
  rel: string;
  /** Host size in bytes. */
  size: number;
}

/**
 * What a pull did — mirrors the backend `PullOutcome`. Files over the cap used
 * to be skipped with nothing but a log line while the pull read as done; they
 * come back here (rsync and SFTP path alike) for the result line to name.
 */
export interface SyncPullOutcome {
  /** Files that landed in the mirror. */
  pulled: number;
  /** Files over the cap left on the host; empty when none. */
  skippedTooLarge: SyncSkippedFile[];
}

/** Read a pull result defensively: an older backend (or a test double) may
 *  answer with a bare count or nothing at all. */
function toPullOutcome(raw: unknown): SyncPullOutcome {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<SyncPullOutcome>;
  return {
    pulled: typeof r.pulled === "number" ? r.pulled : typeof raw === "number" ? raw : 0,
    skippedTooLarge: Array.isArray(r.skippedTooLarge) ? r.skippedTooLarge : [],
  };
}

interface SyncStore {
  /** projectId → (project-relative path → status). */
  byProject: Record<string, Record<string, SyncEntryStatus>>;
  /** projectId → in-flight transfer progress, or null when idle. */
  progressByProject: Record<string, SyncProgressState | null>;

  /** Re-stat the host for the project's selected files and refresh the cache. */
  refreshStatus: (projectId: string) => Promise<void>;
  /** Fetch local+host metadata for one file (backs the amber resolve popup). */
  fileMeta: (projectId: string, relPath: string) => Promise<SyncFileMeta>;
  /** Pull one file or a whole folder subtree into the mirror, then refresh. */
  pull: (projectId: string, relPath: string) => Promise<SyncPullOutcome>;
  /** Pull the whole project tree into the mirror. */
  syncWholeProject: (projectId: string) => Promise<SyncPullOutcome>;
  /** Push the whole local mirror to the host, skipping host-diverged (amber)
   *  files (force=false → conflicts are returned, not clobbered). */
  pushWholeProject: (projectId: string) => Promise<SyncPushResult>;
  /** Push a local mirror file/folder to the host. Blocks stale files (returned in
   *  `conflicts`) unless `force`; the caller prompts and re-calls per conflict. */
  push: (
    projectId: string,
    relPath: string,
    force?: boolean,
  ) => Promise<SyncPushResult>;
  /** Propagate a one-sided deletion of a tracked file to the other side:
   *  `"host"` applies a local deletion to the host (deletes the host copy),
   *  `"local"` accepts a host deletion into the mirror (deletes the mirror copy).
   *  The backend re-verifies the premise against live state (the deleted side
   *  must be positively absent) and prunes the manifest entry, so the row leaves
   *  the orange list on the refresh this triggers. */
  applyDelete: (
    projectId: string,
    relPath: string,
    side: "host" | "local",
  ) => Promise<void>;
  /** Resolve a batch of diverged files by taking one side for every path at once:
   *  "host" pulls each (host overwrites the mirror), "local" force-pushes each
   *  (the mirror overwrites the host). Refreshes the status once at the end rather
   *  than per file. Backs the orange view's "…for all" buttons. Resolves to the
   *  files over the cap a "host" batch left on the host (gap 35), for the view
   *  to name; empty for "local". */
  resolveAll: (
    projectId: string,
    relPaths: string[],
    side: "host" | "local",
  ) => Promise<SyncSkippedFile[]>;
  /** Toggle the selected flag for paths without transferring (deselect = stop). */
  markSelected: (
    projectId: string,
    relPaths: string[],
    selected: boolean,
    isDir: boolean,
  ) => Promise<void>;
  /** Toggle auto-sync for paths (on a folder = its whole subtree). Turning on
   *  implies selected; the backend engine reconciles on its next pass. */
  setAuto: (
    projectId: string,
    relPaths: string[],
    auto: boolean,
    isDir: boolean,
  ) => Promise<void>;
  /** What auto-syncing `relPath` would start pulling from the host. Read-only —
   *  the caller confirms a large answer before committing to `setAuto`. */
  autoPreview: (projectId: string, relPath: string) => Promise<AutoSyncPreview>;
  /** Census the folders too big to sync silently, on BOTH sides (mirror + host).
   *  Read-only; the host half is skipped when the project isn't connected.
   *
   *  `scanHost` (default true) is what a **careful** host turns off: the host half
   *  is a recursive `du -ak -x`, which on a cluster runs against a parallel
   *  filesystem's metadata server. Passing false keeps the local walk and skips
   *  the host entirely, leaving `hostScanned` false. See `lib/remote/carefulHost.ts`. */
  /** `confirmed` carries "the user asked for this machine by name" past the HPC
   *  tag's refusal of the host `du` half — see `commands::sync::sync_big_folders`.
   *  It is only ever `true` on the explicit button, never on the automatic pass. */
  bigFolders: (
    projectId: string,
    scanHost?: boolean,
    confirmed?: boolean,
  ) => Promise<BigFolderScan>;
  /** Record (or lift) an explicit byte-sync exclusion for folders. Stronger than
   *  `setAuto(false)`: the whole-project pull and push skip an excluded tree too.
   *  Never deletes — mirror bytes already present stay put. */
  setExcluded: (
    projectId: string,
    relPaths: string[],
    excluded: boolean,
  ) => Promise<void>;
}

/**
 * Fold a marker write that the backend has already accepted into the cached
 * status, without waiting for `sync_status`.
 *
 * The markers (`excluded`, `auto`) are pure manifest state — the backend decided
 * them the moment `sync_set_excluded` / `sync_set_auto` returned, and no host
 * round-trip can change the answer. `sync_status`, on the other hand, re-stats
 * every selected FILE over the pooled SFTP session, so a marker whose only path
 * onto the screen is that refresh is invisible for as long as the re-stat takes:
 * seconds on a large manifest, and effectively unbounded while a push holds the
 * same session (`PUSH_FILE_TIMEOUT` is 120 s *per file*). That is what made
 * "Exclude from sync" look like a menu item that does nothing — the exclusion was
 * written and honoured, but the row kept its ⇄ push button until the refresh that
 * was queued behind a transfer finally landed.
 *
 * So the marker is applied here and the refresh still runs behind it, correcting
 * anything else that moved. A path with no row yet gets one: the marker IS the
 * reason it is now interesting, and an absent row reads as "not excluded".
 */
function patchMarkers(
  byPath: Record<string, SyncEntryStatus> | undefined,
  relPaths: string[],
  patch: Partial<SyncEntryStatus>,
  isDir: boolean,
): Record<string, SyncEntryStatus> {
  const out = { ...(byPath ?? {}) };
  for (const rel of relPaths) {
    const prev = out[rel];
    out[rel] = {
      state: prev?.state ?? "none",
      selected: prev?.selected ?? false,
      isDir: prev?.isDir ?? isDir,
      auto: prev?.auto ?? false,
      excluded: prev?.excluded ?? false,
      hostMtime: prev?.hostMtime ?? null,
      localMtime: prev?.localMtime ?? null,
      hostDiverged: prev?.hostDiverged ?? false,
      localDiverged: prev?.localDiverged ?? false,
      hostChecked: prev?.hostChecked ?? false,
      ...patch,
    };
  }
  return out;
}

function indexStatus(rows: SyncStatusEntry[]): Record<string, SyncEntryStatus> {
  const out: Record<string, SyncEntryStatus> = {};
  for (const r of rows) {
    out[r.rel_path] = {
      state: r.state,
      selected: r.selected,
      isDir: r.is_dir,
      auto: r.auto_sync,
      excluded: r.excluded,
      hostMtime: r.host_mtime,
      localMtime: r.local_mtime,
      hostDiverged: r.host_diverged ?? false,
      localDiverged: r.local_diverged ?? false,
      hostChecked: r.host_checked ?? false,
    };
  }
  return out;
}

/** Roll tracked FILE states up onto ancestor directories. Rows whose state is
 *  "none" (unselected / untracked / excluded) do NOT vote: they used to pin
 *  `allGreen` false forever, leaving a folder's push button red after a
 *  successful push. `any` = the folder contains a TRACKED file (green/amber);
 *  `allGreen` = all tracked descendants are green.
 *
 *  A NEW local-only file (`localnew`) rolls up as its own bit, `anyNew`,
 *  rather than voting against `allGreen`: a folder holding one wants the
 *  actionable ⬆ upload affordance, not the inert "diverged" ± that an amber
 *  vote would draw — and in the REMOTE tree an ancestor folder is the only
 *  place the new file can surface at all (the host readdir doesn't list it,
 *  so it has no row of its own there). It does NOT set `any` either, so a
 *  folder with ONLY new files keeps `any: false` → state "none" → the red
 *  push button, exactly what it showed before this state existed.
 *
 *  The **root** ("") is rolled up like any other ancestor. It has no row in the
 *  tree, so this used to stop one level short of it — which left the one folder
 *  every project has, and the one the file view opens on, with no state to show
 *  and therefore no pull/push control (the tree head's folder-level slot reads
 *  this key). A file at the top level contributes to "" and to nothing else. */
export function dirSyncAggregate(
  byPath: Record<string, SyncEntryStatus> | undefined,
): Record<string, { any: boolean; allGreen: boolean; anyNew: boolean }> {
  const agg: Record<string, { any: boolean; allGreen: boolean; anyNew: boolean }> = {};
  if (!byPath) return agg;
  for (const [p, s] of Object.entries(byPath)) {
    if (s.isDir) continue; // dir entries are authoritative on their own row
    if (s.state === "none") continue;
    const parts = p.split("/");
    for (let i = 0; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      const cur = agg[dir] ?? { any: false, allGreen: true, anyNew: false };
      if (s.state === "localnew") {
        cur.anyNew = true;
      } else {
        cur.any = true;
        if (s.state !== "green") cur.allGreen = false;
      }
      agg[dir] = cur;
    }
  }
  return agg;
}

/**
 * All project-relative paths currently diverged (amber/orange) for a project,
 * from the cached status. Backs the side-panel "orange files" list and the
 * toolbar count badge. Reads the passed-in map so callers subscribe to it.
 */
export function amberPaths(
  byPath: Record<string, SyncEntryStatus> | undefined,
): string[] {
  if (!byPath) return [];
  return Object.entries(byPath)
    .filter(([, s]) => s.state === "amber")
    .map(([rel]) => rel)
    .sort();
}

/**
 * All NEW local-only paths (state `localnew`) — files the mirror holds that
 * were never synced, so the host has no copy. Deliberately a separate list
 * from `amberPaths`: an amber row has content on BOTH sides (merge / pick a
 * winner), a new row has one side only (upload or ignore), and mixing them
 * would offer merge/take-remote actions that have nothing to act on.
 */
export function localNewPaths(
  byPath: Record<string, SyncEntryStatus> | undefined,
): string[] {
  if (!byPath) return [];
  return Object.entries(byPath)
    .filter(([, s]) => s.state === "localnew")
    .map(([rel]) => rel)
    .sort();
}

/**
 * Effective (own-marker-OR-inherited) byte-sync exclusion for `rel`, mirroring
 * the backend's `remote_sync::is_excluded(manifest, rel, "")` nearest-marker
 * walk: `rel`'s own entry, then each ancestor DIRECTORY entry, root last. The
 * first entry with its own `excluded` wins; a nearer `auto` re-includes a path
 * inside an excluded ancestor tree. Root ("") is never itself consulted here
 * (mirrors the backend's `under === ""` skip), only used as the walk's floor.
 * Cheap to call per row — `byPath` already holds every manifest entry the tree
 * needs (no extra fetch), same map `amberPaths`/the per-row sync slot read.
 */
export function isPathExcluded(
  byPath: Record<string, SyncEntryStatus> | undefined,
  rel: string,
): boolean {
  if (!byPath) return false;
  let cur = rel;
  for (;;) {
    if (cur !== "") {
      const e = byPath[cur];
      if (e && (e.isDir || cur === rel)) {
        if (e.excluded) return true;
        if (e.auto) return false;
      }
    }
    const idx = cur.lastIndexOf("/");
    if (idx >= 0) cur = cur.slice(0, idx);
    else if (cur !== "") cur = "";
    else return false;
  }
}

export const useSyncStore = create<SyncStore>((set, get) => ({
  byProject: {},
  progressByProject: {},

  refreshStatus: async (projectId) => {
    try {
      const rows = await invoke<SyncStatusEntry[]>("sync_status", { projectId });
      set((s) => ({
        byProject: { ...s.byProject, [projectId]: indexStatus(rows) },
      }));
    } catch (e) {
      // A disconnected/local project just has no sync status — don't surface it.
      console.debug("sync_status failed", e);
    }
  },

  fileMeta: async (projectId, relPath) =>
    invoke<SyncFileMeta>("sync_file_meta", { projectId, relPath }),

  pull: async (projectId, relPath) => {
    const outcome = toPullOutcome(await invoke<unknown>("sync_pull", { projectId, relPath }));
    await get().refreshStatus(projectId);
    return outcome;
  },

  syncWholeProject: async (projectId) => {
    const outcome = toPullOutcome(await invoke<unknown>("sync_whole_project", { projectId }));
    await get().refreshStatus(projectId);
    return outcome;
  },

  // Whole-mirror push counterpart to `syncWholeProject`. Reuses `push` with an
  // empty rel (the whole mirror) and force=false, so host-diverged (amber) files
  // come back in `conflicts` and are never overwritten — the toolbar caller just
  // fires it and lets the tree overlay show what stayed orange.
  pushWholeProject: async (projectId) => get().push(projectId, "", false),

  push: async (projectId, relPath, force = false) => {
    const result = await invoke<SyncPushResult>("sync_push", {
      projectId,
      relPath,
      force,
    });
    await get().refreshStatus(projectId);
    return result;
  },

  applyDelete: async (projectId, relPath, side) => {
    await invoke("sync_apply_delete", { projectId, relPath, side });
    await get().refreshStatus(projectId);
  },

  resolveAll: async (projectId, relPaths, side) => {
    // Iterate per path (each side has its own single-file command) but refresh
    // the cached status only once at the end — refreshing per file would re-stat
    // the whole selection N times. A single failed file is logged and skipped so
    // one bad path doesn't abort the rest of the batch. A host copy over the
    // cap is not pulled; it is collected and returned rather than only logged.
    const skipped: SyncSkippedFile[] = [];
    for (const rel of relPaths) {
      try {
        if (side === "host") {
          const outcome = toPullOutcome(await invoke<unknown>("sync_pull", { projectId, relPath: rel }));
          skipped.push(...outcome.skippedTooLarge);
        } else {
          await invoke("sync_push", { projectId, relPath: rel, force: true });
        }
      } catch (e) {
        console.error(`resolveAll: ${side} failed for ${rel}`, e);
      }
    }
    await get().refreshStatus(projectId);
    return skipped;
  },

  markSelected: async (projectId, relPaths, selected, isDir) => {
    await invoke("sync_mark_selected", { projectId, relPaths, selected, isDir });
    await get().refreshStatus(projectId);
  },

  setAuto: async (projectId, relPaths, auto, isDir) => {
    await invoke("sync_set_auto", { projectId, relPaths, auto, isDir });
    // Mirror the backend's marker write: auto ON also lifts the path's own
    // exclusion (the two markers cannot coexist — an excluded entry stays
    // excluded whatever its auto flag says, so the backend clears it). OFF is a
    // carve-out, not an exclusion, and leaves `excluded` as it was.
    set((s) => ({
      byProject: {
        ...s.byProject,
        [projectId]: patchMarkers(
          s.byProject[projectId],
          relPaths,
          auto ? { auto, excluded: false } : { auto },
          isDir,
        ),
      },
    }));
    await get().refreshStatus(projectId);
  },

  autoPreview: async (projectId, relPath) =>
    invoke<AutoSyncPreview>("sync_auto_preview", { projectId, relPath }),

  bigFolders: async (projectId, scanHost = true, confirmed = false) =>
    invoke<BigFolderScan>("sync_big_folders", { projectId, scanHost, confirmed }),

  setExcluded: async (projectId, relPaths, excluded) => {
    await invoke("sync_set_excluded", { projectId, relPaths, excluded });
    // Mirror what the backend just wrote: `sync_set_excluded` marks every path a
    // directory, and an exclusion also clears auto-sync (an excluded folder must
    // not keep being hauled by the background engine). Lifting one restores
    // nothing — the backend doesn't either, `auto_off` stays set.
    set((s) => ({
      byProject: {
        ...s.byProject,
        [projectId]: patchMarkers(
          s.byProject[projectId],
          relPaths,
          excluded ? { excluded, auto: false } : { excluded },
          true,
        ),
      },
    }));
    await get().refreshStatus(projectId);
  },
}));

/** Payload of the backend `auto-sync` event (one per reconcile pass that moved
 *  files). We only need the project id to refresh; counts are informational. */
interface AutoSyncEvent {
  project_id: string;
  pulled: number;
  pushed: number;
  skipped_amber: number;
}

let progressUnlisten: Promise<() => void> | null = null;

/**
 * Subscribe to the backend `sync-progress` and `auto-sync` streams (idempotent —
 * registers once). `sync-progress` updates `progressByProject` as files transfer
 * and refreshes the cached status when a transfer completes; `auto-sync` refreshes
 * the cached status after a background reconcile pass so the tree/orange list stay
 * live. Call once at app startup.
 */
export function listenSyncProgress(): Promise<() => void> {
  if (progressUnlisten) return progressUnlisten;
  progressUnlisten = Promise.all([
    listen<SyncProgress>("sync-progress", (ev) => {
      const p = ev.payload;
      if (p.phase === "done") {
        useSyncStore.setState((s) => ({
          progressByProject: { ...s.progressByProject, [p.project_id]: null },
        }));
        void useSyncStore.getState().refreshStatus(p.project_id);
        return;
      }
      useSyncStore.setState((s) => ({
        progressByProject: {
          ...s.progressByProject,
          [p.project_id]: { rel: p.rel_path, done: p.done, total: p.total },
        },
      }));
    }),
    listen<AutoSyncEvent>("auto-sync", (ev) => {
      void useSyncStore.getState().refreshStatus(ev.payload.project_id);
    }),
  ]).then((unlisteners) => () => unlisteners.forEach((u) => u()));
  return progressUnlisten;
}
