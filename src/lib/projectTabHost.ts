/**
 * Where a project's tabs run, and so what the phone can attach to.
 *
 * The phone attaches to a tab through a tmux session ON THIS MACHINE, so a tab
 * that runs on a remote host, inside a container or in a VM has nothing to
 * attach to (`docs/mobile_every_project_type_plan.md`, phase 1). The sidecar
 * decides it in Rust from the saved record (`discovery::runs_on_this_machine`,
 * `create_verdict`); this is the desktop bridge's twin, over the live tab and
 * project the window holds. Both read `tabLocality.fixture.json`
 * (`src/__tests__/mobile`), so they cannot drift. Remoteness comes from the
 * project record (`remote`, `vm`, `sandbox`), never from a path.
 */
import { effectiveTabLocation, localTabCwd, type TabKind, type TabLocation } from "../stores/tabs";
import { resolveLocalMirror, resolveProjectDirectory, type ProjectEntry } from "../types";

/** The type word the sidecar's list rows carry (`discovery::ProjectHost`). */
export type ProjectHostKind = "local" | "remote" | "container" | "vm";

/** What the phone may start in a scope (`discovery::CreateVerdict`). */
export type PhoneCreateVerdict = "all" | "agents" | "none";

/** The project's host kind, in the order the backend asks: a VM project also
 * has a `remote` (the VM's forwarded port), so it is told apart first. No
 * project (a box, root, the assistant) runs on this machine. */
export function projectHostKind(project: ProjectEntry | null | undefined): ProjectHostKind {
  if (!project) return "local";
  if (project.vm?.enabled) return "vm";
  if (project.remote) return "remote";
  if (project.sandbox?.enabled) return "container";
  return "local";
}

/**
 * Whether a tab of this kind runs inside the project's session container: every
 * PTY agent, and a shell only while the spec's scope is `all`; never the root,
 * never `local_agent` (host-bound), never a remote project's. Mirrors
 * `services::sandbox::resolve_spawn_authority`, the authority; `PaneSlot` uses
 * it for the spawn's `sandbox` flag and the bridge for reachability.
 */
export function tabRunsInContainer(
  project: ProjectEntry | null | undefined,
  kind: TabKind,
  scopeKey: string,
): boolean {
  const containerScope = project?.sandbox?.scope ?? "all";
  return (
    (kind === "agent" || kind === "shell") &&
    (containerScope === "all" || kind === "agent") &&
    scopeKey !== "root" &&
    !!project?.sandbox?.enabled &&
    !project?.remote
  );
}

/** Whether the phone can attach to `tab` of scope `scopeKey`: it has a local
 * tmux session. A local project's (and a box's, root's, the assistant's) tabs
 * always do; a remote or VM project's only when the tab is local by the
 * window's own rule (`effectiveTabLocation`); a container project's only when
 * it runs on the host. The rule of the sidecar's `runs_on_this_machine`. */
export function phoneReachesTab(
  project: ProjectEntry | null | undefined,
  tab: { kind: TabKind; location?: TabLocation },
  scopeKey: string,
): boolean {
  switch (projectHostKind(project)) {
    case "remote":
      return effectiveTabLocation(tab) === "local";
    case "vm":
      return effectiveTabLocation(tab, { vmProject: true }) === "local";
    case "container":
      return !tabRunsInContainer(project, tab.kind, scopeKey);
    case "local":
      return true;
  }
}

/** What the phone may create in the project: anything in a local one (and in a
 * box, root, the assistant); only agents in a remote one, where they run in
 * the local mirror; nothing in a container or a VM (phase 1). A remote project
 * whose mirror does not exist yet is the sidecar's `none`; the window cannot
 * see that, and `launch_prep` makes the mirror at spawn. */
export function phoneCreateVerdict(project: ProjectEntry | null | undefined): PhoneCreateVerdict {
  switch (projectHostKind(project)) {
    case "local":
      return "all";
    case "remote":
      return "agents";
    case "container":
    case "vm":
      return "none";
  }
}

/** The folder the phone's project scope uses for files, the inbox and where a
 * new tab starts, the same one the sidecar uses (`discovery::mobile_root`):
 * a local or container project's directory; a remote project's local mirror
 * (the entry's own, else `<directory>/mirror`, as a local tab of it runs in);
 * a VM project's only if the user opted into a mirror, else "" (no folder on
 * the host, so the folder-shaped handlers answer `project_ineligible`). */
export function phoneProjectFolder(project: ProjectEntry): string {
  const mirror = resolveLocalMirror(project);
  switch (projectHostKind(project)) {
    case "vm":
      return mirror ?? "";
    case "remote":
      return localTabCwd(
        { kind: "agent" },
        { isRemoteProject: true, projectDirectory: resolveProjectDirectory(project), mirror, fallback: "" },
      );
    case "container":
    case "local":
      return resolveProjectDirectory(project);
  }
}
