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
  ProjectEntry,
} from "../../types";
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

  // Progress for a tree that can take minutes: a bundle is written file by
  // file, and a dialog that only says "Exporting…" for three minutes is
  // indistinguishable from one that has hung.
  useEffect(() => {
    const unlisten = listen<ExportProgress>("project-export", (event) => {
      if (event.payload.projectId !== project.id) return;
      setProgress(event.payload.phase === "done" ? null : event.payload);
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, [project.id]);

  /** Bytes the current toggles would carry — the preview's parts, summed. */
  const estimate = useMemo(() => {
    if (!preview) return 0;
    if (preview.remote) {
      return includeMirror
        ? preview.bytes +
            (includeGit ? preview.gitBytes : 0) +
            (skipRebuildable ? 0 : preview.rebuildableBytes)
        : 0;
    }
    if (!includeFiles) return 0;
    return (
      preview.bytes +
      (includeGit ? preview.gitBytes : 0) +
      (skipRebuildable ? 0 : preview.rebuildableBytes)
    );
  }, [preview, includeFiles, includeGit, includeMirror, skipRebuildable]);

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
          includeMirror,
          skipRebuildable,
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
      <div className="project-dialog" onMouseDown={(e) => e.stopPropagation()}>
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
              <label className="container-settings-toggle">
                <span>
                  {t("transfer.includeMirror")}
                  <span className="settings-help">
                    {preview.mirrorMissing
                      ? t("transfer.mirrorMissing")
                      : t("transfer.includeMirrorHelp", {
                          size: formatBytes(preview.bytes),
                        })}
                  </span>
                </span>
                <Toggle
                  checked={includeMirror && !preview.mirrorMissing}
                  aria-label={t("transfer.includeMirror")}
                  disabled={preview.mirrorMissing}
                  onChange={(e) => setIncludeMirror(e.target.checked)}
                  size="sm"
                />
              </label>
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
                  {preview.gitFiles === 0
                    ? t("transfer.noGitHistory")
                    : t("transfer.includeGitHelp", {
                        size: formatBytes(preview.gitBytes),
                      })}
                </span>
              </span>
              <Toggle
                checked={includeGit && preview.gitFiles > 0}
                  aria-label={t("transfer.includeGit")}
                disabled={preview.gitFiles === 0}
                onChange={(e) => setIncludeGit(e.target.checked)}
                size="sm"
              />
            </label>

            <label className="container-settings-toggle">
              <span>
                {t("transfer.skipRebuildable")}
                <span className="settings-help">
                  {t("transfer.skipRebuildableHelp", {
                    size: formatBytes(preview.rebuildableBytes),
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
            {report.notes.map((note) => (
              <p className="settings-help" key={note}>
                {t(`transfer.note.${note}` as TranslationKey)}
              </p>
            ))}
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
              disabled={busy || loading || !preview || !!preview.blocked}
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
