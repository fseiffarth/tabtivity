import { useGitDirtyStore, type GitDirtyState } from "../stores/gitDirty";
import { resolveProjectDirectory, type ProjectEntry } from "../types";

/** A project's git dot as the phone gets it: the desktop pill's own level
 *  (`stores/gitDirty.ts`). "clean" never crosses — no dot, as on the desktop —
 *  and neither does "unknown" (an errored probe): the phone shows no dot. */
export type MobileGitDot = Exclude<GitDirtyState, "clean" | "unknown">;

export interface MobileGitStateRow {
  project_id: string;
  state: MobileGitDot;
}

export function gitDotOf(projectId: string): MobileGitDot | undefined {
  const state = useGitDirtyStore.getState().byId[projectId];
  return state && state !== "clean" && state !== "unknown" ? state : undefined;
}

/** The phone's project list: whatever the desktop's pills last probed. No git
 *  runs for it — a project the switcher does not poll simply has no row. */
export function gitDotRows(projects: readonly ProjectEntry[]): MobileGitStateRow[] {
  return projects.flatMap((project) => {
    const state = gitDotOf(project.id);
    return state ? [{ project_id: project.id, state }] : [];
  });
}

/** One probe per project per this long, however often the phone's project
 *  screen polls (every 5 s) — the switcher's own cadence is 12 s. */
export const MOBILE_GIT_PROBE_MS = 10_000;
/** How long a catalog answer waits on that probe before it goes out with the
 *  last known dot instead; the probe still lands in the store for the next. */
const PROBE_WAIT_MS = 1_500;
const lastProbe = new Map<string, number>();

/** The phone's project screen: the dot, re-probed first when the last probe is
 *  older than `MOBILE_GIT_PROBE_MS`. The project being looked at may be one the
 *  switcher does not poll. Remote projects are left to the switcher's rule
 *  (never probed over the mount) and answer with what the store holds. */
export async function freshGitDot(project: ProjectEntry, now = Date.now()): Promise<MobileGitDot | undefined> {
  const dir = resolveProjectDirectory(project);
  if (!project.remote && dir && now - (lastProbe.get(project.id) ?? 0) >= MOBILE_GIT_PROBE_MS) {
    lastProbe.set(project.id, now);
    const probe = useGitDirtyStore.getState().refresh(project.id, dir);
    await Promise.race([probe, new Promise((resolve) => setTimeout(resolve, PROBE_WAIT_MS))]);
  }
  return gitDotOf(project.id);
}

/** Tests only. */
export function resetMobileGitProbes(): void {
  lastProbe.clear();
}
