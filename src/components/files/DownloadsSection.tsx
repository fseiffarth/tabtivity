import React, { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { downloadDir } from "@tauri-apps/api/path";
import { useSettingsStore } from "../../stores/settings";
import { useWindowsStore } from "../../stores/windows";
import { useDragStore } from "../../stores/drag/drag";
import { bindDragRelease } from "../../lib/window/dragPlatform";
import { fmtModified, fmtSize, type FileEntry } from "../../lib/viewers/fileUtils";
import { useT, type TranslationKey } from "../../lib/i18n";
import { FileIcon } from "../common/icons/FileIcon";
import { ArrowRightIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon, CloseIcon, InboxIcon, RefreshIcon } from "../common/icons/Icon";
import { useResizableSection } from "./useResizableSection";
import { ErrorNote } from "../common/ErrorNote";
import { UntestedTag } from "../common/UntestedTag";
import { BRAND } from "../../lib/brand";
import { isServerClient } from "../../lib/transport/linkState";

/**
 * The side-panel Downloads section (fast-copy of freshly downloaded files into a
 * project). Rendered directly BELOW the project file tree, so the source
 * (downloads) and destination (the tree above) are co-visible: a download can be
 * dragged straight onto a folder row in the tree — the same `[data-move-rel]`
 * drop targets FileTree's own drag-to-move uses — or copied into the currently
 * browsed folder with the per-row `→` button.
 *
 * It scans the machine-wide `download_sources` setting (default: the OS Downloads
 * dir), read-only — Tabtivity never changes any browser's download path. The backend
 * `list_recent_downloads` command merges + recency-filters the folders; copying
 * reuses `import_external_file` (collision-safe). Local projects only: for a
 * remote project `import_external_file` can't reach the remote tree, so copy is
 * disabled (listing/preview still work).
 */
interface DownloadsSectionProps {
  /** Absolute project directory (the copy destination root). */
  projectDir: string;
  /** Active project id, for the preview-open origin. */
  projectId: string | null;
  /** Project-relative folder the tree is currently browsed into — the default
   *  copy target for the `→` button. Empty = project root. */
  targetFolder: string;
  /** Remote project → copy is disabled (import_external_file is local-only). */
  isRemote: boolean;
  /** Hide the section (flips the toolbar toggle off). */
  onClose: () => void;
}

interface TimeWindow {
  label: string;
  /** Age cutoff in seconds; null = no filter (all). */
  secs: number | null;
  /** The collapsed line's "nothing here" sentence for this window. */
  none: TranslationKey;
}

const WINDOWS: TimeWindow[] = [
  { label: "1h", secs: 3600, none: "downloads.noneLastHour" },
  { label: "24h", secs: 86400, none: "downloads.noneLast24h" },
  { label: "7d", secs: 604800, none: "downloads.noneLast7d" },
  { label: "30d", secs: 2592000, none: "downloads.noneLast30d" },
  { label: "All", secs: null, none: "downloads.noneYet" },
];

export function DownloadsSection({
  projectDir,
  projectId,
  targetFolder,
  isRemote,
  onClose,
}: DownloadsSectionProps) {
  const t = useT();
  const configured = useSettingsStore((s) => s.settings?.download_sources);
  // Fall back to the OS Downloads dir when the user hasn't configured any source
  // folders. Resolved once, lazily, only while the list is empty.
  const [defaultDir, setDefaultDir] = useState<string | null>(null);
  useEffect(() => {
    if (configured && configured.length > 0) return;
    let alive = true;
    void downloadDir()
      .then((d) => alive && setDefaultDir(d))
      .catch(() => alive && setDefaultDir(null));
    return () => {
      alive = false;
    };
  }, [configured]);

  const paths = useMemo(
    () =>
      configured && configured.length > 0
        ? configured
        : defaultDir
          ? [defaultDir]
          : [],
    [configured, defaultDir],
  );
  const pathsKey = paths.join(" ");

  const [winIdx, setWinIdx] = useState(0); // default: last 1h

  // Resizable height: drag the top handle to grow the section into the right
  // panel (the tree above shrinks to make room). Clamped to the panel's height.
  const { sectionRef, heightPx, onResizePointerDown } = useResizableSection(220);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // path → collision-safe rel it landed at, briefly shown as a ✓ confirmation.
  const [copied, setCopied] = useState<Record<string, string>>({});
  // Opened by hand from the one-line form. While the window holds no rows the
  // section is that one line — the full resizable section is ~190 px of
  // nothing — unless the user opens it; rows arriving open it by themselves.
  const [expanded, setExpanded] = useState(false);

  const refresh = useCallback(async () => {
    if (paths.length === 0) {
      setEntries([]);
      return;
    }
    const secs = WINDOWS[winIdx].secs;
    const sinceSecs =
      secs == null ? undefined : Math.floor(Date.now() / 1000) - secs;
    setLoading(true);
    setError(null);
    try {
      const list = await invoke<FileEntry[]>("list_recent_downloads", {
        paths,
        sinceSecs,
      });
      setEntries(list);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
    // pathsKey captures the folder set; winIdx the cutoff.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathsKey, winIdx]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const flashCopied = useCallback((absPath: string, rel: string) => {
    setCopied((m) => ({ ...m, [absPath]: rel }));
    window.setTimeout(
      () =>
        setCopied((m) => {
          const next = { ...m };
          delete next[absPath];
          return next;
        }),
      1800,
    );
  }, []);

  const copyEntry = useCallback(
    async (entry: FileEntry, destFolder: string) => {
      if (isRemote || !projectDir) return;
      try {
        // `import_external_file` takes the destination FOLDER (rel) and derives +
        // dedupes the file name itself, so pass the folder, not folder/name.
        const rel = await invoke<string>("import_external_file", {
          projectDir,
          sourcePath: entry.path,
          destRel: destFolder,
          replace: false,
        });
        flashCopied(entry.path, rel);
      } catch (e) {
        setError(String(e));
      }
    },
    [isRemote, projectDir, flashCopied],
  );

  function openPreview(entry: FileEntry) {
    if (entry.is_dir) return;
    void useWindowsStore
      .getState()
      .openFile(entry.path, undefined, projectId, "downloads")
      .catch((e) => console.error(`[${BRAND.slug}] open download preview:`, e));
  }

  // Pointer-based drag of a download row onto a tree folder above → copy it there.
  // HTML5 DnD is unreliable on WebKitGTK, so this mirrors FileTree's own pointer
  // drag: drive the shared drag ghost from `useDragStore`, hit-test the tree's
  // `[data-move-rel]` folders under the cursor (imperatively reusing FileTree's
  // `.move-drop-target` highlight), and on release copy into the hovered folder.
  function onRowPointerDown(e: React.PointerEvent, entry: FileEntry) {
    if (e.button !== 0 || isRemote || !projectDir) return;
    // Let the copy button own its own clicks.
    if ((e.target as HTMLElement).closest(".dl-copy-btn")) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    // The folder (project-relative) the release would copy into, or null for a
    // release outside the file viewer. A folder row under the cursor wins; empty
    // space anywhere else in the tree defaults to the currently browsed folder.
    let dropDest: string | null = null;
    let hi: HTMLElement | null = null;
    const setHi = (el: HTMLElement | null) => {
      if (hi === el) return;
      hi?.classList.remove("move-drop-target");
      hi = el;
      hi?.classList.add("move-drop-target");
    };

    const onMove = (ev: PointerEvent) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
        dragging = true;
        useDragStore.getState().startFileDrag({
          label: entry.name,
          pointerX: ev.clientX,
          pointerY: ev.clientY,
          filePath: entry.path,
          fileName: entry.name,
        });
      }
      useDragStore.getState().move(ev.clientX, ev.clientY);
      const overEl = document.elementFromPoint(
        ev.clientX,
        ev.clientY,
      ) as HTMLElement | null;
      const moveEl = overEl?.closest<HTMLElement>("[data-move-rel]") ?? null;
      if (moveEl) {
        // Over a specific folder row / breadcrumb → copy into that folder.
        dropDest = moveEl.getAttribute("data-move-rel");
        setHi(moveEl);
      } else {
        // Anywhere else in the right file viewer (the tree scroll area, empty
        // space included) → copy into the folder currently shown. Releasing over
        // the downloads list itself, or outside the panel, is a no-op.
        const treeArea =
          !overEl?.closest(".downloads-section")
            ? (overEl?.closest<HTMLElement>(".side-panel-scroll") ?? null)
            : null;
        dropDest = treeArea ? targetFolder : null;
        setHi(treeArea);
      }
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      setHi(null);
    };
    const commit = () => {
      cleanup();
      if (!dragging) return; // a plain press (no move) — the row's onClick handles it
      const dest = dropDest;
      useDragStore.getState().end();
      if (dest != null) void copyEntry(entry, dest);
    };
    const abort = () => {
      cleanup();
      if (dragging) useDragStore.getState().end();
    };

    window.addEventListener("pointermove", onMove);
    bindDragRelease({ onCommit: commit, onAbort: abort });
  }

  const targetLabel = targetFolder || t("downloads.projectRoot");
  const hasSources = paths.length > 0;

  // Recent Downloads are the device the user sits at (hosted plan §3.3, user
  // decision 2026-10-03): a browser cannot list its own folder, and listing
  // the server's would be the wrong machine — so the section is not there.
  if (isServerClient()) return null;

  const windowPicker = (
    <div className="seg downloads-windows" role="group" aria-label={t("downloads.windowsLabel")}>
      {WINDOWS.map((w, i) => (
        <button
          key={w.label}
          type="button"
          className={`downloads-win-btn${i === winIdx ? " active" : ""}`}
          aria-pressed={i === winIdx}
          onClick={() => setWinIdx(i)}
          title={
            w.secs == null
              ? t("downloads.allDownloads")
              : t("downloads.modifiedInLast", { label: w.label })
          }
        >
          {w.secs == null ? t("downloads.windowAll") : w.label}
        </button>
      ))}
    </div>
  );
  const refreshButton = (
    <button
      type="button"
      className="toolbar-btn toolbar-btn--sm downloads-refresh"
      onClick={() => void refresh()}
      title={t("common.refresh")}
      aria-label={t("common.refresh")}
    >
      <RefreshIcon />
    </button>
  );

  // Nothing to show for this window: one line — the label (which opens the
  // full section), what the window holds, the window picker and refresh.
  if (entries.length === 0 && !expanded && !error) {
    const status = !hasSources
      ? t("downloads.noSourcesConfigured")
      : loading
        ? t("downloads.scanning")
        : t(WINDOWS[winIdx].none);
    return (
      <div className="downloads-section downloads-section--line">
        <button
          type="button"
          className="downloads-line-toggle"
          aria-expanded={false}
          onClick={() => setExpanded(true)}
        >
          <ChevronRightIcon />
          <InboxIcon />
          {t("downloads.title")}
        </button>
        <span className="downloads-line-status" title={status}>{status}</span>
        {windowPicker}
        {refreshButton}
        <UntestedTag id="downloads.remembered" />
      </div>
    );
  }

  return (
    <div className="downloads-section" ref={sectionRef} style={{ height: heightPx }}>
      <div
        className="downloads-resize"
        onPointerDown={onResizePointerDown}
        title={t("downloads.resizeHint")}
      />
      <div className="downloads-header">
        {/* Folds back to the one-line form while there is nothing to show;
            with rows the section stays open and the label is just a label. */}
        {entries.length === 0 ? (
          <button
            type="button"
            className="downloads-line-toggle"
            aria-expanded={true}
            onClick={() => {
              // An error is what holds the section open with no rows; folding
              // it is dismissing that too.
              setError(null);
              setExpanded(false);
            }}
          >
            <ChevronDownIcon />
            <InboxIcon />
            {t("downloads.title")}
          </button>
        ) : (
          <span className="downloads-title"><InboxIcon /> {t("downloads.title")}</span>
        )}
        <UntestedTag id="downloads.remembered" />
        {windowPicker}
        {refreshButton}
        <button
          type="button"
          className="toolbar-btn toolbar-btn--sm"
          onClick={onClose}
          title={t("downloads.hide")}
          aria-label={t("downloads.hide")}
        >
          <CloseIcon />
        </button>
      </div>

      <div className="downloads-target" title={t("downloads.copiesLandIn", { target: targetLabel })}>
        {isRemote
          ? t("downloads.remoteNotSupported")
          : t("downloads.dragOrCopyInto", { target: targetLabel })}
      </div>

      {error && <ErrorNote className="downloads-error" error={error} />}

      <div className="downloads-list">
        {!hasSources ? (
          <div className="file-tree-empty">{t("downloads.noSourcesConfigured")}</div>
        ) : loading && entries.length === 0 ? (
          <div className="file-tree-empty">{t("downloads.scanning")}</div>
        ) : entries.length === 0 ? (
          <div className="file-tree-empty">
            {t("downloads.noneInWindow", { label: WINDOWS[winIdx].label })}
          </div>
        ) : (
          entries.map((entry) => {
            const landed = copied[entry.path];
            return (
              <div
                key={entry.path}
                className="file-entry file file-grid downloads-row"
                style={{ userSelect: "none" }}
                title={entry.path}
                onPointerDown={(ev) => onRowPointerDown(ev, entry)}
                onClick={() => openPreview(entry)}
              >
                {/* The tree's row grid: an empty state cell, the copy action in
                    the action column, then the name and its size · time. */}
                <span className="sp-row-state file-state" />
                <span className="sp-row-act file-act">
                  {landed ? (
                    <span className="downloads-copied" title={t("downloads.copiedTo", { rel: landed })}>
                      <CheckIcon />
                    </span>
                  ) : (
                    !isRemote && (
                      <button
                        type="button"
                        className="btn-quiet dl-copy-btn"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          void copyEntry(entry, targetFolder);
                        }}
                        title={t("downloads.copyInto", { target: targetLabel })}
                        aria-label={t("downloads.copyInto", { target: targetLabel })}
                      >
                        <ArrowRightIcon />
                      </button>
                    )
                  )}
                </span>
                <span className="sp-row-main file-main">
                  <span className="file-icon">
                    <FileIcon ext={entry.extension} isDir={entry.is_dir} />
                  </span>
                  <span className="file-name">{entry.name}</span>
                </span>
                <span className="file-size downloads-meta">
                  {!entry.is_dir && fmtSize(entry.size)} · {fmtModified(entry.modified_secs)}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
