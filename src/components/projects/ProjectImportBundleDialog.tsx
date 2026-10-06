import { useModalFocus } from "../../hooks/useModalFocus";
import { useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Toggle } from "../common/Toggle";
import { UntestedTag } from "../common/UntestedTag";
import { FolderPickerDialog } from "../common/FolderPickerDialog";
import { formatBytes } from "../../lib/formatBytes";
import { useT, type TranslationKey } from "../../lib/i18n";
import type {
  BundleInfo,
  ImportBundleResult,
  ProjectEntry,
} from "../../types";
import { ErrorNote } from "../common/ErrorNote";
import { exportExtensions } from "../../lib/brandMigration";
import { useBoxesStore } from "../../stores/boxes";

/**
 * "Import project file…" — register a `.tabtivityproj` bundle written by
 * `ProjectExportDialog`, on this or any other machine.
 *
 * Two-step on purpose: the bundle is read (manifest only, nothing unpacked)
 * before anything is asked, so the dialog can name the project, say what is in
 * the file and warn about the two things that do not travel — the host
 * credentials of a remote project, and a tab whose command this installation
 * does not know. Deciding where a whole project tree lands is not a question to
 * answer blind.
 */
export function ProjectImportBundleDialog({
  onClose,
  onProject,
}: {
  onClose: () => void;
  onProject: (project: ProjectEntry) => void;
}) {
  const t = useT();
  const [info, setInfo] = useState<BundleInfo | null>(null);
  const [name, setName] = useState("");
  const [parent, setParent] = useState("");
  const [picking, setPicking] = useState(false);
  const [restoreSession, setRestoreSession] = useState(true);
  const [restoreTime, setRestoreTime] = useState(true);
  const [joinBoxes, setJoinBoxes] = useState(true);
  const [busy, setBusy] = useState(false);
  const modalRef = useModalFocus(() => { if (!busy) onClose(); });
  const [error, setError] = useState("");
  const [result, setResult] = useState<ImportBundleResult | null>(null);

  const chooseBundle = async () => {
    const picked = await openDialog({
      multiple: false,
      directory: false,
      filters: [
        {
          name: t("transfer.bundleFilter"),
          extensions: [...exportExtensions(), "zip"],
        },
      ],
    });
    if (typeof picked !== "string") return;
    setBusy(true);
    setError("");
    try {
      const read = await invoke<BundleInfo>("inspect_project_export", {
        bundlePath: picked,
      });
      setInfo(read);
      setName(read.name);
      setParent(read.suggestedParent);
    } catch (e) {
      setInfo(null);
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const runImport = async () => {
    if (!info) return;
    setBusy(true);
    setError("");
    try {
      const imported = await invoke<ImportBundleResult>(
        "import_project_export",
        {
          req: {
            bundlePath: info.path,
            name: name.trim() || null,
            targetParent: parent.trim() || null,
            mirrorParent: info.remote ? parent.trim() || null : null,
            restoreSession,
            restoreTime,
            joinBoxes,
          },
        },
      );
      setResult(imported);
      onProject(imported.entry);
      // Joining boxes wrote `boxes.json` behind the store's back: reload it,
      // or the box pills miss the new member and the store's next whole-list
      // box save is refused as stale (the revisions moved on).
      if (imported.boxesJoined.length > 0) void useBoxesStore.getState().load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={modalRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t("transfer.importTitle")} className="project-dialog dialog-framed" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-title-row">
          <h2>
            {t("transfer.importTitle")} <UntestedTag id="transfer.import" />
          </h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="dialog-scroll">
        {!result && (
          <>
            <p className="settings-help">{t("transfer.importIntro")}</p>
            <div className="project-dialog-actions dialog-actions-start">
              <button type="button" onClick={() => void chooseBundle()} disabled={busy}>
                {t("transfer.chooseBundle")}
              </button>
            </div>
          </>
        )}

        {info && !result && (
          <>
            <p className="project-dialog-path">{info.path}</p>
            <p className="settings-help">
              {t("transfer.bundleSummary", {
                name: info.name,
                date: info.exportedAt.slice(0, 10),
                version: info.appVersion,
              })}
            </p>
            <p className="settings-help">
              {t(
                info.contents.files > 0
                  ? "transfer.bundleFiles"
                  : "transfer.bundleNoFiles",
                {
                  count: String(info.contents.files),
                  size: formatBytes(info.contents.bytes),
                },
              )}
            </p>
            {info.contents.rebuildableSkipped && (
              <p className="settings-help">{t("transfer.note.rebuildableSkipped")}</p>
            )}
            {!info.contents.gitHistory && !info.remote && (
              <p className="settings-help">{t("transfer.note.noGitHistory")}</p>
            )}
            {info.remote && (
              <p className="settings-help">{t("transfer.note.remoteCredentials")}</p>
            )}
            {info.idInUse && (
              <p className="settings-help">{t("transfer.note.newId")}</p>
            )}
            {info.siteConflict && (
              <p className="project-dialog-error">
                {t("transfer.siteConflict", { name: info.siteConflict })}
              </p>
            )}

            <label>
              {t("transfer.importName")}
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                spellCheck={false}
              />
            </label>

            <label>
              {t(info.remote ? "transfer.mirrorLocation" : "transfer.importLocation")}
              <input
                type="text"
                value={parent}
                onChange={(e) => setParent(e.target.value)}
                spellCheck={false}
              />
            </label>
            <div className="project-dialog-actions dialog-actions-start">
              <button type="button" onClick={() => setPicking(true)} disabled={busy}>
                {t("transfer.browseEllipsis")}
              </button>
            </div>

            <label className="container-settings-toggle">
              <span>
                {t("transfer.restoreSession")}
                <span className="settings-help">
                  {t("transfer.restoreSessionHelp", { count: String(info.tabs) })}
                </span>
              </span>
              <Toggle
                checked={restoreSession && info.tabs > 0}
                  aria-label={t("transfer.restoreSession")}
                disabled={info.tabs === 0}
                onChange={(e) => setRestoreSession(e.target.checked)}
                size="sm"
              />
            </label>

            <label className="container-settings-toggle">
              <span>
                {t("transfer.restoreTime")}
                <span className="settings-help">
                  {t("transfer.restoreTimeHelp", { count: String(info.timeDays) })}
                </span>
              </span>
              <Toggle
                checked={restoreTime && info.timeDays > 0}
                  aria-label={t("transfer.restoreTime")}
                disabled={info.timeDays === 0}
                onChange={(e) => setRestoreTime(e.target.checked)}
                size="sm"
              />
            </label>

            {info.boxNames.length > 0 && (
              <label className="container-settings-toggle">
                <span>
                  {t("transfer.joinBoxes")}
                  <span className="settings-help">
                    {t("transfer.joinBoxesHelp", { list: info.boxNames.join(", ") })}
                  </span>
                </span>
                <Toggle
                  checked={joinBoxes}
                  aria-label={t("transfer.joinBoxes")}
                  onChange={(e) => setJoinBoxes(e.target.checked)}
                  size="sm"
                />
              </label>
            )}
          </>
        )}

        {result && (
          <>
            <p className="settings-help">
              {t("transfer.importDone", {
                name: result.entry.name,
                count: String(result.files),
              })}
            </p>
            <p className="project-dialog-path">{result.directory}</p>
            {result.mirror && <p className="project-dialog-path">{result.mirror}</p>}
            {result.tabsRestored > 0 && (
              <p className="settings-help">
                {t("transfer.tabsRestored", { count: String(result.tabsRestored) })}
              </p>
            )}
            {result.boxesJoined.length > 0 && (
              <p className="settings-help">
                {t("transfer.boxesJoined", { list: result.boxesJoined.join(", ") })}
              </p>
            )}
            {result.boxesMissing.length > 0 && (
              <p className="settings-help">
                {t("transfer.boxesMissing", { list: result.boxesMissing.join(", ") })}
              </p>
            )}
            {result.notes.map((note) => (
              <p className="settings-help" key={note}>
                {t(`transfer.note.${note}` as TranslationKey)}
              </p>
            ))}
          </>
        )}

        </div>
        <div className="dialog-fixed-footer">
        {error && <ErrorNote className="project-dialog-error" role="alert" error={error} />}

        <div className="project-dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            {result ? t("common.close") : t("common.cancel")}
          </button>
          {!result && (
            <button
              type="button"
              onClick={() => void runImport()}
              disabled={busy || !info || !!info.siteConflict}
            >
              {busy ? t("transfer.importing") : t("transfer.importProject")}
            </button>
          )}
        </div>
        </div>
      </div>

      {picking && info && (
        <FolderPickerDialog
          initialPath={parent || info.suggestedParent}
          title={t("transfer.pickLocationTitle")}
          confirmLabel={t("transfer.useThisFolder")}
          allowCreateFolder
          onConfirm={(dir) => {
            setParent(dir);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>,
    document.body,
  );
}
