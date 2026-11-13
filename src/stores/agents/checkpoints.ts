import { useEffect } from "react";
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { useTauriListener } from "../../hooks/useTauriListener";
import { CHECKPOINT_EVENT, checkpointList, type CheckpointListing } from "../../lib/agents/checkpoints";

/**
 * Each agent tab's checkpoints (`lib/agents/checkpoints`), read from the
 * backend's log and refreshed when it announces a snapshot
 * (`checkpoint-added`). Keyed by the tab's launch uid.
 */

interface CheckpointsStore {
  byUid: Record<string, CheckpointListing>;
  refresh: (uid: string) => Promise<void>;
}

export const useCheckpointsStore = create<CheckpointsStore>((set) => ({
  byUid: {},
  refresh: async (uid) => {
    const listing = await checkpointList(uid).catch(() => null);
    if (listing) set((state) => ({ byUid: { ...state.byUid, [uid]: listing } }));
  },
}));

const NONE: CheckpointListing = { enabled: false, bound: false, rows: [] };

/**
 * The checkpoints of tab `uid` while `active` (the Reader is shown): read once
 * on showing, then again whenever the backend announces a snapshot of this
 * tab. `NONE` until read, and for a tab with no uid.
 */
export function useTabCheckpoints(uid: string | undefined, active: boolean): CheckpointListing {
  const listing = useCheckpointsStore((state) => (uid ? state.byUid[uid] : undefined)) ?? NONE;
  useEffect(() => {
    if (uid && active) void useCheckpointsStore.getState().refresh(uid);
  }, [uid, active]);
  useTauriListener(
    () =>
      listen(CHECKPOINT_EVENT, () => {
        if (uid && active) void useCheckpointsStore.getState().refresh(uid);
      }),
    [uid, active],
  );
  return listing;
}
