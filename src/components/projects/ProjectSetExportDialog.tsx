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
  ExportSetProgress,
  ExportSetReport,
  ProjectEntry,
} from "../../types";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import { isHostPinned } from "../../lib/projectTabHost";
import { ErrorNote } from "../common/ErrorNote";
import { NAMES } from "../../lib/brand";
import { CloseIcon } from "../common/icons/Icon";

/** A row's measurement: pending, measured, or why it could not be. */
type Measure = { preview?: ExportPreview; error?: string };

/** The save dialog's name for a set: `projects-YYYY-MM-DD.<ext>` (UTC, like
 *  the single bundle's). */
export function suggestedSetName(now = new Date()): string {
  return `projects-${now.toISOString().slice(0, 10)}.${NAMES.exportExtension}`;
}

/** Bytes one measured project carries under the shared switches. */
export function setRowBytes(
  preview: ExportPreview,
  opts: { includeFiles: boolean; includeGit: boolean; skipRebuildable: boolean; includeAgentHistory: boolean },
): number {
  const history = opts.includeAgentHistory ? preview.agentHistoryBytes : 0;
  // A remote-only project's tree comes from the host and is not measured here.
  if (preview.blocked || preview.remoteOnly || !opts.includeFiles) return history;
  const missing = preview.remote ? preview.mirrorMissing : preview.directoryMissing;
  if (missing) return history;
  return (
    preview.bytes +
    (opts.includeGit ? preview.gitBytes : 0) +
    (opts.skipRebuildable ? 0 : preview.rebuildableBytes) +
    history
  );
}

/**
 * "Export projects…" — several projects into one project-set file
 * (`commands::project_transfer::set`): one whole `.tabtivityproj` per project
 * inside, each exactly what "Export project…" writes, imported one by one by
 * the same "Import Project File".
 *
 * The switches are shared by every project; what one project alone can choose
 * (single rebuildable folders, a mirrored project's host copy) stays in the
 * single export. A ticked project is measured right away, one at a time, so
 * the estimate is a number before anything is written.
 */
export function ProjectSetExportDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const modalRef = useModalFocus(onClose);
  const projects = useProjectsStore((s) => s.projects);
  const connected = useRemoteStatusStore((s) => s.byProject);

  const [picked, setPicked] = useState<string[]>([]);
  const [measured, setMeasured] = useState<Record<string, Measure>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<ExportSetProgress | null>(null);
  const [report, setReport] = useState<ExportSetReport | null>(null);

  const [includeFiles, setIncludeFiles] = useState(true);
  const [includeGit, setIncludeGit] = useState(true);
  const [skipRebuildable, setSkipRebuildable] = useState(true);
  const [includeSession, setIncludeSession] = useState(true);
  // Off unless asked: a transcript holds whatever the agents read or printed.
  const [includeAgentHistory, setIncludeAgentHistory] = useState(false);

  const pickedSet = useMemo(() => new Set(picked), [picked]);
  const byId = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const hostUp = (id: string) => connected[id]?.ssh === "connected";

  const toggle = (id: string) =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  // Measure the ticked projects one at a time: each preview walks a whole tree.
  const next = picked.find((id) => !measured[id]);
  useEffect(() => {
    if (!next) return;
    let alive = true;
    invoke<ExportPreview>("preview_project_export", { projectId: next })
      .then((preview) => alive && setMeasured((m) => ({ ...m, [next]: { preview } })))
      .catch((e) => alive && setMeasured((m) => ({ ...m, [next]: { error: String(e) } })));
    return () => {
      alive = false;
    };
  }, [next]);

  useTauriListener(
    () =>
      listen<ExportSetProgress>("project-export-set", (event) => {
        setProgress(event.payload.phase === "done" ? null : event.payload);
      }),
    [],
  );

  /** Ticked projects that go in: measured, not refused. */
  const exportable = picked.filter((id) => {
    const m = measured[id];
    return m?.preview && !m.preview.blocked;
  });
  const measuring = picked.some((id) => !measured[id]);
  const opts = { includeFiles, includeGit, skipRebuildable, includeAgentHistory };
  const estimate = exportable.reduce((sum, id) => sum + setRowBytes(measured[id].preview!, opts), 0);
  const agentFiles = exportable.reduce((sum, id) => sum + measured[id].preview!.agentHistoryFiles, 0);
  const tabs = exportable.reduce((sum, id) => sum + measured[id].preview!.tabs, 0);

  const rowNote = (project: ProjectEntry): { text: string; error?: boolean } | null => {
    if (!pickedSet.has(project.id)) return null;
    const m = measured[project.id];
    if (!m) return { text: t("transfer.set.measuring") };
    if (m.error) return { text: m.error, error: true };
    const p = m.preview!;
    if (p.blocked) return { text: t(`transfer.blocked.${p.blocked}` as TranslationKey), error: true };
    if (p.remoteOnly) {
      return {
        text: hostUp(project.id) ? t("transfer.set.fromHost") : t("transfer.set.hostOffline"),
      };
    }
    if (p.remote ? p.mirrorMissing : p.directoryMissing) {
      return { text: t("transfer.set.settingsOnly") };
    }
    return { text: formatBytes(setRowBytes(p, opts)) };
  };

  const runExport = async () => {
    if (exportable.length === 0) return;
    const destination = await saveDialog({
      defaultPath: suggestedSetName(),
      filters: [{ name: t("transfer.set.filter"), extensions: [NAMES.exportExtension] }],
    });
    if (typeof destination !== "string") return;

    setBusy(true);
    setError("");
    try {
      const result = await invoke<ExportSetReport>("export_project_set", {
        req: {
          projectIds: exportable,
          destPath: destination,
          includeFiles,
          includeGit,
          includeSession,
          includeMirror: includeFiles,
          skipRebuildable,
          includeAgentHistory,
          // A remote-only project has no local copy: its tree comes from the
          // host, and only while the host can be read.
          hostCopy: exportable.filter((id) => {
            const project = byId.get(id);
            return !!project && isHostPinned(project) && hostUp(id);
          }),
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

  const revealSet = () => {
    if (!report) return;
    void invoke("open_in_file_manager", { path: report.path }).catch((e) => setError(String(e)));
  };

  const progressName = progress ? byId.get(progress.projectId)?.name ?? "" : "";

  return createPortal(
    <div className="modal-backdrop" onMouseDown={() => { if (!busy) onClose(); }}>
      <div
        ref={modalRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t("transfer.set.exportTitle")}
        className="project-dialog dialog-framed"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="settings-title-row">
          <h2>
            {t("transfer.set.exportTitle")} <UntestedTag id="transfer.exportSet" />
          </h2>
          <button aria-label={t("common.close")} type="button" className="dialog-close-btn" onClick={onClose} disabled={busy}>
            <CloseIcon />
          </button>
        </div>

        <div className="dialog-scroll">
          {!report && (
            <>
              <p className="settings-help">{t("transfer.set.exportIntro")}</p>
              <div className="project-dialog-actions dialog-actions-start">
                <button type="button" disabled={busy} onClick={() => setPicked(projects.map((p) => p.id))}>
                  {t("transfer.set.selectAll")}
                </button>
                <button type="button" disabled={busy} onClick={() => setPicked([])}>
                  {t("transfer.set.selectNone")}
                </button>
              </div>
              <div className="big-folder-list">
                {projects.map((project) => {
                  const note = rowNote(project);
                  return (
                    <label key={project.id} className="big-folder-row transfer-rebuildable-row">
                      <input
                        type="checkbox"
                        checked={pickedSet.has(project.id)}
                        disabled={busy}
                        aria-label={project.name}
                        onChange={() => toggle(project.id)}
                      />
                      <span className="big-folder-path" title={project.name}>
                        {project.name}
                      </span>
                      <span
                        className={note?.error ? "big-folder-files project-dialog-error" : "big-folder-files"}
                        title={note?.text}
                      >
                        {note?.text ?? ""}
                      </span>
                    </label>
                  );
                })}
              </div>

              <label className="container-settings-toggle">
                <span>
                  {t("transfer.includeFiles")}
                  <span className="settings-help">{t("transfer.set.includeFilesHelp")}</span>
                </span>
                <Toggle
                  checked={includeFiles}
                  aria-label={t("transfer.includeFiles")}
                  onChange={(e) => setIncludeFiles(e.target.checked)}
                  size="sm"
                />
              </label>
              <label className="container-settings-toggle">
                <span>
                  {t("transfer.includeGit")}
                  <span className="settings-help">{t("transfer.set.includeGitHelp")}</span>
                </span>
                <Toggle
                  checked={includeGit}
                  aria-label={t("transfer.includeGit")}
                  onChange={(e) => setIncludeGit(e.target.checked)}
                  size="sm"
                />
              </label>
              <label className="container-settings-toggle">
                <span>
                  {t("transfer.skipRebuildable")}
                  <span className="settings-help">{t("transfer.set.skipRebuildableHelp")}</span>
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
                    {t("transfer.set.includeSessionHelp", { count: String(tabs) })}
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
                  {t("transfer.includeAgentHistory")}
                  <span className="settings-help">
                    {t("transfer.set.includeAgentHistoryHelp", { count: String(agentFiles) })}
                  </span>
                </span>
                <Toggle
                  checked={includeAgentHistory}
                  aria-label={t("transfer.includeAgentHistory")}
                  onChange={(e) => setIncludeAgentHistory(e.target.checked)}
                  size="sm"
                />
              </label>

              <p className="settings-help">{t("transfer.set.singleOnly")}</p>
              <p className="settings-help">{t("transfer.neverCarried")}</p>

              <p className="project-dialog-path">
                {measuring
                  ? t("transfer.set.measuringAll")
                  : t("transfer.set.estimate", {
                      count: String(exportable.length),
                      size: formatBytes(estimate),
                    })}
              </p>

              {progress && (
                <p className="settings-help">
                  {t("transfer.set.progress", {
                    index: String(progress.index + 1),
                    count: String(progress.count),
                    name: progressName,
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
                {t("transfer.set.exportDone", {
                  size: formatBytes(report.bytes),
                  count: String(report.members.filter((m) => m.report).length),
                })}
              </p>
              <p className="project-dialog-path">{report.path}</p>
              <div className="big-folder-list">
                {report.members.map((member) => (
                  <div key={member.projectId} className="big-folder-row transfer-rebuildable-row">
                    <span>{member.report ? "✓" : "✗"}</span>
                    <span className="big-folder-path" title={member.name || member.projectId}>
                      {member.name || member.projectId}
                    </span>
                    <span
                      className={member.error ? "big-folder-files project-dialog-error" : "big-folder-files"}
                      title={member.error ?? undefined}
                    >
                      {member.report
                        ? member.report.skippedCount > 0
                          ? t("transfer.set.memberFilesSkipped", {
                              count: String(member.report.files),
                              skipped: String(member.report.skippedCount),
                            })
                          : t("transfer.set.memberFiles", { count: String(member.report.files) })
                        : member.error}
                    </span>
                  </div>
                ))}
              </div>
              <p className="settings-help">{t("transfer.exportNextStep")}</p>
            </>
          )}
        </div>

        <div className="dialog-fixed-footer">
          {error && <ErrorNote className="project-dialog-error" role="alert" error={error} />}
          <div className="project-dialog-actions">
            <button type="button" onClick={onClose} disabled={busy}>
              {report ? t("common.close") : t("common.cancel")}
            </button>
            {report ? (
              <button type="button" onClick={revealSet}>
                {t("transfer.showBundle")}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void runExport()}
                disabled={busy || measuring || exportable.length === 0}
              >
                {busy ? t("transfer.exporting") : t("transfer.exportEllipsis")}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
