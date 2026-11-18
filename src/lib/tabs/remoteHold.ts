import { effectiveTabLocation, isPtyTabKind, remoteHostIdOf, type TabEntry } from "../../stores/tabs";
import type { HostConnState } from "../../stores/remote/remoteStatus";
import { isHostPinned } from "../projectTabHost";
import type { ProjectEntry } from "../../types";

/** Where one tab of a project runs, and whether its pane must hold. */
export interface PaneRemoteHost {
  /** `primary`, a worker id, or null for a tab that runs on this machine. */
  hostId: string | null;
  /** That host's SSH state (undefined for a local tab). */
  ssh: HostConnState["ssh"] | undefined;
  /** The pane must not spawn (or attach) now: its host's pool is down. */
  held: boolean;
  /** The host's label, for the hold placeholder and hover cards. */
  label: string;
}

/**
 * The pane layer's per-pane remote gating, as one pure reading — shared by
 * `PaneSlot` (which holds the pane) and the cockpit's detail pane (which must
 * not attach to a PTY its owner never spawned).
 *
 * A terminal pane runs on a remote host when its effective locality resolves
 * to one (primary or a worker), and holds while THAT host's pool is down:
 * spawning `ssh -tt` now would block on the dead pool. Multi-host: a pane on
 * gpu-2 holds iff gpu-2 is down, independent of the primary (plan §4.5). A
 * tab naming a worker that no longer exists (machine removed) falls back to
 * the primary — matching the backend's wrap_pty_options (plan §8). A
 * host-pinned project (VM, remote-only) has no local copy to fall back on, so
 * its Files tab — which on a plain remote project browses the mirror while
 * offline — holds too, on the primary's pool.
 */
export function paneRemoteHost(
  tab: TabEntry,
  project: ProjectEntry | undefined,
  projectSsh: HostConnState["ssh"] | undefined,
  hostSsh: Record<string, HostConnState> | undefined,
): PaneRemoteHost {
  const hostPinned = isHostPinned(project);
  const rawHostId = remoteHostIdOf(effectiveTabLocation(tab, { hostPinned }));
  const hostId =
    rawHostId && rawHostId !== "primary" && !project?.compute_hosts?.some((h) => h.id === rawHostId)
      ? "primary"
      : rawHostId;
  const ssh = hostId === "primary" ? projectSsh : hostId ? hostSsh?.[hostId]?.ssh : undefined;
  const held =
    !!project?.remote &&
    (isPtyTabKind(tab.kind)
      ? hostId !== null && ssh !== "connected"
      : hostPinned && tab.kind === "files" && projectSsh !== "connected");
  const label =
    hostId === "primary" || hostId === null
      ? (project?.remote?.host ?? "")
      : (() => {
          const w = project?.compute_hosts?.find((h) => h.id === hostId);
          return w?.label || w?.host || hostId;
        })();
  return { hostId, ssh, held, label };
}
