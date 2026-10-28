// The file tree's remote side: which side it lists, the SSH-sync overlay and
// its actions, the pool gate, and the effects that keep the overlay fresh.
import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteStatusStore, type ConnState } from "../../stores/remote/remoteStatus";
import { useSyncStore, dirSyncAggregate } from "../../stores/remote/sync";
import { useSettingsStore } from "../../stores/settings";
import { projectIsOnHpc } from "../../lib/remote/hpc/hpcHost";
import { resolveLocalMirror, resolveProjectDirectory } from "../../types";
import { isHostPinned } from "../../lib/projectTabHost";
import type { FileEntry } from "../../lib/viewers/fileUtils";

/** What the tree knows about its project's remote side: the listing source, the
 * sync overlay and its actions, the pool state and the host's child names. */
export function useFileTreeRemote({
  projectId, syncSource,
}: {
  projectId: string | null;
  syncSource: "remote" | "local" | undefined;
}) {
  // Mount-free remote (Phase 2): a remote project lists over SFTP and has no
  // local inotify watcher, so we skip the fs-watch wiring and offer a manual
  // refresh control instead. Local projects keep live watch-driven updates.
  const isRemote = useProjectsStore(
    (s) => !!s.projects.find((p) => p.id === projectId)?.remote,
  );
  // The local mirror root for a remote project, resolved the same way
  // `ProjectFilesPane`/`ProjectFilesView` do (persisted override, else the default
  // `<state_dir>/mirror`). Used to build the mirror-side absolute path the
  // three-way merge viewer (`SyncMergeView`) opens a diverged file at — the ± diff
  // button below routes through it. Null for a local (non-remote) project.
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId));
  // A host-pinned project (a VM, or a remote project with no local copy —
  // `docs/remote_only_projects_plan.md`) has no mirror: no mirror root, no Local
  // side and no sync overlay, whatever source a caller passed.
  const hostPinned = isHostPinned(project);
  const mirrorRoot = useMemo(() => {
    if (!project?.remote || isHostPinned(project)) return null;
    return (
      resolveLocalMirror(project) ??
      `${resolveProjectDirectory(project).replace(/[/\\]+$/, "")}/mirror`
    );
  }, [project]);
  // SSH-sync Phase 1: the local mirror source (`syncSource === "local"`) is a
  // plain LOCAL tree even though its project is remote — it lists/watches the
  // local mirror dir and is never gated on the SSH pool. Only a remote-SOURCE
  // tree dispatches its listing over SFTP. `remoteListing` is the flag the
  // watch/refresh-bar/pool-gate logic below keys on.
  const treatLocal = syncSource === "local" && !hostPinned;
  const remoteListing = isRemote && !treatLocal;
  // Whether the rows carry the byte-sync overlay (slots, Sync to local / push,
  // auto-sync rows): the host listing or the local mirror of a project that
  // HAS a mirror. A pinned host listing is plain SFTP browsing.
  const syncTracked = (remoteListing || treatLocal) && !hostPinned;
  // SSH-sync overlay state for the remote source: per-path green/amber/none + the
  // in-flight transfer progress. Only consulted in the remote-source view.
  const syncStatus = useSyncStore((s) => (projectId ? s.byProject[projectId] : undefined));
  // Aggregated sync state for FOLDERS that have no manifest entry of their own.
  // The manifest tracks files (a directory only gets an entry when it is
  // explicitly folder-selected / folder-auto-synced); files pulled individually
  // leave every ancestor folder absent, so a folder row's own-path lookup
  // defaults to "none" and paints a red "push to host" button even when every
  // file inside it is green/in-sync. This rolls each tracked file's state up onto
  // all of its ancestor directories: `any` = the folder contains a tracked file,
  // `allGreen` = they are all green. A folder with its own entry still uses that
  // (handled at the lookup site); this only rescues the entry-less ones. Keyed by
  // project-relative directory path.
  const dirSyncAgg = useMemo(() => dirSyncAggregate(syncStatus), [syncStatus]);
  const syncProgress = useSyncStore((s) => (projectId ? s.progressByProject[projectId] : undefined));
  const refreshSyncStatus = useSyncStore((s) => s.refreshStatus);
  const syncPull = useSyncStore((s) => s.pull);
  const syncPush = useSyncStore((s) => s.push);
  const syncMarkSelected = useSyncStore((s) => s.markSelected);
  const syncSetAuto = useSyncStore((s) => s.setAuto);
  const syncAutoPreview = useSyncStore((s) => s.autoPreview);
  const syncSetExcluded = useSyncStore((s) => s.setExcluded);
  // A remote project's `list_dir`/`git_file_statuses` dispatch over SSH/SFTP on
  // the backend. Those are SYNCHRONOUS Tauri commands (they run on the main
  // thread), so calling them while the pooled connection is down blocks on the
  // dead SSH session and FREEZES the whole window. Gate every listing on the pool
  // being "connected": until then the tree shows a disconnected note instead of
  // issuing any remote call. Reconnect (header lamp / center placeholder) brings
  // the pool up, flips this true, and the load effect re-runs.
  const remoteSshState = useRemoteStatusStore((s) =>
    projectId ? s.byProject[projectId]?.ssh : undefined,
  );
  const remoteBlocked = remoteListing && remoteSshState !== "connected";
  // Whether this project's PRIMARY host is a tagged cluster login node — the host
  // that owns the files, and so the one every stat loop below walks. Gates the
  // periodic re-stat, not the explicit one: see the sync-status effect.
  const settingsForHpc = useSettingsStore((s) => s.settings);
  const primaryIsHpc = projectIsOnHpc(settingsForHpc, project);
  // Local-mirror view of a remote project: the NAMES of the browsed folder's
  // immediate children that exist on the host, from one SFTP readdir per
  // navigation (only while the pool is live — a host readdir is a main-thread
  // command that would freeze on a dead session, like every other remote call).
  // A local child folder absent from this set is local-only — it has never
  // reached the host — and the tree flags it so "Local" mode doesn't quietly
  // imply the whole mirror is on the remote. `null` = unknown (not this view, or
  // disconnected): flag nothing rather than guess.
  const [hostChildNames, setHostChildNames] = useState<Set<string> | null>(null);
  return { isRemote, project, hostPinned, mirrorRoot, treatLocal, remoteListing, syncTracked, syncStatus, dirSyncAgg, syncProgress, refreshSyncStatus, syncPull, syncPush, syncMarkSelected, syncSetAuto, syncAutoPreview, syncSetExcluded, remoteSshState, remoteBlocked, primaryIsHpc, hostChildNames, setHostChildNames };
}

/** Keeps the sync overlay fresh (on re-list, focus and a light tick) and probes
 * the host for the mirror view's local-only folders. */
export function useFileTreeSyncStatus({
  isRemote, projectId, remoteBlocked, relPath, active, refreshSyncStatus, remoteSshState,
  primaryIsHpc, fastMode, treatLocal, remoteProbeDir, setHostChildNames,
}: {
  isRemote: boolean;
  projectId: string | null;
  remoteBlocked: boolean;
  relPath: string;
  active: boolean;
  refreshSyncStatus: (projectId: string) => Promise<void>;
  remoteSshState: ConnState | undefined;
  primaryIsHpc: boolean;
  fastMode: boolean;
  treatLocal: boolean;
  remoteProbeDir: string | null | undefined;
  setHostChildNames: Dispatch<SetStateAction<Set<string> | null>>;
}) {
  // SSH-sync Phase 1: keep the sync overlay fresh — re-stat selected files
  // whenever the tree (re)lists. Runs for both the remote-source tree and the
  // local-mirror tree (the marker is symmetric); `remoteBlocked` only ever gates
  // the remote-source case; the mirror tree keeps working offline off the last-
  // known manifest state (the backend falls back gracefully when the pool is
  // down — see `sync_status`).
  useEffect(() => {
    // `active` doubles as the reactivation catch-up: a hidden tree skips the
    // refresh, and the flip back to visible re-runs this with fresh sync state.
    if (isRemote && projectId && !remoteBlocked && active) {
      void refreshSyncStatus(projectId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRemote, projectId, remoteBlocked, relPath, active]);

  // SSH-sync: the host tree has no change watcher (inotify can't see the SFTP
  // tree), so a remote-side edit wouldn't flip a file to amber until the user
  // re-lists — and the local-mirror view has no re-list button at all. Re-stat
  // the SELECTED files (cheap metadata over the pooled ControlMaster — NOT a
  // tree re-list) whenever Tabtivity regains focus and on a light interval, so a
  // remote-only divergence surfaces on its own shortly after it happens instead
  // of silently going stale. Gated on a live pool so a cold connection never
  // re-stats (which would report stale green); runs for both the remote-source
  // and local-mirror views (the amber marker is symmetric).
  useEffect(() => {
    // Hidden trees re-stat nothing: the sync markers they'd refresh aren't on
    // screen, and the mount-refresh effect above catches up on reactivation.
    if (!isRemote || !projectId || remoteSshState !== "connected" || !active) return;
    const refresh = () => { void refreshSyncStatus(projectId); };
    window.addEventListener("focus", refresh);
    // The 15 s tick is the third periodic walk of a host tree, after the 25 s
    // byte-sync pass and the 12 s lockstep poll — both of which the HPC tag
    // already stops for exactly the reason `lib/remote/hpc/hpcHost.ts` gives ("the same walk,
    // unasked for, forever"). A tagged login node gets no timer here either: an
    // open file tree is not a standing request to stat a cluster every quarter
    // minute. What survives is the focus listener and every explicit re-list —
    // both are gestures, and the amber marker still refreshes on each of them.
    // Fast mode drops this tick for the HPC tag's reason applied to a preference
    // rather than a host: an open file tree is not a standing request to stat a
    // host every quarter minute. The focus listener above and every explicit
    // re-list survive, so the markers still catch up on a gesture.
    const id = primaryIsHpc || fastMode
      ? undefined
      : window.setInterval(() => {
          // Only tick while Tabtivity is focused: a backgrounded window doesn't need
          // to keep re-stat'ing the host every 15 s (the `focus` listener re-stats
          // on return anyway), which keeps an idle remote project off the wire.
          if (document.hasFocus()) refresh();
        }, 15000);
    return () => {
      window.removeEventListener("focus", refresh);
      if (id !== undefined) window.clearInterval(id);
    };
  }, [isRemote, projectId, remoteSshState, refreshSyncStatus, primaryIsHpc, active, fastMode]);

  // Local-mirror view: readdir the HOST for the browsed folder so folders that
  // live only in the local mirror can be flagged (see `hostChildNames`). One
  // cheap SFTP readdir per navigation, gated on a live pool. If the folder ITSELF
  // isn't on the host (readdir fails), every local child here is off-host too, so
  // an empty set is the right answer — it flags them all.
  useEffect(() => {
    // `!active`: a hidden tree probes no host; the flags fall back to "unknown"
    // (no markers) and the reactivation re-run re-probes.
    if (!treatLocal || !isRemote || !remoteProbeDir || remoteSshState !== "connected" || !active) {
      setHostChildNames(null);
      return;
    }
    let cancelled = false;
    const target = relPath;
    invoke<FileEntry[]>("list_dir", { projectDir: remoteProbeDir, relPath: target })
      .then((entries) => {
        if (!cancelled) setHostChildNames(new Set(entries.map((x) => x.name)));
      })
      .catch(() => {
        if (!cancelled) setHostChildNames(new Set());
      });
    return () => {
      cancelled = true;
    };
    // `setHostChildNames` is a state setter, passed in: stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treatLocal, isRemote, remoteProbeDir, remoteSshState, relPath, active]);
}
