/**
 * Where a clicked terminal link goes, from where the tab runs.
 *
 * `localhost:8888` printed in a tab means *that tab's* loopback. In a remote, VM or
 * container tab the old click opened this machine's port 8888 instead — a different
 * program, or an error page (`docs/localhost_viewer_plan.md`). The route is decided
 * from the tab's explicit locality, never from its working directory, and a
 * loopback link in a tab that is not local never opens this machine's port: it is
 * forwarded (remote hosts) or refused with a message (everything else).
 */
import { parseServerTarget, type ServerTarget } from "./serverUrls";

/** Where a tab's program runs. `undefined` (no locality known) routes everything to the
 *  system browser as before — the caller decides, a guess from the cwd is never made. */
export type TabLocality =
  /** This machine: the link opens as it is. */
  | { kind: "local" }
  /** A remote project's host, by its backend host id (`"primary"` or a worker id). */
  | { kind: "remote"; projectId: string; hostId: string }
  /** The project's container. Its loopback is not reachable from here yet. */
  | { kind: "container" }
  /** Not local, but not known well enough to forward (project not loaded). */
  | { kind: "unknown" };

/** What the tab's props and its project say, for [`tabLocality`]. */
export interface TabLocalityInput {
  projectId: string | null | undefined;
  /** The tab was started on this machine's mirror (`TerminalView.localOnly`). */
  localOnly: boolean;
  /** A container tab (`TerminalView.sandbox`). */
  sandbox: boolean;
  /** The host the tab asked for (`TerminalView.remoteHostId`); null for none. */
  remoteHostId: string | null | undefined;
  /** An ssh/VPN login terminal: a plain local PTY. */
  login: boolean;
  /** The root console's own Host session: a local, unfenced agent. */
  hostSession: boolean;
  /** The project, when it is loaded: whether it is remote, and its worker ids. */
  project: { remote: boolean; workerIds: readonly string[] } | null;
}

/**
 * The tab's locality, mirroring the backend's spawn decision (`launch_prep`: a
 * container tab is `sandbox && !localOnly`; a remote tab is a non-`localOnly` tab of a
 * remote project, on the named worker or, when that no longer resolves, the primary).
 * A shell tab of a *local* project also carries `remoteHostId: "primary"` — which
 * means nothing without the project saying it is remote, hence `project`.
 */
export function tabLocality(input: TabLocalityInput): TabLocality {
  if (input.login || input.hostSession || !input.projectId || input.localOnly) return { kind: "local" };
  // A box or the assistant is no project: the backend runs these tabs here.
  if (isNonProjectScope(input.projectId)) return { kind: "local" };
  if (input.sandbox) return { kind: "container" };
  if (!input.project) return { kind: "unknown" };
  if (!input.project.remote) return { kind: "local" };
  const asked = input.remoteHostId ?? "primary";
  const hostId = asked === "primary" || input.project.workerIds.includes(asked) ? asked : "primary";
  return { kind: "remote", projectId: input.projectId, hostId };
}

/** Scopes that hold tabs but are not a project (`box:<id>`, the assistant). */
function isNonProjectScope(scope: string): boolean {
  const id = scope.trim().toLowerCase();
  return id.startsWith("box:") || id === "assistant";
}

/** What a clicked link should do. */
export type LinkRoute =
  /** Open it in the system browser (after the usual confirmation). */
  | "external"
  /** A loopback link in a tab whose loopback this machine cannot reach (yet): say so, open nothing. */
  | "unsupported"
  | {
      forward: {
        projectId: string;
        hostId: string;
        /** The remote end: loopback address or the host name the tab printed. */
        remoteHost: string;
        remotePort: number;
        scheme: ServerTarget["scheme"];
        pathAndQuery: string;
      };
    };

export function routeLink(url: string, locality: TabLocality | undefined): LinkRoute {
  if (!locality || locality.kind === "local") return "external";
  const target = parseServerTarget(url);
  // Anything that is not the tab's own loopback (or a node name with a port) is an
  // ordinary web link, opened here.
  if (!target) return "external";
  if (locality.kind !== "remote") return "unsupported";
  return {
    forward: {
      projectId: locality.projectId,
      hostId: locality.hostId,
      remoteHost: target.host,
      remotePort: target.port,
      scheme: target.scheme,
      pathAndQuery: target.pathAndQuery,
    },
  };
}
