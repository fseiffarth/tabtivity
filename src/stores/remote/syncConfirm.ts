import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

/**
 * Mediates the confirmation every **byte-sync transfer** now asks for.
 *
 * Byte-sync's two manual transfers each write one side's bytes over the other's:
 * a pull replaces the local mirror with the host's copy, a push replaces the
 * host's copy with the mirror's. Both used to be a single unconfirmed click — on
 * a file, on a *folder*, or on the whole project — which is fine when the
 * receiving side holds nothing and is data loss when it holds edits nobody else
 * has. From the button alone the two cases are indistinguishable, so the click
 * itself was the hazard: nothing about it said which one you were in.
 *
 * So every transfer asks first, and asks *with numbers*: how many files would
 * move, how many land on top of an existing file, and — the one that matters —
 * how many of those carry changes that exist nowhere else. The count comes from
 * the backend's read-only `sync_transfer_preview`, which walks exactly what the
 * transfer would walk (exclusions included).
 *
 * The store owns the whole lifecycle so a caller only awaits an answer
 * (`request()` resolves, never rejects) — the same bargain `hpcGuardPrompt` and
 * `hostKeyPrompt` strike. Nothing is remembered between prompts: a confirmation
 * that could be worn down by ticking "don't ask again" is not a gate, and each
 * transfer is a specific act rather than a policy.
 *
 * A **failed** preview never becomes a silent yes: the dialog says it could not
 * price the transfer and still requires the click.
 *
 * The same gate also fronts the orange view's **delete-the-other-copy** actions
 * (`SyncDeleteRequest`): not a transfer, but destructive to one side in exactly
 * the way a forced transfer is — and worse, since the copy it removes is the
 * file's last one anywhere. One dialog for both, so no second copy of the
 * question can drift.
 */

/** Which way the bytes move. Mirrors the backend command's `direction`. */
export type SyncDirection = "pull" | "push";

interface SyncConfirmBase {
  projectId: string;
  /** Project-relative root of the transfer; `""` is the whole project. */
  relPath: string;
  /** Whether `relPath` names a folder (so the dialog can say "and everything in it"). */
  isDir: boolean;
  /** What to name on screen — a file/folder name, or the project's. */
  label: string;
  /** An explicit file list (the diverged-files view's bulk resolve) instead of
   *  walking `relPath`. Passed straight through to the preview. */
  relPaths?: string[];
  /** The transfer overwrites the other side **even where it changed** (the orange
   *  view's take-this-side actions). That turns what would have been a blocked
   *  conflict into a destroyed file, which is exactly what the dialog must say. */
  force?: boolean;
}

/** An ordinary transfer (pull or push). */
export interface SyncTransferRequest extends SyncConfirmBase {
  direction: SyncDirection;
  deleteSide?: undefined;
  newer?: undefined;
}

/** The orange view's "take the newer copy for all": each file moves the way its
 *  newer side says, so ONE ask covers both directions. Two asks in a row put the
 *  second one up only once the first transfer had finished — minutes later, often
 *  after the user had switched project — and each named only half of the act. */
export interface SyncNewerRequest extends SyncConfirmBase {
  /** `host`: newer on the host, pulled over the mirror; `local`: pushed over the host. */
  newer: { host: string[]; local: string[] };
  direction?: undefined;
  deleteSide?: undefined;
}

/** Propagating a one-sided deletion (the orange view's delete-the-other-copy
 *  actions): `"host"` deletes the host copy of a locally-deleted file, `"local"`
 *  deletes the mirror copy of a host-deleted file. No transfer preview applies —
 *  the store prices it with `sync_file_meta` (the doomed copy's size/mtime)
 *  instead, and the dialog's load-bearing sentence is that this removes the
 *  file's LAST remaining copy on either side. */
export interface SyncDeleteRequest extends SyncConfirmBase {
  deleteSide: "host" | "local";
  direction?: undefined;
  newer?: undefined;
  /** The host copy is the file's only one because it was never synced (the
   *  orange view's remote-only rows), not because the mirror's was deleted. */
  hostOnly?: boolean;
}

/** What the dialog is being asked about. */
export type SyncConfirmRequest = SyncTransferRequest | SyncDeleteRequest | SyncNewerRequest;

/** One side's metadata from `sync_file_meta` (the doomed copy, for a delete ask). */
export interface SyncDoomedMeta {
  exists: boolean;
  size: number;
  mtime: number | null;
}

/** The read-only answer to "what would this transfer actually do?". */
export interface SyncTransferPreview {
  files: number;
  bytes: number;
  overwrites: number;
  /** Receiving-side paths whose content would be lost (capped list). */
  destructive: string[];
  destructiveTotal: number;
  /** Push only, non-forced: files that would be blocked as stale instead. */
  conflicts: number;
  /** Git-tracked files omitted from byte-sync because lockstep owns them. */
  tracked: number;
  /** False when the receiving side was too large to inspect up front — the
   *  overwrite/destructive counts are then *unknown*, not zero. */
  exact: boolean;
}

type Pending = SyncConfirmRequest & {
  preview: SyncTransferPreview | null;
  /** A take-newer ask's price, one preview per direction (null while loading,
   *  failed, or that direction has no files). */
  newerPreview: Record<SyncDirection, SyncTransferPreview | null> | null;
  /** The copy a delete ask would destroy (from `sync_file_meta`); null while
   *  loading / failed / not a delete ask. */
  doomed: SyncDoomedMeta | null;
  loading: boolean;
  /** Why the preview could not be read, when it could not. */
  error: string | null;
  resolve: (proceed: boolean) => void;
};

interface SyncConfirmState {
  pending: Pending | null;
  /** Ask about a transfer. Resolves `true` only if the user confirmed. */
  request: (req: SyncConfirmRequest) => Promise<boolean>;
  /** Go ahead with the transfer. */
  proceed: () => void;
  /** Back out; nothing transfers. */
  cancel: () => void;
}

export const useSyncConfirmStore = create<SyncConfirmState>((set, get) => ({
  pending: null,

  request: (req) =>
    new Promise<boolean>((resolve) => {
      // A second ask while one is open answers the newcomer "no" rather than
      // stacking modals or swapping the question out from under the reader.
      if (get().pending) {
        resolve(false);
        return;
      }
      // A batch delete (`relPaths`) names its files instead of pricing one
      // copy, so there is nothing to load.
      const batchDelete = !!req.deleteSide && !!req.relPaths;
      set({
        pending: {
          ...req,
          preview: null,
          newerPreview: null,
          doomed: null,
          loading: !batchDelete,
          error: null,
          resolve,
        },
      });
      if (batchDelete) return;
      if (req.newer) {
        const newer = req.newer;
        const lists: Record<SyncDirection, string[]> = { pull: newer.host, push: newer.local };
        const dirs = (["pull", "push"] as const).filter((d) => lists[d].length > 0);
        void Promise.all(
          dirs.map((direction) =>
            invoke<SyncTransferPreview>("sync_transfer_preview", {
              projectId: req.projectId,
              relPath: req.relPath,
              direction,
              force: !!req.force,
              relPaths: lists[direction],
            }).then((preview) => [direction, preview] as const),
          ),
        )
          .then((priced) => {
            const p = get().pending;
            if (!p || p.resolve !== resolve) return;
            const newerPreview: Record<SyncDirection, SyncTransferPreview | null> = {
              pull: null,
              push: null,
            };
            for (const [direction, preview] of priced) newerPreview[direction] = preview;
            set({ pending: { ...p, newerPreview, loading: false } });
          })
          .catch((e) => {
            const p = get().pending;
            if (!p || p.resolve !== resolve) return;
            set({ pending: { ...p, loading: false, error: String(e) } });
          });
        return;
      }
      // Price it in the background. The dialog is already up and already
      // requires a click, so a slow or failing preview costs information, never
      // the gate itself. A delete ask is priced with the doomed copy's own
      // metadata (`sync_file_meta`) instead of a transfer preview — there is no
      // transfer, only one named copy about to end.
      if (req.deleteSide) {
        const side = req.deleteSide;
        void invoke<{ local: SyncDoomedMeta; host: SyncDoomedMeta }>("sync_file_meta", {
          projectId: req.projectId,
          relPath: req.relPath,
        })
          .then((meta) => {
            const p = get().pending;
            if (!p || p.resolve !== resolve) return;
            set({
              pending: {
                ...p,
                doomed: side === "host" ? meta.host : meta.local,
                loading: false,
              },
            });
          })
          .catch((e) => {
            const p = get().pending;
            if (!p || p.resolve !== resolve) return;
            set({ pending: { ...p, loading: false, error: String(e) } });
          });
        return;
      }
      void invoke<SyncTransferPreview>("sync_transfer_preview", {
        projectId: req.projectId,
        relPath: req.relPath,
        direction: req.direction,
        force: !!req.force,
        relPaths: req.relPaths ?? null,
      })
        .then((preview) => {
          const p = get().pending;
          // Guard against a preview landing after the user already answered (or
          // after a different request took the slot).
          if (!p || p.resolve !== resolve) return;
          set({ pending: { ...p, preview, loading: false } });
        })
        .catch((e) => {
          const p = get().pending;
          if (!p || p.resolve !== resolve) return;
          set({ pending: { ...p, loading: false, error: String(e) } });
        });
    }),

  proceed: () => {
    const p = get().pending;
    set({ pending: null });
    p?.resolve(true);
  },

  cancel: () => {
    const p = get().pending;
    set({ pending: null });
    p?.resolve(false);
  },
}));

/** Ask before a transfer. Shorthand for `useSyncConfirmStore.getState().request`,
 *  so call sites read as one line: `if (!(await confirmSyncTransfer(...))) return;` */
export function confirmSyncTransfer(req: SyncConfirmRequest): Promise<boolean> {
  return useSyncConfirmStore.getState().request(req);
}
