// Where a tab runs: locality helpers (local mirror, primary, worker hosts).
// Pure. Moved out of `stores/tabs.ts`.

import { translate, useI18nStore } from "../../lib/i18n";
import type { TabKind, TabLocation } from "./types";
import { isLocalAgentKind } from "./tabKinds";

/** The backend host id a tab location runs on: `"primary"` for the primary remote
 *  (`"remote"`), the worker id for a `host:<id>` location, or `null` for `"local"`
 *  (`docs/multi_host_remote_plan.md` §4.1). Pass to PTY spawn / lamp reads. */
export function remoteHostIdOf(loc: TabLocation | undefined): string | null {
  if (loc === "remote") return "primary";
  if (loc && loc.startsWith("host:")) return loc.slice("host:".length);
  return null; // "local" or unset
}

/** Whether a tab location runs on a remote host (primary or a worker) rather than
 *  the local mirror. */
export function isRemoteLocation(loc: TabLocation | undefined): boolean {
  return remoteHostIdOf(loc) !== null;
}

/** The minimal shape of a worker machine (`ComputeHost`) the locality UI reads —
 *  structural so `tabs.ts` need not import the full project types. */
export interface LocalityHost {
  id: string;
  label?: string;
  host: string;
  sync_code?: boolean;
  shared_fs?: boolean;
}

/** Human-readable name of the machine a tab location runs on — the ONE place the
 *  tab badge, its locality menu, and the hover card agree on wording
 *  (`docs/multi_host_remote_plan.md`). `"local"` → the mirror; `"remote"` → the
 *  primary host (named when known); `host:<id>` → the worker's label/host/id. */
export function localityHostLabel(
  loc: TabLocation | undefined,
  opts: { primaryHost?: string; computeHosts?: LocalityHost[] } = {},
): string {
  const lang = useI18nStore.getState().lang;
  const hostId = remoteHostIdOf(loc);
  if (hostId === null) return translate(lang, "tabLocality.localMirrorItem");
  if (hostId === "primary") {
    return opts.primaryHost
      ? translate(lang, "tabLocality.primaryWithHost", { host: opts.primaryHost })
      : translate(lang, "tabLocality.primary");
  }
  const w = opts.computeHosts?.find((h) => h.id === hostId);
  return w?.label || w?.host || hostId;
}

/** Whether a worker machine can actually RUN a shell/agent tab: it must hold the
 *  code — either it shares the primary's filesystem (`shared_fs`) or it keeps a
 *  synced copy (`sync_code`, default on). A worker with neither has no tree to run
 *  in; sync always stays with the primary, so such a worker is offered disabled.
 *  The primary (`"primary"`/`undefined`) and the local mirror are always runnable. */
export function workerRunnable(h: LocalityHost): boolean {
  return !!h.shared_fs || h.sync_code !== false;
}

/**
 * SSH-sync Phase 0: whether a tab kind has a user-toggleable local/remote
 * locality. Only `agent` and `shell` tabs run a PTY that can sit on either side;
 * `local_agent` is fixed-local and the non-PTY kinds
 * (files/embed/projects3d/network)
 * have no locality.
 */
export function isLocatableKind(kind: TabKind): boolean {
  return kind === "agent" || kind === "shell";
}

/**
 * SSH-sync Phase 0: the default locality for a kind on a remote project (product
 * decision 1): **agents default LOCAL** (cwd = the local mirror), **shells
 * default REMOTE** (run remote scripts on the host). `local_agent` and the
 * non-PTY kinds resolve local. See docs/ssh_sync_plan.md.
 */
export function defaultLocationForKind(kind: TabKind): TabLocation {
  return kind === "shell" ? "remote" : "local";
}

/**
 * SSH-sync Phase 0: a tab's effective locality — its explicit `location`, or the
 * per-kind default when unset. `local_agent` is always local regardless of any
 * stored value. Consumed by CenterPanel/DetachedCenterPanel to decide `localOnly`
 * and resolve the local `cwd` (mirror root) for a local-on-remote tab.
 */
export function effectiveTabLocation(
  tab: { kind: TabKind; location?: TabLocation },
  opts?: {
    /** VM tier (`docs/vm_projects_plan.md`): the owning project lives inside
     *  a VM, so locality is PINNED to the VM host — the agents-default-local
     *  rule below is precisely the escape that tier forbids, and any stored
     *  `location: "local"` (e.g. a persisted layout an in-VM agent could have
     *  written) is overridden, never honored. The backend's spawn guard
     *  refuses a local spawn outright as the hard boundary; this keeps the
     *  frontend from ever building one. */
    vmProject?: boolean;
  },
): TabLocation {
  if (opts?.vmProject && !isLocalAgentKind(tab.kind)) return "remote";
  if (isLocalAgentKind(tab.kind)) return "local";
  return tab.location ?? defaultLocationForKind(tab.kind);
}

/**
 * SSH-sync Phase 1: the local working directory a PTY tab should run in when it
 * runs LOCALLY on a REMOTE project. A local-on-remote tab can't cwd into the
 * remote tree, so it runs in the project's local **mirror** — the synced twin.
 * This is the value shown in the tab title (and the path the disconnected file
 * browser lists); the backend resolves the same path authoritatively at spawn
 * (and guarantees it exists).
 *
 * The mirror can be relocated to a custom folder ("Move project…"), so prefer the
 * project's persisted override (`opts.mirror`, from resolveLocalMirror) when set;
 * fall back to the default `<state dir>/mirror` for legacy projects with none.
 * Returns `fallback` (the tab's own cwd) unchanged for a local project or a tab
 * that runs on the host (remote locality).
 */
export function localTabCwd(
  tab: { kind: TabKind; location?: TabLocation },
  opts: { isRemoteProject: boolean; projectDirectory: string; fallback: string; mirror?: string | null },
): string {
  if (!opts.isRemoteProject || effectiveTabLocation(tab) !== "local") {
    return opts.fallback;
  }
  const override = opts.mirror?.trim();
  if (override) return override.replace(/[/\\]+$/, "");
  if (!opts.projectDirectory) return opts.fallback;
  return `${opts.projectDirectory.replace(/[/\\]+$/, "")}/mirror`;
}

/** The host shape {@link hostTabId} and {@link hostTabCwd} read. */
type TabHostProject = {
  remote?: { remote_path: string };
  compute_hosts?: readonly { id: string; remote_path: string }[];
  vm?: { enabled?: boolean };
};

/**
 * The host a PTY tab of a remote `project` runs on — `"primary"` or a worker
 * id — or `null` for a tab that runs locally (or a local project). A worker id
 * the project no longer has falls back to the primary, as the backend does.
 */
export function hostTabId(tab: { kind: TabKind; location?: TabLocation }, project: TabHostProject | undefined): string | null {
  if (!project?.remote) return null;
  const hostId = remoteHostIdOf(effectiveTabLocation(tab, { vmProject: !!project.vm?.enabled }));
  if (!hostId || hostId === "primary") return hostId;
  return project.compute_hosts?.some((h) => h.id === hostId) ? hostId : "primary";
}

/**
 * The folder a PTY tab that runs ON a host starts in: that host's `remote_path`
 * (`ssh_exec::wrap_pty_options` cds into the project root there), or `null` for
 * a tab that runs locally. Its spawn cwd is only the local state folder the
 * backend resolves to the host, so it is no path to show.
 */
export function hostTabCwd(tab: { kind: TabKind; location?: TabLocation }, project: TabHostProject | undefined): string | null {
  const hostId = hostTabId(tab, project);
  if (!hostId || !project) return null;
  const worker = hostId === "primary" ? undefined : project.compute_hosts?.find((h) => h.id === hostId);
  return (worker ?? project.remote)?.remote_path || null;
}
