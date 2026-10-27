import { useEffect, useState } from "react";
import { ProjectFilesView } from "./ProjectFilesView";
import { useIndependentFileSource } from "./ProjectFilesPane";
import { useProjectsStore } from "../../stores/projects";
import { useTabsStore } from "../../stores/tabs";
import { BOX_SCOPE_PREFIX } from "../../stores/boxes";
import { resolveProjectDirectory, type ProjectEntry } from "../../types";
import { useT } from "../../lib/i18n";
import { openProjectFilesTab } from "../../lib/tabs/openProjectFilesTab";

/**
 * The "Files (Project)" tab: the side panel's file viewer, hosted in a tab.
 * Everything visible — the view switcher, git bar + history, search, apps,
 * orange list, tree, drag-and-drop, sync overlay, type tags, source switch and
 * settings — comes from the shared `ProjectFilesView`, the same component
 * `SidePanel` renders, so the tab can never drift from the panel. This host
 * owns only what must differ: it resolves the project from its own `scope`
 * (rather than the active project) and keeps the browsed folder on the *tab*
 * (`TabEntry.folder`, persisted), which is what makes "Open in a new tab" on a
 * folder mean anything after a restart. It passes none of the panel-only window
 * chrome (pin, resize border, hidden-subwindows) — a tab has none.
 */
interface Props {
  /** The tab's scope: a project id, a `box:<id>` scope, or "root". */
  scope: string;
  /** The tab's cwd — the tree root when the scope has no project (root scope). */
  cwd: string;
  /** This tab's key, so its browsed folder persists onto the tab. */
  tabKey?: string;
  /** The folder the tab was opened on / last left at. */
  folder?: string;
  /** Override where a folder change is persisted. The docked subwindow viewer
   *  passes this to route the browsed folder onto its group NODE
   *  (`GroupNode.filesFolder`) instead of a tab; when omitted, a folder change
   *  persists onto `tabKey`'s `TabEntry.folder` as before. */
  persistFolder?: (folder: string) => void;
  /** Whether this window owns the tab store (the main window does; a popout runs
   *  on a streamed copy). Gates the tree's "Open in a new tab" action. */
  canOpenTabs?: boolean;
  /** Whether this tab is the visible one in its group. Gates the git/windows
   *  probes so a background tab doesn't churn — its tree stays mounted regardless. */
  visible?: boolean;
  /** Compact mode: strip the header + view-switcher toolbar + sync/sort rows so
   *  the find-files search is topmost. Set by the docked subwindow viewer only. */
  compact?: boolean;
  /** Stable identity for THIS viewer instance, so its own Local/Remote choice
   *  survives a remount (`useIndependentFileSource`). The docked column passes
   *  its group id — it is remounted by `key={scope}` on every scope switch, and
   *  a choice held in component state came back re-seeded from the project-wide
   *  one. Falls back to the tab key; a viewer with neither keeps its choice only
   *  as long as it stays mounted. */
  viewerId?: string;
  /** A project to fall back to when the projects store can't resolve `scope` — a
   *  detached popout is inert to that store, so it streams the owning project in
   *  its seed and hands it here. Without it a remote project's viewer resolves no
   *  project and its Local/Remote source switch + run-host picker (gated on
   *  `project.remote`) never render. Ignored when the store already has the
   *  project (the main window), so the store stays authoritative there. */
  injectedProject?: ProjectEntry | null;
}

export function ProjectFilesTab({
  scope,
  cwd,
  tabKey,
  folder: initialFolder,
  canOpenTabs,
  visible,
  compact,
  persistFolder,
  viewerId,
  injectedProject,
}: Props) {
  const t = useT();
  const projects = useProjectsStore((s) => s.projects);
  // Prefer the store (authoritative in the main window); fall back to the streamed
  // project a detached popout injects, which is inert to the projects store. In a
  // BOX scope (`box:<id>`) a "Files — ⟨member⟩" tab carries the member's root as
  // its cwd, so the member is resolved by that root — the tab then gets the
  // member's full identity (git bar, remote switch) inside the box scope.
  const project =
    projects.find((p) => p.id === scope) ??
    (scope.startsWith(BOX_SCOPE_PREFIX)
      ? projects.find((p) => resolveProjectDirectory(p) === cwd)
      : null) ??
    injectedProject ??
    null;
  const projectDir = project ? resolveProjectDirectory(project) : cwd;

  // The browsed folder is meaningless without the root it is relative to, so it
  // is held WITH that identity and dropped the moment the identity changes — a
  // project switch in a host that reuses this instance (the docked subwindow
  // sidebar; a popout whose group re-roots on its active tab), or a project
  // whose directory moved. Deriving it during render rather than resetting it in
  // an effect is load-bearing: child effects run BEFORE the parent's, so an
  // effect-based reset would let `FileTree` fire one listing at the previous
  // project's rel path — and that listing, having succeeded, is the one that
  // sticks (its reload is not re-run for a mere prop change).
  const identity = `${scope}\u0000${projectDir}`;
  const [held, setHeld] = useState({ identity, folder: initialFolder ?? "" });
  const folder = held.identity === identity ? held.folder : (initialFolder ?? "");
  const [source, setSource] = useIndependentFileSource(
    project?.id ?? null,
    !!project?.remote,
    viewerId ?? (tabKey ? `tab:${tabKey}` : undefined),
  );

  // Re-seed when the identity changes (above is the same frame's answer; this
  // commits it) or when the persisted folder changes out from under us — a
  // restart restore or a popout's streamed `files` edit hands a new browsed
  // folder that must win over local state. In steady state the persisted value
  // tracks `folder`, so this is a no-op except on those external updates.
  useEffect(() => {
    setHeld({ identity, folder: initialFolder ?? "" });
  }, [identity, initialFolder]);

  const onFolderChange = (next: string) => {
    setHeld({ identity, folder: next });
    // Persist so it reopens where it was left (debounced by the store's own
    // saveLayout): the docked viewer routes onto its group node (persistFolder),
    // a tab onto its own TabEntry.folder.
    if (persistFolder) persistFolder(next);
    else if (tabKey) useTabsStore.getState().setTabFolder(tabKey, next);
  };

  if (!projectDir) {
    return <div className="file-tree-empty">{t("common.noProjectSelected")}</div>;
  }

  return (
    <ProjectFilesView
      scope={scope}
      projectId={project?.id ?? null}
      project={project}
      projectDir={projectDir}
      folder={folder}
      onFolderChange={onFolderChange}
      source={source}
      setSource={setSource}
      // The tab keeps its tree (and fs-watch) mounted even in the background, but
      // must not run git/windows probes off-screen.
      active={visible ?? true}
      mountTree
      onOpenFolderTab={canOpenTabs ? (rel) => openProjectFilesTab(t, projectDir, rel, scope) : undefined}
      containerClassName="project-files-tab"
      compact={compact}
      downloadsHost={compact ? undefined : "fileViewer"}
    />
  );
}
