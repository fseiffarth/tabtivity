import { invoke } from "@tauri-apps/api/core";
import { useProjectsStore } from "../../stores/projects";
import { sshOf, useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import { isHostPinned } from "../projectTabHost";
import { confirmedArg, hpcGuardRefusal, withHpcConfirm } from "../remote/hpc/hpcGuard";

interface PathEntry {
  path: string;
  is_dir: boolean;
}

/** Why the list is empty instead of listed: a host-pinned project's host is not
 *  connected (`host` names it), or the HPC question was declined. */
export type QuickOpenNote = { host: string } | "declined" | null;

export interface QuickOpenIndex {
  files: string[];
  note: QuickOpenNote;
}

/**
 * The active project's files, as project-relative paths (`list_project_paths`).
 * A host-pinned project is listed on its host, only while its connection is up
 * (never against a dead session, which would only wait on it) and behind the
 * HPC guard's one confirmed retry.
 */
export async function loadQuickOpenIndex(projectDir: string): Promise<QuickOpenIndex> {
  const { projects, activeId } = useProjectsStore.getState();
  const project = projects.find((p) => p.id === activeId);
  if (project && activeId && isHostPinned(project) && sshOf(useRemoteStatusStore.getState(), activeId) !== "connected") {
    return { files: [], note: { host: project.remote?.label || project.remote?.host || "" } };
  }
  try {
    const entries = await withHpcConfirm((confirmed) =>
      invoke<PathEntry[]>("list_project_paths", { projectDir, ...confirmedArg(confirmed) }),
    );
    return { files: entries.filter((e) => !e.is_dir).map((e) => e.path), note: null };
  } catch (e) {
    return { files: [], note: hpcGuardRefusal(e) ? "declined" : null };
  }
}
