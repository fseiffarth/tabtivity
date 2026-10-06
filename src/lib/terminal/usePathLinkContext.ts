import { useMemo } from "react";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { resolveProjectDirectory } from "../../types";
import { disabledViewers } from "../viewers/fileUtils";
import { pathLinkContext, type PathLinkContext } from "./pathLinks";

/** A pane's path-link context (`pathLinks`), shared by the terminal and the
 *  Reader. The project is read as one string — its folder, "" when remote,
 *  null when unknown — so a pane re-renders only when that changes. */
export function usePathLinkContext(projectId: string | null | undefined, cwd: string | undefined): PathLinkContext {
  const projectDir = useProjectsStore((s) => {
    if (!projectId) return null;
    const project = s.projects.find((p) => p.id === projectId);
    return project ? (project.remote ? "" : resolveProjectDirectory(project)) : null;
  });
  const viewerPrefs = useSettingsStore((s) => s.settings?.viewer_prefs);
  return useMemo(
    () => pathLinkContext(projectId, projectDir, cwd, disabledViewers(viewerPrefs)),
    [projectId, projectDir, cwd, viewerPrefs],
  );
}
