import type { ProjectEntry } from "../../types";
import { resolveProjectDirectory, resolveLocalMirror } from "../../types";
import { relFromAbs } from "../viewers/fileUtils";
import { resolvePath } from "../paths";
import { isHostPinned } from "../projectTabHost";

/** A remote project's local-mirror root, or `null` for a local project / one
 *  with no mirror. Shared by the viewer header (auto-sync rel) and the source
 *  switch's path-building — both need the exact same root. A host-pinned
 *  project (VM, remote-only) has no mirror at all, so it answers `null` too
 *  rather than the default `<state dir>/mirror` path nothing ever fills. */
export function localMirrorRootFor(project: ProjectEntry | null | undefined): string | null {
  if (!project?.remote || isHostPinned(project)) return null;
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
export function autoSyncRel(project: ProjectEntry | null | undefined, absPath: string): string | null {
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
 * The same file seen from the other side of a remote project: the host path for
 * a mirror path, the mirror path for a host path — and which side `absPath`
 * itself is on. `null` when the project is not a remote one with a mirror
 * (local, host-pinned) or the path lies under neither root. The mirror root is
 * tried first, as `autoSyncRel` does, so the two always agree on the side.
 */
export function otherSidePath(
  project: ProjectEntry | null | undefined,
  absPath: string,
): { side: "local" | "remote"; twin: string } | null {
  if (!project?.remote) return null;
  const mirrorRoot = localMirrorRootFor(project);
  if (!mirrorRoot) return null;
  const hostRoot = project.remote.remote_path;
  const fromMirror = relFromAbs(mirrorRoot, absPath);
  const found = fromMirror
    ? { side: "local" as const, twin: resolvePath(hostRoot, fromMirror) }
    : (() => {
        const fromHost = relFromAbs(hostRoot, absPath);
        return fromHost ? { side: "remote" as const, twin: resolvePath(mirrorRoot, fromHost) } : null;
      })();
  // A mirror at the host path's own spelling has no distinct other side.
  return found && found.twin !== absPath ? found : null;
}
