// The file tree's rows: the listing split into sections and clipped to the row
// cap, and the stable objects every memoised row receives.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { type FileEntry, type SortKey, sortEntries, isHiddenByEnding, STANDARD_PROJECT_FILES } from "../../lib/viewers/fileUtils";
import { argsToLines } from "../../lib/terminal/runArgsFormat";
import type { GitStatusMap, MoveTargetAttrs, RowActions } from "./fileTreeTypes";
import type { useFileTreeRunState } from "./useFileTreeRun";

type FileTreeRunState = ReturnType<typeof useFileTreeRunState>;

// How many rows the tree renders at once, and how many more each click of the
// "show more" footer adds. The rows are not virtualized, so this is the bound on
// how much DOM one listing can build — see `rowCap` for why an unbounded listing
// is what makes a big folder freeze the window rather than merely load slowly.
// A page still overfills the tallest panel, so the cap is invisible in every
// ordinary folder and only engages where it is the difference between usable
// and not.
export const ROW_CAP_STEP = 100;

/** The listing split into its on-screen sections, clipped to the row cap, and the selection pruned to what still lists. */
export function useFileTreeRows({
  gitStatuses, entries, hiddenEndings, relPath, shownPaths, separateScaffold, separateGitignored,
  dirIgnoredBytes, dirSizes, sortKey, descending, projectId, scaffoldExpanded, gitignoredExpanded,
  hiddenExtExpanded, setSelected,
}: {
  gitStatuses: GitStatusMap;
  entries: FileEntry[];
  hiddenEndings: string[];
  relPath: string;
  shownPaths: string[];
  separateScaffold: boolean;
  separateGitignored: boolean;
  dirIgnoredBytes: Record<string, number>;
  dirSizes: Record<string, number>;
  sortKey: SortKey;
  descending: boolean;
  projectId: string | null;
  scaffoldExpanded: boolean;
  gitignoredExpanded: boolean;
  hiddenExtExpanded: boolean;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
}) {
  // Per-entry git status resolving the "whole directory is ignored" sentinel the
  // backend emits under the reserved key "." (git's porcelain never lists an empty
  // ignored subdir, so those children arrive absent from `gitStatuses`; without
  // this they'd fall out of the gitignored section — see git.rs `git_file_statuses`).
  // When the current folder is wholly ignored, every listed child defaults to
  // "ignored" unless it already carries an explicit status (a force-added tracked
  // file). Every consumer reads this, never the raw `gitStatuses`, so the tree, the
  // section split, and the hover card stay consistent.
  const displayStatuses = useMemo(() => {
    if (gitStatuses["."] !== "ignored") return gitStatuses;
    const m: GitStatusMap = {};
    for (const e of entries) m[e.name] = gitStatuses[e.name] ?? "ignored";
    return m;
  }, [gitStatuses, entries]);

  // The four on-screen sections in render order (regular, then the collapsible
  // scaffold + gitignored + hidden-by-extension groups). Shared by the
  // renderer and the selection click handler so a shift-range spans exactly
  // what the user sees. Mirrors the split the render body applies below.
  const sections = useMemo(() => {
    // Extension-hidden wins over both other splits — it's an explicit,
    // per-project user rule (ProjectFilesSettings), more specific than "is
    // this a scaffold file" or "does git ignore it".
    const notHiddenExt = entries.filter((e) => !isHiddenByEnding(e, hiddenEndings, relPath, shownPaths));
    const hiddenExt = entries.filter((e) => isHiddenByEnding(e, hiddenEndings, relPath, shownPaths));
    const isRoot = !relPath && separateScaffold;
    const nonStandard = isRoot ? notHiddenExt.filter((e) => !STANDARD_PROJECT_FILES.has(e.name)) : notHiddenExt;
    const standard = isRoot ? notHiddenExt.filter((e) => STANDARD_PROJECT_FILES.has(e.name)) : [];
    // The size breakdown is an independent ignored-path scan. If it establishes
    // that every byte in a folder is ignored, keep that folder out of the normal
    // section even when the status request was incomplete (for example an older
    // backend, or Git configured with status.showUntrackedFiles=no). Otherwise
    // the normal-row size subtracts the ignored bytes and misleadingly shows 0 B.
    const isIgnored = (e: FileEntry) =>
      displayStatuses[e.name] === "ignored" ||
      (e.is_dir &&
        (dirIgnoredBytes[e.path] ?? 0) > 0 &&
        dirSizes[e.path] !== undefined &&
        (dirIgnoredBytes[e.path] ?? 0) >= dirSizes[e.path]);
    // With the gitignored split off, ignored entries stay in the regular list
    // rather than moving to a section that is not rendered — the point of the
    // switch is to see them in place, not to hide them.
    const regular = separateGitignored ? nonStandard.filter((e) => !isIgnored(e)) : nonStandard;
    const gitignored = separateGitignored ? nonStandard.filter(isIgnored) : [];
    // The listing gives every folder size 0, so "Size" must sort on the figure
    // the row shows: the recursive walk, less its ignored bytes outside the
    // gitignored / hidden-by-extension groups (mirrors `dirShown` in
    // renderEntry). An unwalked or scan-excluded folder sorts last.
    const bySize = (list: FileEntry[], subtractIgnored: boolean) =>
      sortKey !== "size"
        ? list
        : sortEntries(list, "size", descending, (e) => {
            if (!e.is_dir) return e.size;
            const total = dirSizes[e.path];
            if (total === undefined) return undefined;
            return subtractIgnored ? total - (dirIgnoredBytes[e.path] ?? 0) : total;
          });
    return {
      regular: bySize(regular, true),
      standard: bySize(standard, true),
      gitignored: bySize(gitignored, false),
      hiddenExt: bySize(hiddenExt, false),
    };
  }, [
    entries,
    relPath,
    separateScaffold,
    separateGitignored,
    displayStatuses,
    dirSizes,
    dirIgnoredBytes,
    hiddenEndings,
    shownPaths,
    sortKey,
    descending,
  ]);

  // How many rows the tree will actually render, raised a page at a time by the
  // "show more" footer. Rows are NOT virtualized, and each one is ~16 elements
  // with ~11 handlers rebuilt on every render of this component — so a folder
  // holding thousands of files (an ML sweep's `results/` routinely does: one run
  // per config × per step) builds six figures of DOM and re-reconciles the lot
  // every time a size lands, a sync status refreshes, or the pointer moves. That
  // is enough to make the whole window unusable while the CPU still looks idle,
  // because the cost is layout/paint in a software-rendered webview, not compute.
  // Capping keeps the cost proportional to what is on screen; the folder is still
  // fully reachable, one page at a time.
  const [rowCap, setRowCap] = useState(ROW_CAP_STEP);
  // A new folder (or a new project) starts back at one page — the cap is about
  // this listing, not a preference to carry around the tree.
  useEffect(() => {
    setRowCap(ROW_CAP_STEP);
  }, [relPath, projectId]);

  // The rows actually rendered, in on-screen order, clipped to `rowCap` across
  // the sections as a whole (the budget is spent top-down, so raising the cap
  // extends the list rather than reshuffling it). Collapsed sections spend
  // nothing — they render no rows. Section *labels* keep counting the full
  // `sections` lists, so "gitignored (8316)" still tells the truth about the
  // folder while only a page of it is on screen.
  const rowWindow = useMemo(() => {
    let budget = rowCap;
    const clip = (list: FileEntry[]) => {
      const out = budget >= list.length ? list : list.slice(0, Math.max(0, budget));
      budget -= out.length;
      return out;
    };
    const regular = clip(sections.regular);
    const standard = scaffoldExpanded ? clip(sections.standard) : [];
    const gitignored = gitignoredExpanded ? clip(sections.gitignored) : [];
    const hiddenExt = hiddenExtExpanded ? clip(sections.hiddenExt) : [];
    const total =
      sections.regular.length +
      (scaffoldExpanded ? sections.standard.length : 0) +
      (gitignoredExpanded ? sections.gitignored.length : 0) +
      (hiddenExtExpanded ? sections.hiddenExt.length : 0);
    const shown = regular.length + standard.length + gitignored.length + hiddenExt.length;
    return { regular, standard, gitignored, hiddenExt, hidden: total - shown };
  }, [sections, rowCap, scaffoldExpanded, gitignoredExpanded, hiddenExtExpanded]);

  // Flat list of visible row paths in on-screen order — the axis a shift-range
  // spans. Collapsed sections contribute no rows (they aren't rendered), and
  // neither do rows beyond the cap: a range must span exactly what the user can
  // see, or shift-click would silently select rows that aren't on screen.
  const orderedVisible = useMemo(() => {
    const paths = rowWindow.regular.map((e) => e.path);
    paths.push(...rowWindow.standard.map((e) => e.path));
    paths.push(...rowWindow.gitignored.map((e) => e.path));
    paths.push(...rowWindow.hiddenExt.map((e) => e.path));
    return paths;
  }, [rowWindow]);

  // Prune selected paths that vanished from the listing (fs-watch removed a
  // file, a folder was deleted, etc.) so stale entries never linger in bulk ops.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(entries.map((e) => e.path));
      let changed = false;
      const next = new Set<string>();
      for (const p of prev) {
        if (live.has(p)) next.add(p);
        else changed = true;
      }
      return changed ? next : prev;
    });
    // `setSelected` is a state setter, passed in: stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);
  return { displayStatuses, sections, setRowCap, rowWindow, orderedVisible };
}

/** The two stable objects every row gets: its drop-target identity and its handler forwarders. */
export function useFileTreeRowActions({
  projectDir, remoteListing, handleRowClick, handleOpen, showEntryContextMenu, handleEntryDragStart,
  onEntryPointerDown, handleEntryMouseEnter, handleEntryMouseLeave, syncEntryToLocal,
  pushEntryToHost, openSyncMerge, runShellScript, runPythonScript, setArgsPopover, runArgsByPath,
}: {
  projectDir: string;
  remoteListing: boolean;
  handleRowClick: RowActions["click"];
  handleOpen: RowActions["open"];
  showEntryContextMenu: RowActions["contextMenu"];
  handleEntryDragStart: RowActions["dragStart"];
  onEntryPointerDown: RowActions["pointerDown"];
  handleEntryMouseEnter: RowActions["mouseEnter"];
  handleEntryMouseLeave: RowActions["mouseLeave"];
  syncEntryToLocal: (entry: FileEntry) => Promise<void>;
  pushEntryToHost: (entry: FileEntry) => Promise<void>;
  openSyncMerge: RowActions["openSyncMerge"];
  runShellScript: RowActions["runShell"];
  runPythonScript: RowActions["runPython"];
  setArgsPopover: FileTreeRunState["setArgsPopover"];
  runArgsByPath: Record<string, string>;
}) {
  // Identity stamped on every `data-move-rel` drop target, so a drag that
  // started in a DIFFERENT tree (box member roots, another project's Files tab)
  // knows which root — and which side, local or remote — a drop here lands in.
  // Every `data-move-rel` site must spread this; `FileMove.test.ts` enforces it.
  const moveTargetAttrs = useMemo<MoveTargetAttrs>(
    () => ({
      "data-move-root": projectDir,
      "data-move-remote": remoteListing ? "1" : undefined,
    }),
    [projectDir, remoteListing],
  );

  // The one stable handler object every row gets (see `RowActions`). The
  // tree's closures are rebuilt each render; the forwarders read the latest
  // set, refreshed after every commit, so the rows' memo holds.
  const latestRows = useRef<RowActions | null>(null);
  useLayoutEffect(() => {
    latestRows.current = {
      click: handleRowClick,
      open: handleOpen,
      contextMenu: showEntryContextMenu,
      dragStart: handleEntryDragStart,
      pointerDown: onEntryPointerDown,
      mouseEnter: handleEntryMouseEnter,
      mouseLeave: handleEntryMouseLeave,
      syncToLocal: (entry) => void syncEntryToLocal(entry),
      pushToHost: (entry) => void pushEntryToHost(entry),
      openSyncMerge,
      runShell: runShellScript,
      runPython: runPythonScript,
      openRunArgs: (ev, entry) =>
        setArgsPopover({
          entry,
          x: ev.clientX,
          y: ev.clientY,
          draft: argsToLines(runArgsByPath[entry.path] ?? ""),
        }),
    };
  });
  const rowActions = useMemo<RowActions>(
    () => ({
      click: (ev, entry) => latestRows.current?.click(ev, entry),
      open: (entry, ev) => latestRows.current?.open(entry, ev),
      contextMenu: (ev, entry) => latestRows.current?.contextMenu(ev, entry),
      dragStart: (ev, entry) => latestRows.current?.dragStart(ev, entry),
      pointerDown: (ev, entry, dragTarget) => latestRows.current?.pointerDown(ev, entry, dragTarget),
      mouseEnter: (ev, entry) => latestRows.current?.mouseEnter(ev, entry),
      mouseLeave: () => latestRows.current?.mouseLeave(),
      syncToLocal: (entry) => latestRows.current?.syncToLocal(entry),
      pushToHost: (entry) => latestRows.current?.pushToHost(entry),
      openSyncMerge: (entry) => latestRows.current?.openSyncMerge(entry),
      runShell: (ev, entry) => latestRows.current?.runShell(ev, entry),
      runPython: (ev, entry) => latestRows.current?.runPython(ev, entry),
      openRunArgs: (ev, entry) => latestRows.current?.openRunArgs(ev, entry),
    }),
    [],
  );
  return { moveTargetAttrs, rowActions };
}
