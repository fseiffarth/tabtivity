import { useModalFocus } from "../../hooks/useModalFocus";
import { useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useProjectsStore } from "../../stores/projects";
import { resolveProjectDirectory, resolveLocalMirror, type ProjectEntry } from "../../types";
import { type FileEntry } from "../../lib/viewers/fileUtils";
import { loadLastSendTarget, saveLastSendTarget } from "../../lib/projects/sendToProject";
import { useT } from "../../lib/i18n";
import { ArrowLeftIcon, ArrowUpIcon, FolderIcon, GlobeIcon } from "../common/icons/Icon";
import { ErrorNote } from "../common/ErrorNote";

/** The item being sent — always a LOCAL absolute path (the dialog is only opened
 *  for local file-tree rows, so `import_external_file` can read it as an ordinary
 *  filesystem source). */
export interface SendSource {
  path: string;
  name: string;
  isDir: boolean;
}

interface Props {
  source: SendSource;
  /** The project the file is being sent FROM. Not excluded from the list — a copy
   *  into another folder of the same project is valid — but the source project's
   *  own folder is a common destination, so it's kept selectable. */
  fromProjectId?: string | null;
  onClose: () => void;
}

/** The local destination root for a project, or `""` when it has none this flow
 *  can write into. A local project is its own directory; a remote project's tree
 *  lives on the host and only its mirror is local — which this flow does not
 *  target yet (a copy into the mirror would sit un-synced), so remote projects
 *  resolve to `""` and are shown disabled. */
function destRootFor(project: ProjectEntry): string {
  if (project.remote) return resolveLocalMirror(project) ?? "";
  return resolveProjectDirectory(project);
}

/** The parent of a project-relative folder (`""` for a top-level folder). */
function parentRel(rel: string): string {
  const idx = rel.lastIndexOf("/");
  return idx < 0 ? "" : rel.slice(0, idx);
}

/**
 * "Send to project" — the file-tree right-click flow that copies a file (or
 * folder) into another project. Two steps: pick one of the active projects, then
 * browse the folders inside it (project-confined via `list_dir`, so the browse
 * cannot escape the project) and confirm. The chosen project + folder are
 * remembered for next time (`lib/projects/sendToProject`). The copy is non-destructive —
 * the source stays put and a name collision keeps both (`import_external_file`
 * appends " (n)").
 */
export function SendToProjectDialog({ source, fromProjectId, onClose }: Props) {
  const t = useT();
  const projects = useProjectsStore((s) => s.projects);
  const last = useMemo(() => loadLastSendTarget(), []);

  // Active projects (the pill strip's own definition), last-used floated to the
  // top, then alphabetical — a stable order the eye can rely on.
  const active = useMemo(() => {
    return projects
      .filter((p) => p.status !== "inactive")
      .slice()
      .sort((a, b) => {
        if (last) {
          if (a.id === last.projectId && b.id !== last.projectId) return -1;
          if (b.id === last.projectId && a.id !== last.projectId) return 1;
        }
        return a.name.localeCompare(b.name);
      });
  }, [projects, last]);

  const [phase, setPhase] = useState<"project" | "folder" | "done">("project");
  const [selected, setSelected] = useState<ProjectEntry | null>(null);
  const [rel, setRel] = useState("");
  const [listing, setListing] = useState<FileEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [finalRel, setFinalRel] = useState("");

  // Escape closes, mirroring the app's other modals.
  const modalRef = useModalFocus(onClose);

  const loadFolder = useCallback(
    (project: ProjectEntry, target: string) => {
      const dir = destRootFor(project);
      if (!dir) {
        setError(t("sendToProject.noLocalRoot"));
        return;
      }
      setLoading(true);
      setError(null);
      invoke<FileEntry[]>("list_dir", { projectDir: dir, relPath: target })
        .then((items) => {
          setListing(items.filter((i) => i.is_dir));
          setRel(target);
        })
        .catch((e) => {
          // A remembered folder can be gone by the time we send there again; fall
          // back to the project root rather than stranding the browse on an error.
          if (target !== "") {
            loadFolder(project, "");
            return;
          }
          setError(String(e));
        })
        .finally(() => setLoading(false));
    },
    [t],
  );

  const pickProject = useCallback(
    (project: ProjectEntry) => {
      setSelected(project);
      setPhase("folder");
      // Seed at the remembered folder only when re-sending to the same project.
      const seed = last && last.projectId === project.id ? last.destRel : "";
      loadFolder(project, seed);
    },
    [last, loadFolder],
  );

  const doCopy = useCallback(() => {
    if (!selected) return;
    const dir = destRootFor(selected);
    if (!dir) return;
    setBusy(true);
    setError(null);
    invoke<string>("import_external_file", {
      projectDir: dir,
      sourcePath: source.path,
      destRel: rel,
      replace: false,
    })
      .then((landed) => {
        saveLastSendTarget({ projectId: selected.id, destRel: rel });
        setFinalRel(landed);
        setPhase("done");
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  }, [selected, rel, source.path]);

  const relLabel = rel || t("sendToProject.projectRoot");

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        ref={modalRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        className="settings-dialog folder-picker-dialog send-to-project-dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="settings-title-row">
          <h2>{t("sendToProject.title")}</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>

        <div className="dialog-scroll">
          <p className="settings-help send-to-project-source" title={source.path}>
            {t("sendToProject.sourceLabel")} <strong>{source.name}</strong>
          </p>

          {phase === "project" && (
            <>
              <p className="settings-help">{t("sendToProject.pickProject")}</p>
              <div className="folder-picker-list">
                {active.length === 0 ? (
                  <p className="settings-help">{t("sendToProject.noProjects")}</p>
                ) : (
                  active.map((p) => {
                    const disabled = !destRootFor(p);
                    return (
                      <button
                        key={p.id}
                        type="button"
                        className="folder-picker-item send-to-project-item"
                        disabled={disabled}
                        title={disabled ? t("sendToProject.remoteUnsupported") : destRootFor(p)}
                        onClick={() => pickProject(p)}
                      >
                        <span className="folder-picker-icon">{p.remote ? <GlobeIcon /> : <FolderIcon />}</span>
                        <span className="folder-picker-name">{p.name}</span>
                        {p.id === fromProjectId && (
                          <span className="send-to-project-tag">{t("sendToProject.thisProject")}</span>
                        )}
                        {last?.projectId === p.id && (
                          <span className="send-to-project-tag">{t("sendToProject.lastUsed")}</span>
                        )}
                      </button>
                    );
                  })
                )}
              </div>
              {error && <ErrorNote className="settings-help folder-picker-error" as="p" error={error} />}
            </>
          )}

          {phase === "folder" && selected && (
            <>
              <div className="folder-picker-nav">
                <button
                  type="button"
                  onClick={() => setPhase("project")}
                  title={t("sendToProject.changeProject")}
                >
                  <ArrowLeftIcon /> {t("common.back")}
                </button>
                <button
                  type="button"
                  disabled={rel === ""}
                  onClick={() => loadFolder(selected, parentRel(rel))}
                  title={t("folderPicker.upOneFolder")}
                >
                  <ArrowUpIcon /> {t("folderPicker.up")}
                </button>
                <span className="folder-picker-cur" title={`${selected.name}/${rel}`}>
                  {selected.name} / {relLabel}
                </span>
              </div>

              <div className="folder-picker-list">
                {loading && !listing ? (
                  <p className="settings-help">{t("common.loading")}</p>
                ) : listing && listing.length === 0 ? (
                  <p className="settings-help">{t("folderPicker.noSubfolders")}</p>
                ) : (
                  listing?.map((entry) => (
                    <button
                      key={entry.path}
                      type="button"
                      className="folder-picker-item"
                      onClick={() => loadFolder(selected, rel ? `${rel}/${entry.name}` : entry.name)}
                      title={entry.path}
                    >
                      <span className="folder-picker-icon"><FolderIcon /></span>
                      <span className="folder-picker-name">{entry.name}</span>
                    </button>
                  ))
                )}
              </div>

              {error && <ErrorNote className="settings-help folder-picker-error" as="p" error={error} />}

              <div className="folder-picker-actions">
                <button type="button" onClick={onClose}>{t("common.cancel")}</button>
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={doCopy}
                >
                  {busy ? t("common.loading") : t("sendToProject.copyHere")}
                </button>
              </div>
            </>
          )}

          {phase === "done" && selected && (
            <>
              <div className="send-to-project-done">
                <p className="send-to-project-done-title">✓ {t("sendToProject.successTitle")}</p>
                <p className="settings-help">
                  {t("sendToProject.successBody", {
                    name: source.name,
                    dest: `${selected.name} / ${finalRel}`,
                  })}
                </p>
              </div>
              <div className="folder-picker-actions">
                <button type="button" className="primary" onClick={onClose}>
                  {t("common.close")}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
