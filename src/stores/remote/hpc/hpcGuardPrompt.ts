import { create } from "zustand";

/**
 * Mediates the HPC tag's confirmation dialog.
 *
 * A machine tagged HPC (`lib/remote/hpc/hpcHost.ts`) has its background work switched off
 * outright — sync loops, lockstep polling, auto-connect, full stats. Two things
 * can't be settled that way, because the user sometimes genuinely wants them: a
 * disk-usage scan of the cluster tree, and running a command in a login-node
 * shell. Those are *asked about* instead, once per act, here.
 *
 * The store owns the whole lifecycle so a caller only awaits an answer
 * (`request()` resolves, never rejects) — the same bargain `hostKeyPrompt` and
 * `vpnPrompt` strike. Nothing is remembered between prompts: a tag that could be
 * worn down by clicking through once would not be a gate, and each of these is a
 * specific act rather than a policy.
 */

/** What is being asked about. Mirrors the slugs `services::hpc_mode`'s refusals
 *  carry (`du-scan`, `census`, `connect`, `host-scan`), plus the one the frontend raises on
 *  its own (`login-node-run`). */
export type HpcGuardKind = "du-scan" | "census" | "host-scan" | "login-node-run" | "connect";

interface Pending {
  kind: HpcGuardKind;
  /** `user@host:port`, as the tag is keyed — the dialog names the machine. */
  target: string;
  resolve: (proceed: boolean) => void;
}

interface HpcGuardState {
  pending: Pending | null;
  /** How many `HpcGuardDialog`s are mounted in THIS window. A request with no
   *  host to answer it is refused at once rather than parked on a Promise
   *  nobody can resolve (Group B #233: a ▶ run from a popout on an HPC-tagged
   *  host used to hang forever, silently, because the dialog lived only in the
   *  main window's shell). The dialog registers itself on mount. */
  hosts: number;
  /** Ask about `kind` on `target`. Resolves `true` only if the user chose to go
   *  ahead anyway, `false` on cancel — or immediately when no dialog is mounted
   *  in this window to ask with. */
  request: (kind: HpcGuardKind, target: string) => Promise<boolean>;
  /** Go ahead regardless — the user's call to make. */
  proceed: () => void;
  /** Back out; nothing runs. */
  cancel: () => void;
  /** `HpcGuardDialog` mount/unmount bookkeeping. */
  registerHost: () => () => void;
}

export const useHpcGuardStore = create<HpcGuardState>((set, get) => ({
  pending: null,
  hosts: 0,

  request: (kind, target) =>
    new Promise<boolean>((resolve) => {
      // No dialog in this window: refusing is the only honest answer. The
      // caller's ordinary "the user backed out" path runs, which is exactly the
      // safe direction for a gate.
      if (get().hosts === 0) {
        resolve(false);
        return;
      }
      // A second ask while one is open answers the newcomer "no" rather than
      // stacking modals or silently replacing the question being read.
      if (get().pending) {
        resolve(false);
        return;
      }
      set({ pending: { kind, target, resolve } });
    }),

  registerHost: () => {
    set((s) => ({ hosts: s.hosts + 1 }));
    return () => set((s) => ({ hosts: Math.max(0, s.hosts - 1) }));
  },

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
