import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

/**
 * The local-loss warning log for the active remote project (#28q).
 *
 * Mirrors `services::local_loss`. Both transports that keep a remote project in step
 * write into the local mirror, and a few of those writes destroy what is already there:
 * a lockstep fast-forward / `reset --hard` / checkout deletes the tracked files the
 * incoming commit dropped, the `git clean` that un-blocks a refused fast-forward removes
 * untracked ones, and a manual byte-sync pull overwrites a mirror file holding unsynced
 * local edits. The backend records each one; this store reads them back and
 * `LocalLossDialog` raises the unacknowledged ones.
 *
 * Pulled, not pushed: the backend writes the log from `AppHandle`-free services during
 * background passes (see the module doc there), so the frontend re-reads it whenever a
 * lockstep or sync pass reports in — which also means a loss recorded while the app was
 * closed surfaces on the next launch rather than being missed forever.
 */

/** Mirrors `services::local_loss::LocalLoss` (camelCase). */
export interface LocalLoss {
  /** Unix seconds; also the entry's identity. */
  ts: number;
  /** Which transport destroyed it — the two have different recovery stories. */
  source: "git" | "sync";
  kind: "deleted" | "overwritten";
  /** The operation, as a user-facing phrase. */
  op: string;
  /** Project-relative paths (truncated; `total` carries the real count). */
  paths: string[];
  total: number;
  /** How to get the content back, or null when it cannot be got back. */
  recovery: string | null;
  acked: boolean;
}

interface LocalLossStore {
  /** Entries for the project last refreshed, newest first. */
  entries: LocalLoss[];
  /** Which project `entries` belongs to. The dialog renders only when this still
   *  matches the active project, so a response landing after a project switch can
   *  never paint one project's losses over another's. */
  projectId: string | null;
  /** Re-read the log. A local project has no mirror, so it simply reads empty. */
  refresh: (projectId: string) => Promise<void>;
  /** Mark everything seen (the dialog's "Got it"). Entries stay on disk. */
  ack: (projectId: string) => Promise<void>;
}

/** The events after which the log can have grown — a lockstep pass, a byte-sync
 *  transfer, an auto-sync pass. */
export const LOCAL_LOSS_EVENTS = ["git-peer-status", "sync-progress", "auto-sync"] as const;

/**
 * Whether one of {@link LOCAL_LOSS_EVENTS} warrants re-reading the active project's
 * log. Two kinds of event never do:
 * - another project's: the dialog only speaks for the project on screen, and every
 *   remote project's lockstep loop reports in every 12 s;
 * - a byte-sync `file` step: `sync-progress` fires once per transferred file, so a
 *   5 000-file pull used to cost 5 000 log reads. The loss a transfer records is
 *   written before its `start` (`warn_overwritten`), and its `done` follows the last
 *   file — those two bookends still re-read.
 * A payload this build does not recognise re-reads, the safe direction for a warning.
 */
export function localLossEventConcerns(event: string, payload: unknown, activeId: string): boolean {
  if (!payload || typeof payload !== "object") return true;
  const p = payload as { projectId?: unknown; project_id?: unknown; phase?: unknown };
  const project = event === "git-peer-status" ? p.projectId : p.project_id;
  if (typeof project === "string" && project !== activeId) return false;
  return !(event === "sync-progress" && p.phase === "file");
}

function sameEntries(a: LocalLoss[], b: LocalLoss[]): boolean {
  return a.length === b.length && JSON.stringify(a) === JSON.stringify(b);
}

export const useLocalLossStore = create<LocalLossStore>((set, get) => ({
  entries: [],
  projectId: null,

  refresh: async (projectId) => {
    try {
      const entries = await invoke<LocalLoss[]>("local_loss_list", { projectId });
      // A re-read that found the same log keeps the same array, so the dialog does
      // not re-render on every lockstep tick.
      const cur = get();
      if (cur.projectId === projectId && sameEntries(cur.entries, entries)) return;
      set({ entries, projectId });
    } catch {
      // A log we cannot read is not worth a second failure on top of the first.
    }
  },

  ack: async (projectId) => {
    // Optimistic: the dialog closes on this state, not on the round trip. A failed ack
    // means it reappears on the next refresh — the safe direction for a warning.
    set((s) => ({ entries: s.entries.map((e) => ({ ...e, acked: true })) }));
    try {
      await invoke("local_loss_ack", { projectId });
    } catch {
      /* best-effort */
    }
  },
}));
