/**
 * A container tab that could not start because the container engine is missing
 * or stopped, turned into what the pane shows (`TerminalContainerCard`): a way
 * to move the project out of its container instead of a bare spawn error.
 *
 * The backend's spawn error is prose, so it is not parsed: any failed spawn of
 * a container tab asks `sandbox_preflight` what is wrong, and only its
 * `no_docker` / `daemon_down` verdicts become a notice. Per PTY, like
 * `sessionHostNotice`, so a card that mounts late still shows it.
 */

import { invoke } from "@tauri-apps/api/core";

export type ContainerProblem = "no_docker" | "daemon_down";

export interface ContainerNotice {
  projectId: string;
  problem: ContainerProblem;
}

type Handler = (notice: ContainerNotice | null) => void;
const handlers = new Map<string, Set<Handler>>();
const latest = new Map<string, ContainerNotice>();
/** Bumped by every clear, so a preflight that answers after a new spawn
 *  attempt (or the tab's end) does not raise a stale notice. */
const generation = new Map<string, number>();

function publish(id: string, notice: ContainerNotice | null): void {
  if (notice) latest.set(id, notice);
  else if (!latest.delete(id)) return;
  for (const h of [...(handlers.get(id) ?? [])]) h(notice);
}

/** Follow PTY `id`'s notice: called at once with the current one (if any),
 *  then with every change (`null` when it is gone). Returns the unsubscribe. */
export function onContainerNotice(id: string, handler: Handler): () => void {
  const already = latest.get(id);
  if (already) handler(already);
  let set = handlers.get(id);
  if (!set) {
    set = new Set();
    handlers.set(id, set);
  }
  set.add(handler);
  return () => {
    set.delete(handler);
    if (set.size === 0 && handlers.get(id) === set) handlers.delete(id);
  };
}

/** The preflight's status as a problem this notice offers a way out of. */
export function containerProblemOf(status: unknown): ContainerProblem | null {
  return status === "no_docker" || status === "daemon_down" ? status : null;
}

/** Called by `TerminalView` when a container tab's `pty_spawn` rejects. */
export function reportContainerSpawnError(id: string, projectId: string): void {
  const gen = generation.get(id) ?? 0;
  invoke<{ status: string }>("sandbox_preflight", { projectId })
    .then((report) => {
      if ((generation.get(id) ?? 0) !== gen) return;
      const problem = containerProblemOf(report.status);
      if (problem) publish(id, { projectId, problem });
    })
    .catch(() => {
      // Advisory: the spawn error is already in the pane.
    });
}

/** Drop PTY `id`'s notice: a new spawn attempt, the button used, the PTY
 *  killed or its tab closed. */
export function clearContainerNotice(id: string): void {
  generation.set(id, (generation.get(id) ?? 0) + 1);
  publish(id, null);
}

/** Test seam: forget every notice. */
export function resetContainerNotices(): void {
  latest.clear();
  generation.clear();
}
