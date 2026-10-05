import { create } from "zustand";
import type { TabKind } from "./tabs";

/**
 * Mediates the confirmation in front of `deactivateProject` — the one gesture in
 * the project bar that *kills running work*.
 *
 * It used to be a native OS `confirm()` with the whole question crammed into one
 * sentence ("stops 3 terminal tab(s) and 1 persistent tmux session(s)…"). Two
 * problems with that: the platform dialog is the only piece of chrome in Tabtivity
 * that ignores the theme, and a count is not an inventory — "3 tabs" does not
 * tell you whether one of them is the training run you started an hour ago. The
 * in-app dialog names them.
 *
 * Same promise-shaped bargain as `hostKeyPrompt` and `hpcGuardPrompt`: the store
 * owns the lifecycle and `request()` resolves (never rejects), so the caller in
 * `stores/projects` still reads as one `await` and one `if (!ok) return`.
 */

/** One PTY tab about to be stopped, reduced to what the dialog shows. Deliberately
 *  not the whole `TabEntry`: the pending question must not pin a tab object alive
 *  past the teardown that removes it. */
export interface StopProjectTab {
  key: string;
  label: string;
  kind: TabKind;
  /** `undefined`/`"local"` runs here; `"remote"` the primary host; `host:<id>` a
   *  worker. Shown as a locality chip, because a tab on a remote host is the one
   *  whose loss the user is least likely to have in mind. */
  location?: string;
}

interface Pending {
  /** The project being closed, named in the lede. */
  name: string;
  tabs: StopProjectTab[];
  /** Persistent tmux sessions the tabs own — the work that would otherwise have
   *  survived a relaunch, which is exactly why it is counted separately. */
  sessions: number;
  /** Persistent tmux sessions on remote hosts that this close does NOT touch —
   *  they keep running on the host and are only killed from the project's
   *  Sessions view. Named so the user is not left guessing which of the two
   *  fates their remote training run meets. */
  remoteSessions: number;
  resolve: (proceed: boolean) => void;
}

interface StopProjectState {
  pending: Pending | null;
  /** Ask before stopping. Resolves `true` only on an explicit confirm. */
  request: (
    name: string,
    tabs: StopProjectTab[],
    sessions: number,
    remoteSessions?: number,
  ) => Promise<boolean>;
  /** Stop them — the user's call. */
  proceed: () => void;
  /** Leave everything running. */
  cancel: () => void;
}

export const useStopProjectStore = create<StopProjectState>((set, get) => ({
  pending: null,

  request: (name, tabs, sessions, remoteSessions = 0) =>
    new Promise<boolean>((resolve) => {
      // A second ask while one is open answers the newcomer "no" rather than
      // stacking modals or replacing the question being read. `deactivateProject`
      // already refuses to run twice for one project, so this is the two-projects
      // case, and declining the second is the conservative answer: nothing is
      // stopped that was not confirmed on screen.
      if (get().pending) {
        resolve(false);
        return;
      }
      set({ pending: { name, tabs, sessions, remoteSessions, resolve } });
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
