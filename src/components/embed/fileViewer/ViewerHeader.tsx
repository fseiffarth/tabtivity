import { createContext, useContext, useMemo } from "react";
import { useProjectsStore } from "../../../stores/projects";
import { useRemoteStatusStore } from "../../../stores/remote/remoteStatus";
import { relFromAbs } from "../../../lib/viewers/fileUtils";
import { FileSourceSwitch } from "../../files/ProjectFilesPane";
import { basename, dirname, resolvePath } from "../../../lib/paths";
import { resolveProjectDirectory, resolveLocalMirror } from "../../../types";
import { useSyncStore } from "../../../stores/remote/sync";
import { useT } from "../../../lib/i18n";
import { ArrowUpRightIcon } from "../../common/icons/Icon";
import { openLinkedFile } from "./openLinked";

/** The file identity a `ViewerHeader` needs to offer file-scoped actions (the
 *  auto-sync toggle, the Local/Remote source switch) without every sub-viewer
 *  threading these props through. Set by `FileViewerPane`; `null` outside a
 *  viewer pane. `sourceSwitch` is `null` unless the open file resolves to a rel
 *  path under a remote project's mirror or host root (i.e. the other side could
 *  exist too). */
export const ViewerHeaderInfoContext = createContext<{
  path: string;
  projectId: string | null;
  sourceSwitch?: {
    current: "local" | "remote";
    onChange: (s: "local" | "remote") => void;
    remoteDisabled?: boolean;
  } | null;
} | null>(null);

/** A remote project's local-mirror root, or `null` for a local project / one
 *  with no resolvable mirror. Shared by `autoSyncRel` and the Local/Remote
 *  switch's path-building — both need the exact same root. */
export function localMirrorRootFor(
  project: ReturnType<typeof useProjectsStore.getState>["projects"][number] | undefined,
): string | null {
  if (!project?.remote) return null;
  const projectDir = resolveProjectDirectory(project);
  return resolveLocalMirror(project) ?? (projectDir ? `${projectDir}/mirror` : null);
}

/**
 * Resolve `absPath` to the project-relative path the sync backend keys on, for a
 * REMOTE project only (auto-sync doesn't apply to local projects). Handles both a
 * local-mirror file (under the mirror root) and a remote-native file (under the
 * host `remote_path`). Returns `null` when the project isn't remote or the path
 * lies outside both roots (so the toggle simply hides).
 */
export function autoSyncRel(
  project: ReturnType<typeof useProjectsStore.getState>["projects"][number] | undefined,
  absPath: string,
): string | null {
  if (!project?.remote) return null;
  const mirrorRoot = localMirrorRootFor(project);
  if (mirrorRoot) {
    const r = relFromAbs(mirrorRoot, absPath);
    if (r) return r;
  }
  const r2 = relFromAbs(project.remote.remote_path, absPath);
  return r2 || null;
}

/**
 * Auto-sync indicator + toggle for the viewer header. Shown only for a file that
 * belongs to a remote project (either its mirror copy or its host copy). Reflects
 * and flips `SyncEntry::auto_sync` via the sync store; disabled while the remote is
 * disconnected (the backend engine can't act until reconnected).
 */
function AutoSyncHeaderToggle({ path, projectId }: { path: string; projectId: string | null }) {
  const t = useT();
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId));
  const rel = useMemo(() => autoSyncRel(project, path), [project, path]);
  const auto = useSyncStore((s) =>
    projectId && rel ? !!s.byProject[projectId]?.[rel]?.auto : false,
  );
  const setAuto = useSyncStore((s) => s.setAuto);
  const sshState = useRemoteStatusStore((s) => (projectId ? s.byProject[projectId]?.ssh : undefined));
  if (!project?.remote || !rel || !projectId) return null;
  const connected = sshState === "connected";
  return (
    <button
      type="button"
      className={`file-viewer-autosync${auto ? " on" : ""}`}
      title={
        !connected
          ? t("fileViewer.autoSyncConnectFirst")
          : auto
            ? t("fileViewer.autoSyncOnHint")
            : t("fileTree.autoSyncFile")
      }
      aria-label={auto ? t("fileViewer.stopAutoSyncFile") : t("fileTree.autoSyncFile")}
      aria-pressed={auto}
      disabled={!connected}
      onClick={() => void setAuto(projectId, [rel], !auto, false)}
    >
      ⟳
    </button>
  );
}

/**
 * "Resolve divergence" button for the viewer header, shown only when the open
 * file is currently **diverged (amber)** for a remote project. Opens the exact
 * same three-way merge resolver (`syncmerge` → `SyncMergeView`/`CompareView`) the
 * orange list opens, so the user can reconcile local mirror ⇄ host from the file
 * they are already looking at instead of hunting it down in the Orange view.
 *
 * The resolver keys on the **mirror-side** path (`mirrorRoot/rel`), exactly as the
 * orange list builds it, regardless of which side this viewer is currently showing.
 */
function SyncResolveHeaderButton({ path, projectId }: { path: string; projectId: string | null }) {
  const t = useT();
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId));
  const rel = useMemo(() => autoSyncRel(project, path), [project, path]);
  const mirrorRoot = useMemo(() => localMirrorRootFor(project), [project]);
  const amber = useSyncStore((s) =>
    projectId && rel ? s.byProject[projectId]?.[rel]?.state === "amber" : false,
  );
  if (!project?.remote || !rel || !projectId || !mirrorRoot || !amber) return null;
  const mirrorPath = resolvePath(mirrorRoot, rel);
  return (
    <button
      type="button"
      className="file-viewer-resolve"
      title={t("fileViewer.resolveDivergenceTitle")}
      aria-label={t("fileViewer.resolveDivergence")}
      onClick={() =>
        openLinkedFile(undefined, dirname(mirrorPath), {
          path: mirrorPath,
          viewer: "syncmerge",
          label: basename(mirrorPath),
        })
      }
    >
      ±
    </button>
  );
}

export function ViewerHeader({
  onOpenExternally,
  children,
}: {
  onOpenExternally: () => void;
  children?: React.ReactNode;
}) {
  // No filename label: the tab already shows it. The spacer keeps the controls
  // and the open-externally icon pushed to the trailing edge. The remote/local
  // source badge no longer lives here — it rides on the tab itself (see
  // TabBar's tab-source badge), so it costs no header row. The auto-sync toggle
  // and the Local/Remote source switch (both remote projects only) ride in from
  // context so no sub-viewer has to pass them.
  const t = useT();
  const info = useContext(ViewerHeaderInfoContext);
  return (
    <div className="file-viewer-header">
      <div className="file-viewer-header-spacer" aria-hidden="true" />
      {children}
      {info?.sourceSwitch && (
        <FileSourceSwitch
          source={info.sourceSwitch.current}
          onChange={info.sourceSwitch.onChange}
          remoteDisabled={info.sourceSwitch.remoteDisabled}
        />
      )}
      {info && <SyncResolveHeaderButton path={info.path} projectId={info.projectId} />}
      {info && <AutoSyncHeaderToggle path={info.path} projectId={info.projectId} />}
      <button
        className="file-viewer-open-external"
        onClick={onOpenExternally}
        title={t("pdfViewer.openExternalTitle")}
        aria-label={t("pdfViewer.openExternalTitle")}
      >
        <ArrowUpRightIcon />
      </button>
    </div>
  );
}
