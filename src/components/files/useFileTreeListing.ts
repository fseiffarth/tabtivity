// The file tree's listing: its state, the mount load with the snapshot the
// next mount seeds from, and the fs-watch re-list. `FileTree` calls these at
// the points its own hooks always ran, so the hook order is unchanged.
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { subscribeTauri } from "../../hooks/useTauriListener";
import type { FileEntry } from "../../lib/viewers/fileUtils";
import { fileTreeSnapshotKey, readFileTreeSnapshot, writeFileTreeSnapshot } from "../../lib/projects/fileViewSnapshots";
import { useFastMode } from "../../lib/agents/fastMode";
import { normalizeScanPath } from "./ProjectFilesSettings";
import type { GitStatusMap } from "./fileTreeTypes";

/** The listing's own state: the mount seed, the rows, folder sizes, the scan exclusions, the folder on screen, the selection and the load status. */
export function useFileTreeListingState({
  projectId, projectDir, initialRelPath, scanExcluded,
}: {
  projectId: string | null;
  projectDir: string;
  initialRelPath: string | null;
  scanExcluded: string[] | undefined;
}) {
  // The tree is unmounted, not hidden, whenever the side panel closes
  // (`mountTree={open}`) or the panels are toggled away — so a reveal used to
  // start from an empty tree and fill itself in over a listing, a git-status
  // round trip and one recursive walk per folder. `mountSeed` is the last state
  // this (project, root, folder) was left in: every piece of it below is seeded
  // from it so the FIRST frame after a reveal is already populated, and the
  // mount effect then upgrades it with a quiet, diffing refresh. Read once (a
  // lazy initializer), so a re-render never re-seeds over live state.
  const [mountSeed] = useState(() =>
    readFileTreeSnapshot(fileTreeSnapshotKey(projectId, projectDir, initialRelPath ?? "")),
  );
  // Consumed by the mount effect: the seeded first pass refreshes instead of
  // re-listing from scratch. A later run of that effect (a remote pool coming
  // up) is a real load, so the flag only ever fires once.
  const seedPending = useRef(!!mountSeed);
  const snapshotKeyFor = useCallback(
    (rel: string) => fileTreeSnapshotKey(projectId, projectDir, rel),
    [projectId, projectDir],
  );
  const [rawEntries, setRawEntries] = useState<FileEntry[]>(() => mountSeed?.entries ?? []);
  // Recursive folder sizes (bytes), keyed by absolute folder path. Filled in
  // lazily by a per-folder backend call so a big subtree never blocks the
  // listing — the tree renders immediately and each folder's size appears
  // once it resolves. `requestedSizes` guards against re-dispatching the same
  // folder while it's in flight (or after it failed), so fs-watch churn doesn't
  // trigger a request storm; both reset in `load()` (navigation / refresh) so a
  // re-listed folder recomputes. Shared between the two size-fetch effects
  // below (plain `dir_size` for the gitignored section, `dir_size_breakdown`
  // for everything else) so the same folder is never fetched by both — besides
  // being wasted work, two independent walks of the same folder can disagree
  // if it's being actively written to, which would make the ignored split
  // exceed the total from the other call.
  // Fast mode withdraws every recursive size walk below (and with it the row
  // figures and the group totals summed from them). Reactive, so turning it
  // off re-runs the effects and prices the folders on screen — the dedupe set
  // was never filled while it was on, so nothing is skipped.
  const fastMode = useFastMode();
  const [dirSizes, setDirSizes] = useState<Record<string, number>>(() => mountSeed?.dirSizes ?? {});
  const requestedSizes = useRef<Set<string>>(new Set());
  // Which listing the in-flight size calls belong to. Bumped by `load()`, the
  // only thing that invalidates the cache — so a result is stale ONLY if the
  // folder was re-listed under it, never merely because the tree re-rendered.
  // This is load-bearing: the effects below key on `sections`, whose identity
  // changes on any re-render (`load()` itself sets rawEntries and THEN, a
  // round-trip later, gitStatuses), and cancelling on that would drop every
  // size call still in flight — permanently, since `requestedSizes` keeps it
  // from being re-dispatched. Small folders resolved inside the gap and showed
  // a size; a big one (the whole point of the feature) never did.
  const sizeGeneration = useRef(0);
  // Scan exclusions, normalised once per change into the one spelling the backend
  // matches on. `scanExcludedList` is what the walk commands receive (it prunes
  // excluded subtrees *nested inside* a folder being sized); `isScanExcluded`
  // additionally stops us dispatching a walk for an excluded folder at all.
  const scanExcludedList = useMemo(
    () => (scanExcluded ?? []).map(normalizeScanPath).filter(Boolean),
    [scanExcluded],
  );
  const scanExcludedSet = useMemo(() => new Set(scanExcludedList), [scanExcludedList]);
  const isScanExcluded = useCallback(
    (rel: string) => scanExcludedSet.has(normalizeScanPath(rel)),
    [scanExcludedSet],
  );
  // The rel path of the most recent `load` call — the folder the tree is
  // committed to showing. Every async listing/status result checks itself
  // against it before touching state, so a `refresh` of folder A that lands
  // after the user has moved on to B can't paint A's rows or A's git letters
  // under B's breadcrumb (the seeded `load` puts B on screen at once, so a slow
  // A result used to visibly flash in over it). Seeded from the saved folder
  // for the same reason `relPath` is: the seeded mount's refresh must pass.
  const loadTargetRef = useRef<string>(initialRelPath ?? "");
  // Bytes of a folder's recursive size that are git-ignored, for folders that
  // are NOT themselves ignored (they sit in the regular/standard section) but
  // contain ignored content — e.g. a source folder with a build output dir
  // inside. Filled from the same `dir_size_breakdown` call that fills
  // `dirSizes` for these folders (one walk, both numbers), so the split can
  // never exceed the total it was measured against. A folder with no ignored
  // content is simply absent from this map (nothing to annotate).
  const [dirIgnoredBytes, setDirIgnoredBytes] = useState<Record<string, number>>(
    () => mountSeed?.dirIgnoredBytes ?? {},
  );
  // Which files can be embedded as a frameless in-tab app (Group K #40). Keyed
  // by extension (default-app resolution is per-mime/extension), so we only
  // query the backend once per distinct extension. Only embeddable files get the
  // drag-to-tab affordance (3D hover + pointer drag); the rest open on dblclick.
  const [embedByExt, setEmbedByExt] = useState<Record<string, boolean>>({});
  // Seed from the saved folder (`initialRelPath`) rather than "" so a (re)mount
  // renders that folder immediately. Starting at "" made every remount paint the
  // ROOT for one frame — then the mount effect's async `load(initialRelPath)`
  // would snap back to the saved folder, so a remounting tree visibly flickered
  // "root ↔ current folder". Reading the prop lazily fixes that for all remount
  // causes; the mount effect below still runs and just fetches this folder's
  // listing (relPath is already correct, so there is no root frame).
  const [relPath, setRelPath] = useState(() => initialRelPath ?? "");
  // Multi-selection: a set of entry ABSOLUTE paths (`e.path`, the row key), plus
  // the range anchor. Click selects; shift-click extends a contiguous range;
  // ctrl/cmd-click toggles a row. Backs bulk delete/move/copy, drag-all, and
  // open-all. Cleared on folder navigation (in `load`) and pruned when the
  // listing changes (fs-watch removes a selected file).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchorRef = useRef<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // When a remote listing fails because the folder isn't on the host, this holds
  // the crumb index (into the path segments) of the FIRST segment that doesn't
  // exist on the host — everything from here on is local-only. null when the
  // whole path exists (the normal case) or the source is local. The breadcrumb
  // tints the on-host prefix and strikes through the local-only tail from it.
  const [missingCrumbDepth, setMissingCrumbDepth] = useState<number | null>(null);
  const [gitStatuses, setGitStatuses] = useState<GitStatusMap>(() => mountSeed?.gitStatuses ?? {});
  return { seedPending, snapshotKeyFor, rawEntries, setRawEntries, fastMode, dirSizes, setDirSizes, requestedSizes, sizeGeneration, scanExcludedList, isScanExcluded, loadTargetRef, dirIgnoredBytes, setDirIgnoredBytes, embedByExt, setEmbedByExt, relPath, setRelPath, selected, setSelected, anchorRef, loading, setLoading, error, setError, missingCrumbDepth, setMissingCrumbDepth, gitStatuses, setGitStatuses };
}

/** The mount load (a quiet refresh when seeded) and the snapshot the next mount seeds from. */
export function useFileTreeMountLoad({
  projectDir, remoteBlocked, initialRelPath, seedPending, load, refresh, error, snapshotKeyFor,
  relPath, rawEntries, gitStatuses, dirSizes, dirIgnoredBytes,
}: {
  projectDir: string;
  remoteBlocked: boolean;
  initialRelPath: string | null;
  seedPending: MutableRefObject<boolean>;
  load: (rel: string) => Promise<void>;
  refresh: (rel: string) => Promise<boolean>;
  error: string | null;
  snapshotKeyFor: (rel: string) => string;
  relPath: string;
  rawEntries: FileEntry[];
  gitStatuses: GitStatusMap;
  dirSizes: Record<string, number>;
  dirIgnoredBytes: Record<string, number>;
}) {
  useEffect(() => {
    if (!projectDir) return;
    // Don't list a disconnected remote project's tree — the sync list_dir/
    // git_file_statuses commands would block the main thread on the dead SSH pool
    // and freeze the app. Re-runs once the pool connects (remoteBlocked flips).
    if (remoteBlocked) return;
    const rel = initialRelPath ?? "";
    // Seeded mount (the panel was revealed again): the folder is already on
    // screen, so upgrade it in place with the quiet, diffing refresh instead of
    // re-listing from scratch — no loading flash, and nothing repaints where
    // nothing changed. If the folder no longer lists, fall through to the full
    // load so the error is shown rather than the stale rows.
    if (seedPending.current) {
      seedPending.current = false;
      // One frame later, not inside this commit: `list_dir`/`git_file_statuses`
      // are SYNCHRONOUS Tauri commands on the main thread (over SFTP for a
      // remote project), so dispatching them here would stall the very frame
      // the seed exists to make instant. The tree is already on screen; the
      // upgrade can wait for it to paint.
      let cancelled = false;
      const frame = requestAnimationFrame(() => {
        void refresh(rel).then((ok) => {
          if (!ok && !cancelled) void load(rel);
        });
      });
      return () => {
        cancelled = true;
        cancelAnimationFrame(frame);
      };
    }
    load(rel);
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectDir, remoteBlocked]);

  // Keep the folder's snapshot current so the NEXT mount (a panel reveal, a
  // `panelsHidden` toggle) paints it immediately. Written from the live state
  // rather than at the fetch sites so every source that moves the tree — the
  // listing, the fs-watch refresh, each folder size as it resolves — is
  // captured by construction. Skipped while an error is up: a failed listing is
  // not a state worth restoring, and `load` has already dropped that key.
  useEffect(() => {
    if (!projectDir || error) return;
    writeFileTreeSnapshot(snapshotKeyFor(relPath), {
      entries: rawEntries,
      gitStatuses,
      dirSizes,
      dirIgnoredBytes,
    });
  }, [projectDir, snapshotKeyFor, relPath, rawEntries, gitStatuses, dirSizes, dirIgnoredBytes, error]);
}

/** Watches the folder on screen while the tree is active, and catches up once on reactivation. */
export function useFileTreeFsWatch({
  projectDir, remoteListing, active, relPath, refresh,
}: {
  projectDir: string;
  remoteListing: boolean;
  active: boolean;
  relPath: string;
  refresh: (rel: string) => Promise<boolean>;
}) {
  // Live updates: watch the currently-displayed directory on the backend and
  // re-fetch when it changes, so files created/removed by terminals, agents, or
  // other processes appear without manual navigation. Re-points to the new
  // directory whenever relPath changes; tears down on unmount/panel close.
  //
  // Active surfaces only: trees stay mounted while hidden (background Files
  // tabs, backgrounded projects), and the fs-change listener ignores the event's
  // path — so every mounted tree used to re-list (list_dir + git_file_statuses)
  // on every event burst anywhere. A hidden tree now stops watching entirely and
  // catches up with ONE quiet re-list when its surface is next shown (the same
  // identity-preserving refresh an fs-change triggers, so nothing repaints when
  // nothing changed). React runs effect cleanups before setups across the tree,
  // so the deactivating tree's `unwatch_dir` lands before the activating tree's
  // `watch_dir` claims the single backend watch slot.
  const sawInactive = useRef(false);
  useEffect(() => {
    // Remote projects have no local fs watcher (inotify can't see the SFTP tree);
    // they refresh manually via the toolbar button. Skip the watch wiring. The
    // local mirror source IS a real local dir, so it keeps live watch updates.
    if (!projectDir || remoteListing) return;
    if (!active) {
      sawInactive.current = true;
      return;
    }
    if (sawInactive.current) {
      sawInactive.current = false;
      void refresh(relPath);
    }
    const absDir = relPath ? `${projectDir}/${relPath}` : projectDir;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // `repoDir` points the backend's `.git` watch at the project's repo, so
    // add/commit/push (which only write `.git/`) re-read the markers too.
    invoke("watch_dir", { path: absDir, repoDir: projectDir }).catch(() => {});
    const unlisten = subscribeTauri(() => listen<string>("fs-change", (event) => {
      // The payload is the watched folder as asked for (`fs_watch.rs`); the one
      // backend slot is shared by every tree in every window, so an event for
      // another tree's folder is not this tree's to re-list (perf plan §3.4).
      // Its `.git` changes arrive under the same payload, so they still count.
      if (typeof event?.payload === "string" && event.payload !== absDir) return;
      // Coalesce the burst of events a single write emits into one reload.
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => refresh(relPath), 250);
    }));

    return () => {
      if (timer) clearTimeout(timer);
      unlisten();
      invoke("unwatch_dir").catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectDir, relPath, remoteListing, active]);
}
