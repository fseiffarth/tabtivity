/**
 * "Send to project" memory (the file-tree right-click → copy a file into another
 * project). Remembers the last destination — which project, and which folder
 * inside it — so the next send opens on the same place. A frontend-only
 * preference (localStorage), not a backend setting: it steers a dialog, never a
 * transfer, so a stale value is harmless (the folder is re-listed on open and
 * falls back to the project root if it has since been deleted).
 */

import { storageKey } from "../brand";
import { isHostPinned } from "../projectTabHost";
import { formatRemoteTarget, resolveLocalMirror, resolveProjectDirectory, type ProjectEntry } from "../../types";

const LAST_KEY = storageKey("sendToProject.last");

/** The remembered destination: a project id plus a project-relative folder
 *  (`""` = the project root). */
export interface SendTarget {
  projectId: string;
  destRel: string;
}

/** The last place a file was sent, or `null` when nothing has been sent yet (or
 *  the stored value is unreadable/malformed — treated the same as "no memory"). */
export function loadLastSendTarget(): SendTarget | null {
  try {
    const raw = localStorage.getItem(LAST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as SendTarget).projectId === "string" &&
      typeof (parsed as SendTarget).destRel === "string"
    ) {
      return { projectId: (parsed as SendTarget).projectId, destRel: (parsed as SendTarget).destRel };
    }
  } catch {
    /* ignore storage / parse failures — behave as "no memory" */
  }
  return null;
}

/** Persist the destination of a successful send, so the next one starts here. */
export function saveLastSendTarget(target: SendTarget): void {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(target));
  } catch {
    /* ignore storage failures — the memory is a convenience, not a guarantee */
  }
}

/** The destination root a project is browsed and copied into, or `""` when it
 *  has none (shown disabled). A local project is its own directory. A
 *  remote-only project (or VM) has no local copy: its stored `directory` is
 *  what `list_dir` and `import_external_file` resolve to its host, so the
 *  browse and the copy run there over SFTP. Any other remote project is
 *  copied into its local mirror, or nowhere when it has none. */
export function destRootFor(project: ProjectEntry): string {
  if (isHostPinned(project)) return resolveProjectDirectory(project);
  if (project.remote) return resolveLocalMirror(project) ?? "";
  return resolveProjectDirectory(project);
}

/** Where a project row says the copy goes: the host location for a
 *  remote-only project, else the local folder. */
export function destLabelFor(project: ProjectEntry): string {
  if (isHostPinned(project) && project.remote) return formatRemoteTarget(project.remote);
  return destRootFor(project);
}
