import { useModalFocus } from "../../hooks/useModalFocus";
import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { Toggle } from "../common/Toggle";
import { UntestedTag } from "../common/UntestedTag";
import { FolderPickerDialog } from "../common/FolderPickerDialog";
import { formatBytes } from "../../lib/formatBytes";
import { useT, type TranslationKey } from "../../lib/i18n";
import type { BundleInfo, ImportBundleResult, ProjectEntry, SetInfo } from "../../types";
import { ErrorNote } from "../common/ErrorNote";
import { useBoxesStore } from "../../stores/boxes";
import { CloseIcon } from "../common/icons/Icon";

/** One member's import outcome. */
type Outcome = { member: string; name: string; result?: ImportBundleResult; error?: string };

/** A member can be imported: it was read, and its host folder is not
 *  already a project here. */
export function memberImportable(info: BundleInfo | undefined): info is BundleInfo {
  return !!info && !info.siteConflict;
}

/**
 * The project-set half of "Import Project File": the file picked in
 * `ProjectImportBundleDialog` turned out to hold several projects
 * (`commands::project_transfer::set`). Each ticked one runs the very same
 * single-project import, one after the other, so a project that fails is
 * named and the rest still land. Local projects land in one folder, the
 * remote ones' working copies in another; each keeps its own name (a clash
 * gets a `-2` folder, as in the single import).
 */
export function ProjectSetImportDialog({
  set,
  onClose,
  onProject,
}: {
  set: SetInfo;
  onClose: () => void;
  onProject: (project: ProjectEntry) => void;
}) {
  const t = useT();
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(set.members.filter((m) => memberImportable(m.info)).map((m) => m.member)),
  );
  const [parent, setParent] = useState(set.suggestedParent);
  const [mirrorParent, setMirrorParent] = useState(set.suggestedMirrorParent);
  const [picking, setPicking] = useState<"local" | "mirror" | null>(null);
  const [restoreSession, setRestoreSession] = useState(true);
  const [restoreTime, setRestoreTime] = useState(true);
  const [joinBoxes, setJoinBoxes] = useState(true);
  const [restoreAgentHistory, setRestoreAgentHistory] = useState(true);
  const [busy, setBusy] = useState(false);
  const [current, setCurrent] = useState("");
  const [error, setError] = useState("");
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null);
  const modalRef = useModalFocus(() => {
    if (!busy) onClose();
  });

  const chosen = useMemo(
    () => set.members.filter((m) => picked.has(m.member) && memberImportable(m.info)),
    [set.members, picked],
  );
  const anyLocal = chosen.some((m) => !m.info!.remote);
  const anyMirror = chosen.some((m) => m.info!.remote && !m.info!.remoteOnly);
  const anyAgents = chosen.some((m) => m.info!.contents.agentHistory);
  const anyBoxes = chosen.some((m) => m.info!.boxNames.length > 0);
  const anyRemote = chosen.some((m) => m.info!.remote);

  const toggle = (member: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(member)) next.delete(member);
      else next.add(member);
      return next;
    });

  const runImport = async () => {
    setBusy(true);
    setError("");
    const done: Outcome[] = [];
    let joined = false;
    for (const m of chosen) {
      const info = m.info!;
      setCurrent(info.name);
      try {
        const result = await invoke<ImportBundleResult>("import_project_export", {
          req: {
            bundlePath: set.path,
            member: m.member,
            name: null,
            targetParent: parent.trim() || null,
            mirrorParent: info.remote && !info.remoteOnly ? mirrorParent.trim() || null : null,
            restoreSession,
            restoreTime,
            joinBoxes,
            restoreAgentHistory,
          },
        });
        done.push({ member: m.member, name: info.name, result });
        onProject(result.entry);
        if (result.boxesJoined.length > 0) joined = true;
      } catch (e) {
        done.push({ member: m.member, name: info.name, error: String(e) });
      }
    }
    // Joining boxes wrote `boxes.json` behind the store's back: reload it, or
    // the store's next whole-list box save is refused as stale.
    if (joined) void useBoxesStore.getState().load();
    setOutcomes(done);
    setCurrent("");
    setBusy(false);
  };

  /** Notes worth saying once for the whole set, in first-seen order. */
  const notes = useMemo(() => {
    const seen = new Set<string>();
    for (const o of outcomes ?? []) for (const n of o.result?.notes ?? []) seen.add(n);
    return [...seen];
  }, [outcomes]);

  const memberLine = (info: BundleInfo): string => {
    const files =
      info.contents.files > 0
        ? t("transfer.bundleFiles", {
            count: String(info.contents.files),
            size: formatBytes(info.contents.bytes),
          })
        : t("transfer.set.settingsOnly");
    return info.remote ? `${files} · ${t("transfer.set.remoteTag")}` : files;
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div
        ref={modalRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t("transfer.set.importTitle")}
        className="project-dialog dialog-framed"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="settings-title-row">
          <h2>
            {t("transfer.set.importTitle")} <UntestedTag id="transfer.importSet" />
          </h2>
          <button aria-label={t("common.close")} type="button" className="dialog-close-btn" onClick={onClose} disabled={busy}>
            <CloseIcon />
          </button>
        </div>

        <div className="dialog-scroll">
          <p className="project-dialog-path">{set.path}</p>
          <p className="settings-help">
            {t("transfer.set.summary", {
              count: String(set.members.length),
              date: set.exportedAt.slice(0, 10),
              version: set.appVersion,
            })}
          </p>

          {!outcomes && (
            <>
              <div className="big-folder-list">
                {set.members.map((m) => {
                  const info = m.info;
                  const blocked = !memberImportable(info);
                  const why = !info
                    ? m.error ?? ""
                    : info.siteConflict
                      ? t("transfer.siteConflict", { name: info.siteConflict })
                      : info.idInUse
                        ? `${memberLine(info)} · ${t("transfer.set.newId")}`
                        : memberLine(info);
                  return (
                    <label key={m.member} className="big-folder-row transfer-rebuildable-row">
                      <input
                        type="checkbox"
                        checked={!blocked && picked.has(m.member)}
                        disabled={blocked || busy}
                        aria-label={info?.name ?? m.member}
                        onChange={() => toggle(m.member)}
                      />
                      <span className="big-folder-path" title={info?.name ?? m.member}>
                        {info?.name ?? m.member}
                      </span>
                      <span
                        className={blocked ? "big-folder-files project-dialog-error" : "big-folder-files"}
                        title={why}
                      >
                        {why}
                      </span>
                    </label>
                  );
                })}
              </div>

              {anyLocal && (
                <>
                  <label>
                    {t("transfer.set.importLocation")}
                    <input type="text" value={parent} onChange={(e) => setParent(e.target.value)} spellCheck={false} />
                  </label>
                  <div className="project-dialog-actions dialog-actions-start">
                    <button type="button" onClick={() => setPicking("local")} disabled={busy}>
                      {t("transfer.browseEllipsis")}
                    </button>
                  </div>
                </>
              )}
              {anyMirror && (
                <>
                  <label>
                    {t("transfer.set.mirrorLocation")}
                    <input
                      type="text"
                      value={mirrorParent}
                      onChange={(e) => setMirrorParent(e.target.value)}
                      spellCheck={false}
                    />
                  </label>
                  <div className="project-dialog-actions dialog-actions-start">
                    <button type="button" onClick={() => setPicking("mirror")} disabled={busy}>
                      {t("transfer.browseEllipsis")}
                    </button>
                  </div>
                </>
              )}

              <label className="container-settings-toggle">
                <span>
                  {t("transfer.restoreSession")}
                  <span className="settings-help">{t("transfer.set.restoreSessionHelp")}</span>
                </span>
                <Toggle
                  checked={restoreSession}
                  aria-label={t("transfer.restoreSession")}
                  onChange={(e) => setRestoreSession(e.target.checked)}
                  size="sm"
                />
              </label>
              <label className="container-settings-toggle">
                <span>{t("transfer.restoreTime")}</span>
                <Toggle
                  checked={restoreTime}
                  aria-label={t("transfer.restoreTime")}
                  onChange={(e) => setRestoreTime(e.target.checked)}
                  size="sm"
                />
              </label>
              {anyAgents && (
                <label className="container-settings-toggle">
                  <span>
                    {t("transfer.restoreAgentHistory")}
                    <span className="settings-help">{t("transfer.restoreAgentHistoryHelp")}</span>
                  </span>
                  <Toggle
                    checked={restoreAgentHistory}
                    aria-label={t("transfer.restoreAgentHistory")}
                    onChange={(e) => setRestoreAgentHistory(e.target.checked)}
                    size="sm"
                  />
                </label>
              )}
              {anyBoxes && (
                <label className="container-settings-toggle">
                  <span>{t("transfer.joinBoxes")}</span>
                  <Toggle
                    checked={joinBoxes}
                    aria-label={t("transfer.joinBoxes")}
                    onChange={(e) => setJoinBoxes(e.target.checked)}
                    size="sm"
                  />
                </label>
              )}
              {anyRemote && <p className="settings-help">{t("transfer.note.remoteCredentials")}</p>}
              {busy && current && (
                <p className="settings-help">{t("transfer.set.importingOne", { name: current })}</p>
              )}
            </>
          )}

          {outcomes && (
            <>
              <p className="settings-help">
                {t("transfer.set.importDone", {
                  count: String(outcomes.filter((o) => o.result).length),
                  total: String(outcomes.length),
                })}
              </p>
              <div className="big-folder-list">
                {outcomes.map((o) => (
                  <div key={o.member} className="big-folder-row transfer-rebuildable-row">
                    <span>{o.result ? "✓" : "✗"}</span>
                    <span className="big-folder-path" title={o.result?.directory ?? o.name}>
                      {o.result?.entry.name ?? o.name}
                    </span>
                    <span
                      className={o.error ? "big-folder-files project-dialog-error" : "big-folder-files"}
                      title={o.error ?? o.result?.directory}
                    >
                      {o.result ? t("transfer.set.memberFiles", { count: String(o.result.files) }) : o.error}
                    </span>
                  </div>
                ))}
              </div>
              {notes.map((note) => (
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
              {outcomes ? t("common.close") : t("common.cancel")}
            </button>
            {!outcomes && (
              <button type="button" onClick={() => void runImport()} disabled={busy || chosen.length === 0}>
                {busy
                  ? t("transfer.importing")
                  : t("transfer.set.importCount", { count: String(chosen.length) })}
              </button>
            )}
          </div>
        </div>
      </div>

      {picking && (
        <FolderPickerDialog
          initialPath={(picking === "local" ? parent : mirrorParent) || undefined}
          title={t("transfer.set.pickLocationTitle")}
          confirmLabel={t("transfer.useThisFolder")}
          allowCreateFolder
          onConfirm={(dir) => {
            if (picking === "local") setParent(dir);
            else setMirrorParent(dir);
            setPicking(null);
          }}
          onClose={() => setPicking(null)}
        />
      )}
    </div>,
    document.body,
  );
}
