import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

import { useTauriListener } from "./useTauriListener";

/** The slice of `services::git_peer::GitPeerState` a non-Git view needs. */
export interface LockstepSummary {
  enabled: boolean;
  status: "synchronized" | "syncing" | "desynchronized" | "disconnected";
  /** Why, when `status` is `desynchronized`. */
  detail: string | null;
}

/**
 * A remote project's Git lockstep state, kept live from `git-peer-status` — for
 * the views that must say "git-tracked files are Git sync's job" (the Files
 * panel's Sync all / Auto-sync) without being the Git view. `active` gates the
 * probe on a connected remote project: `git_peer_status` against a dead session
 * is exactly the call that must not run.
 */
export function useLockstepState(projectId: string | null | undefined, active: boolean) {
  const [state, setState] = useState<LockstepSummary | null>(null);
  useEffect(() => {
    if (!projectId || !active) {
      setState(null);
      return;
    }
    let alive = true;
    invoke<LockstepSummary>("git_peer_status", { projectId })
      .then((s) => alive && setState(s))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [projectId, active]);
  useTauriListener(
    () =>
      listen<{ projectId: string; state: LockstepSummary }>("git-peer-status", (e) => {
        if (active && e.payload.projectId === projectId) setState(e.payload.state);
      }),
    [projectId, active],
  );
  return state;
}
