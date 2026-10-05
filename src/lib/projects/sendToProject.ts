/**
 * "Send to project" memory (the file-tree right-click → copy a file into another
 * project). Remembers the last destination — which project, and which folder
 * inside it — so the next send opens on the same place. A frontend-only
 * preference (localStorage), not a backend setting: it steers a dialog, never a
 * transfer, so a stale value is harmless (the folder is re-listed on open and
 * falls back to the project root if it has since been deleted).
 */

import { storageKey } from "../brand";

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
