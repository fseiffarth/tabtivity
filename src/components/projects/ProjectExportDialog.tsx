import { useModalFocus } from "../../hooks/useModalFocus";
import { useTauriListener } from "../../hooks/useTauriListener";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Toggle } from "../common/Toggle";
import { UntestedTag } from "../common/UntestedTag";
import { formatBytes } from "../../lib/formatBytes";
import { useT, type TranslationKey } from "../../lib/i18n";
import type {
  ExportPreview,
  ExportProgress,
  ExportReport,
  HostTally,
  MirrorSource,
  ProjectEntry,
} from "../../types";
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import { ErrorNote } from "../common/ErrorNote";
import { NAMES } from "../../lib/brand";

/**
 * "Export project…" — write one project into a single `.tabtivityproj` file that
 * can be carried to another computer (see `commands::project_transfer`).
 *
 * The toggles exist because the honest answer to "export the project" is not
 * one size: a tree with a 3 GB `node_modules` and a 900 MB `.git` is mostly
 * things the far side can rebuild or re-clone, and a user moving to a laptop
 * over a USB stick wants to know that *before* the file is written. So the
 * preview measures each part separately and every switch shows what it costs —
 * the dialog's whole job is turning "how big will this be?" into a number
 * before anything is written.
 */
export function ProjectExportDialog({
  project,
  onClose,
}: {
  project: ProjectEntry;
  onClose: () => void;
}) {
  const t = useT();
  const modalRef = useModalFocus(onClose);
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [report, setReport] = useState<ExportReport | null>(null);

  const [includeFiles, setIncludeFiles] = useState(true);
  const [includeGit, setIncludeGit] = useState(true);
  const [skipRebuildable, setSkipRebuildable] = useState(true);
  const [includeSession, setIncludeSession] = useState(true);
  const [includeMirror, setIncludeMirror] = useState(true);
  // Off unless asked: a transcript holds whatever the agents read or printed.
  const [includeAgentHistory, setIncludeAgentHistory] = useState(false);
  /** Rebuildable folders the user unticked: carried despite the skip. */
  const [kept, setKept] = useState<Set<string>>(() => new Set());
  /** Remote projects: pack this machine's mirror, or the host's own tree. */
  const [mirrorSource, setMirrorSource] = useState<MirrorSource>("local");
  const [hostTally, setHostTally] = useState<HostTally | null>(null);
  const [hostError, setHostError] = useState("");
  // The host is only ever asked while its connection is up: an SSH command
  // against a dead session can hang the dialog.
  const hostConnected = useRemoteStatusStore(
    (s) => s.byProject[project.id]?.ssh === "connected",
  );
  // A remote-only project has no local copy: its tree comes from the host or not
  // at all (the backend refuses `mirrorSource: "local"` for it).
  const remoteOnly = !!preview?.remoteOnly;
  const wantsHost = remoteOnly || mirrorSource === "host";
  const fromHost = !!preview?.remote && wantsHost;
  // Whether the files part is actually carried: for a remote-only project only
  // while the host can be read.
  const carriesMirror = includeMirror && (!remoteOnly || hostConnected);

  const toggleKept = (path: string) =>
    setKept((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  useEffect(() => {
    let alive = true;
    setLoading(true);
    invoke<ExportPreview>("preview_project_export", { projectId: project.id })
      .then((p) => {
        if (!alive) return;
        setPreview(p);
        setError("");
      })
      .catch((e) => alive && setError(String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [project.id]);

  // The host's tree is measured only once that copy is picked.
  useEffect(() => {
    if (!wantsHost) return;
    if (!hostConnected) {
      // A mirrored project falls back to its local copy; a remote-only one has
      // none, so it just waits for the connection.
      if (!remoteOnly) setMirrorSource("local");
      return;
    }
    if (hostTally) return;
    let alive = true;
    setHostError("");
    invoke<HostTally>("preview_host_export", { projectId: project.id })
      .then((tally) => alive && setHostTally(tally))
      .catch((e) => alive && setHostError(String(e)));
    return () => {
      alive = false;
    };
  }, [wantsHost, remoteOnly, hostConnected, hostTally, project.id]);

  // Progress for a tree that can take minutes: a bundle is written file by
  // file, and a dialog that only says "Exporting…" for three minutes is
  // indistinguishable from one that has hung.
  useTauriListener(
    () =>
      listen<ExportProgress>("project-export", (event) => {
        if (event.payload.projectId !== project.id) return;
        setProgress(event.payload.phase === "done" ? null : event.payload);
      }),
    [project.id],
  );

  /** Bytes the current toggles would carry — the preview's parts, summed. */
  const estimate = useMemo(() => {
    if (!preview) return 0;
    const history = includeAgentHistory ? preview.agentHistoryBytes : 0;
    if (fromHost) {
      if (!hostTally || !carriesMirror) return history;
      return (
        hostTally.bytes +
        (includeGit ? hostTally.gitBytes : 0) +
        (skipRebuildable ? 0 : hostTally.rebuildableBytes) +
        history
      );
    }
    const rebuildable = skipRebuildable
      ? preview.rebuildableDirs
          .filter((dir) => kept.has(dir.path))
          .reduce((sum, dir) => sum + dir.bytes, 0)
      : preview.rebuildableBytes;
    const tree = preview.bytes + (includeGit ? preview.gitBytes : 0) + rebuildable;
    const carried = preview.remote ? includeMirror : includeFiles;
    return (carried ? tree : 0) + history;
  }, [preview, fromHost, hostTally, includeFiles, includeGit, includeMirror, carriesMirror, skipRebuildable, kept, includeAgentHistory]);

  /** The sizes the git and rebuildable switches show: the host's when its
   *  copy is the one packed. */
  const gitBytes = fromHost ? (hostTally?.gitBytes ?? 0) : (preview?.gitBytes ?? 0);
  const hasGit = fromHost ? !hostTally || hostTally.gitFiles > 0 : (preview?.gitFiles ?? 0) > 0;
  const rebuildableBytes = fromHost
    ? (hostTally?.rebuildableBytes ?? 0)
    : (preview?.rebuildableBytes ?? 0);
  const mirrorUnavailable = !!preview?.mirrorMissing && !fromHost;

  const blockedReason = preview?.blocked
    ? t(`transfer.blocked.${preview.blocked}` as TranslationKey)
    : "";

  const runExport = async () => {
    if (!preview) return;
    const destination = await saveDialog({
      defaultPath: preview.suggestedFileName,
      filters: [
        { name: t("transfer.bundleFilter"), extensions: [NAMES.exportExtension] },
      ],
    });
    if (typeof destination !== "string") return;

    setBusy(true);
    setError("");
    try {
      const result = await invoke<ExportReport>("export_project", {
        req: {
          projectId: project.id,
          destPath: destination,
          includeFiles,
          includeGit,
          includeSession,
          includeMirror: carriesMirror,
          mirrorSource: remoteOnly ? "host" : mirrorSource,
          skipRebuildable,
          keepRebuildable: skipRebuildable && !fromHost ? [...kept] : [],
          includeAgentHistory,
        },
      });
      setReport(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const revealBundle = () => {
    if (!report) return;
    void invoke("open_in_file_manager", { path: report.path }).catch((e) =>
      setError(String(e)),
    );
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div ref={modalRef} tabIndex={-1} role="dialog" aria-modal="true" className="project-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-title-row">
          <h2>
            {t("transfer.exportTitle", { name: project.name })}{" "}
            <UntestedTag id="transfer.export" />
          </h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>
            ×
          </button>
        </div>

        {loading && <p className="settings-help">{t("common.loading")}</p>}

        {preview?.blocked && (
          <p className="project-dialog-error">{blockedReason}</p>
        )}

        {preview && !preview.blocked && !report && (
          <>
            <p className="settings-help">{t("transfer.exportIntro")}</p>

            {preview.remote ? (
              <>
                <label className="container-settings-toggle">
                  <span>
                    {t("transfer.includeMirror")}
                    <span className="settings-help">{t("transfer.includeMirrorHelp")}</span>
                  </span>
                  <Toggle
                    checked={remoteOnly ? carriesMirror : includeMirror && !mirrorUnavailable}
                    aria-label={t("transfer.includeMirror")}
                    disabled={(mirrorUnavailable || remoteOnly) && !hostConnected}
                    onChange={(e) => setIncludeMirror(e.target.checked)}
                    size="sm"
                  />
                </label>
                {remoteOnly && (
                  <p className="settings-help">
                    {t("transfer.remoteOnlyNote")}{" "}
                    {!hostConnected
                      ? t("transfer.mirrorSourceHostOffline")
                      : hostError
                        ? hostError
                        : hostTally
                          ? t("transfer.mirrorSourceHostHelp", {
                              count: String(hostTally.files),
                              size: formatBytes(hostTally.bytes),
                            })
                          : t("transfer.mirrorSourceHostMeasuring")}
                  </p>
                )}
                {includeMirror && !remoteOnly && (
                  <fieldset className="container-scope-fieldset">
                    <legend>{t("transfer.mirrorSourceLegend")}</legend>
                    <label className="container-scope-option">
                      <input
                        type="radio"
                        name="mirror-source"
                        checked={mirrorSource === "local"}
                        disabled={preview.mirrorMissing}
                        onChange={() => setMirrorSource("local")}
                      />
                      <span>
                        <strong>{t("transfer.mirrorSourceLocal")}</strong>
                        <span className="settings-help">
                          {preview.mirrorMissing
                            ? t("transfer.mirrorMissing")
                            : t("transfer.mirrorSourceLocalHelp", {
                                count: String(preview.files),
                                size: formatBytes(preview.bytes),
                              })}
                        </span>
                      </span>
                    </label>
                    <label className="container-scope-option">
                      <input
                        type="radio"
                        name="mirror-source"
                        checked={mirrorSource === "host"}
                        disabled={!hostConnected}
                        onChange={() => setMirrorSource("host")}
                      />
                      <span>
                        <strong>
                          {t("transfer.mirrorSourceHost")} <UntestedTag id="transfer.hostCopy" />
                        </strong>
                        <span className="settings-help">
                          {!hostConnected
                            ? t("transfer.mirrorSourceHostOffline")
                            : !fromHost
                              ? t("transfer.mirrorSourceHostIdle")
                              : hostError
                                ? hostError
                                : hostTally
                                  ? t("transfer.mirrorSourceHostHelp", {
                                      count: String(hostTally.files),
                                      size: formatBytes(hostTally.bytes),
                                    })
                                  : t("transfer.mirrorSourceHostMeasuring")}
                        </span>
                      </span>
                    </label>
                  </fieldset>
                )}
              </>
            ) : (
              <label className="container-settings-toggle">
                <span>
                  {t("transfer.includeFiles")}
                  <span className="settings-help">
                    {preview.directoryMissing
                      ? t("transfer.folderMissing")
                      : t("transfer.includeFilesHelp", {
                          count: String(preview.files),
                          size: formatBytes(preview.bytes),
                        })}
                  </span>
                </span>
                <Toggle
                  checked={includeFiles && !preview.directoryMissing}
                  aria-label={t("transfer.includeFiles")}
                  disabled={preview.directoryMissing}
                  onChange={(e) => setIncludeFiles(e.target.checked)}
                  size="sm"
                />
              </label>
            )}

            <label className="container-settings-toggle">
              <span>
                {t("transfer.includeGit")}
                <span className="settings-help">
                  {!hasGit
                    ? t("transfer.noGitHistory")
                    : t("transfer.includeGitHelp", {
                        size: formatBytes(gitBytes),
                      })}
                </span>
              </span>
              <Toggle
                checked={includeGit && hasGit}
                  aria-label={t("transfer.includeGit")}
                disabled={!hasGit}
                onChange={(e) => setIncludeGit(e.target.checked)}
                size="sm"
              />
            </label>

            <label className="container-settings-toggle">
              <span>
                {t("transfer.skipRebuildable")}
                <span className="settings-help">
                  {fromHost
                    ? t("transfer.skipRebuildableHostHelp", {
                        size: formatBytes(rebuildableBytes),
                      })
                    : t("transfer.skipRebuildableHelp", {
                        size: formatBytes(rebuildableBytes),
                      })}
                </span>
              </span>
              <Toggle
                checked={skipRebuildable}
                  aria-label={t("transfer.skipRebuildable")}
                onChange={(e) => setSkipRebuildable(e.target.checked)}
                size="sm"
              />
            </label>
            {skipRebuildable && !fromHost && preview.rebuildableDirs.length > 0 && (
              <>
                <p className="settings-help">{t("transfer.rebuildableListHelp")}</p>
                <div className="big-folder-list">
                  {preview.rebuildableDirs.map((dir) => (
                    <label key={dir.path} className="big-folder-row transfer-rebuildable-row">
                      <input
                        type="checkbox"
                        checked={!kept.has(dir.path)}
                        aria-label={t("transfer.skipFolder", { path: dir.path })}
                        onChange={() => toggleKept(dir.path)}
                      />
                      <span className="big-folder-path" title={dir.path}>
                        {dir.path}
                      </span>
                      <span className="big-folder-files">{formatBytes(dir.bytes)}</span>
                    </label>
                  ))}
                </div>
              </>
            )}

            <label className="container-settings-toggle">
              <span>
                {t("transfer.includeSession")}
                <span className="settings-help">
                  {t("transfer.includeSessionHelp", {
                    count: String(preview.tabs),
                  })}
                </span>
              </span>
              <Toggle
                checked={includeSession}
                  aria-label={t("transfer.includeSession")}
                onChange={(e) => setIncludeSession(e.target.checked)}
                size="sm"
              />
            </label>

            <label className="container-settings-toggle">
              <span>
                {t("transfer.includeAgentHistory")} <UntestedTag id="transfer.agentHistory" />
                <span className="settings-help">
                  {preview.agentHistoryFiles === 0
                    ? t("transfer.noAgentHistory")
                    : t("transfer.includeAgentHistoryHelp", {
                        count: String(preview.agentHistoryFiles),
                        size: formatBytes(preview.agentHistoryBytes),
                      })}
                </span>
              </span>
              <Toggle
                checked={includeAgentHistory && preview.agentHistoryFiles > 0}
                aria-label={t("transfer.includeAgentHistory")}
                disabled={preview.agentHistoryFiles === 0}
                onChange={(e) => setIncludeAgentHistory(e.target.checked)}
                size="sm"
              />
            </label>

            {preview.skipped > 0 && (
              <p className="settings-help">
                {t("transfer.previewSkipped", { count: String(preview.skipped) })}
              </p>
            )}

            <p className="settings-help">{t("transfer.alwaysCarried")}</p>
            {preview.boxNames.length > 0 && (
              <p className="settings-help">
                {t("transfer.boxes", { list: preview.boxNames.join(", ") })}
              </p>
            )}
            <p className="settings-help">{t("transfer.neverCarried")}</p>

            <p className="project-dialog-path">
              {t("transfer.estimate", { size: formatBytes(estimate) })}
            </p>

            {progress && progress.total > 0 && (
              <p className="settings-help">
                {t("transfer.exportProgress", {
                  done: String(progress.done),
                  total: String(progress.total),
                })}
              </p>
            )}
          </>
        )}

        {report && (
          <>
            <p className="settings-help">
              {t("transfer.exportDone", {
                size: formatBytes(report.bytes),
                count: String(report.files),
              })}
            </p>
            <p className="project-dialog-path">{report.path}</p>
            {report.agentFiles > 0 && (
              <p className="settings-help">
                {t("transfer.agentFilesExported", { count: String(report.agentFiles) })}
              </p>
            )}
            {report.notes.map((note) => (
              <p className="settings-help" key={note}>
                {t(`transfer.note.${note}` as TranslationKey)}
              </p>
            ))}
            {report.skippedCount > 0 && (
              <>
                <p className="project-dialog-error">
                  {t("transfer.skippedHeading", { count: String(report.skippedCount) })}
                </p>
                <div className="big-folder-list">
                  {report.skipped.map((entry) => (
                    <div key={entry.path} className="big-folder-row transfer-rebuildable-row">
                      <span />
                      <span className="big-folder-path" title={entry.path}>
                        {entry.path}
                      </span>
                      <span className="big-folder-files">
                        {t(`transfer.skip.${entry.reason}` as TranslationKey)}
                      </span>
                    </div>
                  ))}
                </div>
                {report.skippedCount > report.skipped.length && (
                  <p className="settings-help">
                    {t("transfer.skippedMore", {
                      count: String(report.skippedCount - report.skipped.length),
                    })}
                  </p>
                )}
              </>
            )}
            <p className="settings-help">{t("transfer.exportNextStep")}</p>
          </>
        )}

        {error && <ErrorNote className="project-dialog-error" error={error} />}

        <div className="project-dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            {report ? t("common.close") : t("common.cancel")}
          </button>
          {report ? (
            <button type="button" onClick={revealBundle}>
              {t("transfer.showBundle")}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void runExport()}
              disabled={
                busy ||
                loading ||
                !preview ||
                !!preview.blocked ||
                (fromHost && carriesMirror && !hostTally)
              }
            >
              {busy ? t("transfer.exporting") : t("transfer.exportEllipsis")}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
