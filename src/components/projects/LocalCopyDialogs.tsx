// The two Remote ⇄ Remote-only conversions behind the pill's Edit group
// (`docs/remote_only_projects_plan.md` E8/F9): "Stop keeping a local copy…"
// previews what only the mirror holds and refuses while anything does; "Keep a
// local copy…" records a folder and hands pairing to git lockstep, host
// authoritative. Both run only while the project is connected and never on a VM
// project (the pill hides them there; the backend refuses anyway).

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { BRAND } from "../../lib/brand";
import { formatBytes } from "../../lib/formatBytes";
import { useT } from "../../lib/i18n";
import { remoteOnlyRefusal } from "../../lib/projectTabHost";
import { useProjectsStore } from "../../stores/projects";
import { effectiveTabLocation, useTabsStore } from "../../stores/tabs";
import { isLocatableKind } from "../../stores/tabs/tabLocation";
import type { ProjectEntry, UnpairOutcome, UnpairPreview } from "../../types";
import { ErrorNote } from "../common/ErrorNote";
import { AsyncConfirmDialog } from "../common/PromptDialogs";

/** The backend's "the mirror changed since the preview" refusal. */
const MIRROR_CHANGED = `${BRAND.upper}_MIRROR_CHANGED:`;

function errorText(err: unknown): string {
  return remoteOnlyRefusal(err) ?? (err instanceof Error ? err.message : String(err));
}

/** Whether a preview leaves anything that lives only in the mirror. */
export function unpairBlocked(p: UnpairPreview): boolean {
  return p.commitsNotOnHost > 0 || p.uncommitted > 0 || p.unpushedSyncEdits > 0 || p.localTabs > 0;
}

/** Remote → Remote-only. `onDone` gets the outcome (the kept folder) once the
 *  conversion landed; the dialog has closed by then. */
export function StopLocalCopyDialog({
  project,
  onClose,
  onDone,
}: {
  project: ProjectEntry;
  onClose: () => void;
  onDone: (outcome: UnpairOutcome) => void;
}) {
  const t = useT();
  const stopKeepingLocalCopy = useProjectsStore((s) => s.stopKeepingLocalCopy);
  const [preview, setPreview] = useState<UnpairPreview | null>(null);
  const [previewError, setPreviewError] = useState("");
  // The backend counts the saved layout; a tab opened a moment ago may not be
  // saved yet, so this window's own live tabs count too (the larger wins).
  const liveLocalTabs = useTabsStore(
    (s) =>
      (s.tabsByScope[project.id] ?? []).filter(
        (tab) =>
          (isLocatableKind(tab.kind) || tab.kind === "local_agent") && effectiveTabLocation(tab) === "local",
      ).length,
  );

  const load = useCallback(async (): Promise<UnpairPreview | null> => {
    try {
      const p = await invoke<UnpairPreview>("remote_unpair_mirror_preview", { projectId: project.id });
      setPreview(p);
      setPreviewError("");
      return p;
    } catch (err) {
      setPreview(null);
      setPreviewError(errorText(err));
      return null;
    }
  }, [project.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const confirm = async () => {
    if (!preview) return;
    try {
      const outcome = await stopKeepingLocalCopy(project.id, preview.fingerprint);
      onDone(outcome);
    } catch (err) {
      if (String(err).includes(MIRROR_CHANGED)) {
        // Fresh numbers in the body; the user confirms again against them.
        await load();
        throw new Error(t("pill.stopLocalCopyChanged"));
      }
      throw new Error(errorText(err));
    }
  };

  const shown = preview ? { ...preview, localTabs: Math.max(preview.localTabs, liveLocalTabs) } : null;
  const blocked = shown ? unpairBlocked(shown) : true;
  return (
    <AsyncConfirmDialog
      title={t("pill.stopLocalCopyTitle", { name: project.name })}
      confirmLabel={t("pill.stopLocalCopyConfirm")}
      busyLabel={t("pill.stopLocalCopyBusy")}
      danger
      armed={!!shown && !blocked}
      autoFocusConfirm={false}
      onConfirm={confirm}
      onClose={onClose}
    >
      {!shown && !previewError && <p className="settings-help">{t("pill.stopLocalCopyChecking")}</p>}
      {previewError && <ErrorNote className="project-dialog-error" error={previewError} />}
      {shown && (
        <div data-testid="stop-local-copy-preview">
          {blocked && (
            <>
              <ul className="settings-help">
                {shown.commitsNotOnHost > 0 && (
                  <li>{t("pill.stopLocalCopyCommits", { count: shown.commitsNotOnHost })}</li>
                )}
                {shown.uncommitted > 0 && (
                  <li>{t("pill.stopLocalCopyUncommitted", { count: shown.uncommitted })}</li>
                )}
                {shown.unpushedSyncEdits > 0 && (
                  <li>{t("pill.stopLocalCopySyncEdits", { count: shown.unpushedSyncEdits })}</li>
                )}
                {shown.localTabs > 0 && (
                  <li>{t("pill.stopLocalCopyLocalTabs", { count: shown.localTabs })}</li>
                )}
              </ul>
              <p className="settings-help">
                <strong>{t("pill.stopLocalCopyBlocked")}</strong>
              </p>
            </>
          )}
          <p className="settings-help">{t("pill.stopLocalCopyAfter")}</p>
          {shown.keptAt ? (
            <p className="settings-help">
              {t(shown.moves ? "pill.stopLocalCopyKeptMoved" : "pill.stopLocalCopyKeptStays")}{" "}
              <code data-testid="stop-local-copy-kept">{shown.keptAt}</code>
            </p>
          ) : (
            <p className="settings-help">{t("pill.stopLocalCopyNoFolder")}</p>
          )}
          {shown.stoppedWorkers.length > 0 && (
            <p className="settings-help">
              {t("pill.stopLocalCopyWorkers", { names: shown.stoppedWorkers.join(", ") })}
            </p>
          )}
        </div>
      )}
    </AsyncConfirmDialog>
  );
}

/** Remote-only → Remote: pick a folder (the suggested `projects-ssh/<name>` by
 *  default), record it, then turn lockstep on so the host's history pairs in. */
export function KeepLocalCopyDialog({
  project,
  onClose,
}: {
  project: ProjectEntry;
  onClose: () => void;
}) {
  const t = useT();
  const keepLocalCopy = useProjectsStore((s) => s.keepLocalCopy);
  const [folder, setFolder] = useState("");
  const [size, setSize] = useState<{ files: number; bytes: number } | null>(null);
  const [loadError, setLoadError] = useState("");
  const usesGit = project.git_type !== "none";

  useEffect(() => {
    let live = true;
    void invoke<{ suggested: string }>("remote_mirror_status", { projectId: project.id, name: project.name })
      .then((s) => {
        if (live) setFolder((f) => f || s.suggested);
      })
      .catch((err) => {
        if (live) setLoadError(errorText(err));
      });
    // The user-asked size of what pairing may bring over (an upper bound: the
    // host folder, untracked files included), like Download to…'s confirm.
    void invoke<{ files: number; bytes: number }>("remote_download_size", { projectId: project.id, relPath: "" })
      .then((s) => {
        if (live) setSize(s);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [project.id, project.name]);

  const choose = async () => {
    const chosen = await open({
      directory: true,
      defaultPath: folder || undefined,
      title: t("pill.keepLocalCopyChooseTitle", { name: project.name }),
    });
    if (typeof chosen === "string") setFolder(chosen);
  };

  const confirm = async () => {
    try {
      await keepLocalCopy(project.id, folder);
    } catch (err) {
      throw new Error(errorText(err));
    }
    // Pairing is the existing lockstep flow: a conflict there names its files
    // and asks in the git panel, as for any newly paired project.
    if (usesGit) {
      await invoke("git_peer_set_enabled", { projectId: project.id, enabled: true });
    }
  };

  return (
    <AsyncConfirmDialog
      title={t("pill.keepLocalCopyTitle", { name: project.name })}
      confirmLabel={t("pill.keepLocalCopyConfirm")}
      busyLabel={t("pill.keepLocalCopyBusy")}
      armed={!!folder}
      onConfirm={confirm}
      onClose={onClose}
    >
      {loadError && <ErrorNote className="project-dialog-error" error={loadError} />}
      <p className="settings-help">
        {t("pill.keepLocalCopyFolder")} <code data-testid="keep-local-copy-folder">{folder}</code>{" "}
        <button type="button" onClick={() => void choose()}>
          {t("pill.keepLocalCopyChoose")}
        </button>
      </p>
      <p className="settings-help">
        {size
          ? t("pill.keepLocalCopySize", { files: size.files, size: formatBytes(size.bytes) })
          : t("pill.keepLocalCopySizeChecking")}
      </p>
      <p className="settings-help">{t(usesGit ? "pill.keepLocalCopyHow" : "pill.keepLocalCopyNoGit")}</p>
    </AsyncConfirmDialog>
  );
}
