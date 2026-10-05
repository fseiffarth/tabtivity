import { create } from "zustand";

/**
 * What per-tab auto-continue is currently doing, for the one view that shows it.
 *
 * Live only — nothing here reaches disk. The persisted half of the feature is a
 * single boolean on the tab (`TabEntry.autoContinue`); everything below is
 * re-derived by `components/layout/AgentContinueHost` from the agent CLI's own
 * usage panel each time it reads one. A stored arming time would be the one
 * thing that could fire a continue against a window that had already turned
 * over while Tabtivity was closed.
 */

export type ContinuePhase =
  /** Between windows: the CLI's usage panel is about to be (or is being) read. */
  | "reading"
  /** A rollover has been placed in time and a continue is waiting for it. */
  | "armed"
  /** The moment has come; the tab is being waited on and written to. */
  | "sending"
  /** This CLI publishes no usage panel, so no rollover can be read at all. */
  | "unsupported"
  /** A panel came back, but nothing in it named a time this reader can place. */
  | "unreadable"
  /** The CLI, or the delivery, said why it could not. */
  | "error";

export interface ContinueStatus {
  phase: ContinuePhase;
  /** Epoch ms the continue is due at — the rollover plus the settling minute. */
  armedAt?: number;
  /** The meter the rollover was read off ("Current session"). */
  window?: string;
  /** The rollover in the CLI's own words ("6:20pm"), kept so the view can show
   *  what was read rather than only what it was turned into. */
  resets?: string;
  /** Epoch ms before which the panel is not read again — a floor under retries,
   *  and the pause that lets a just-rolled window report its new one. */
  checkAt?: number;
  /** Epoch ms of the last continue that actually reached the tab. */
  lastSentAt?: number;
  /** How many continues this switch has sent since Tabtivity started. */
  sent: number;
  /** Why there is nothing armed, in the CLI's words where it had any. */
  error?: string;
}

const BLANK: ContinueStatus = { phase: "reading", sent: 0 };

interface AgentContinueStore {
  byTarget: Record<string, ContinueStatus>;
  /** Merge a patch into one target's status, creating it if this is the first. */
  patch: (key: string, patch: Partial<ContinueStatus>) => void;
  /** Drop a target — the switch went off, or the tab did. */
  forget: (key: string) => void;
}

/** Same shape as the schedules cache key, and for the same reason: a target id
 *  is only unique inside its scope. */
export function continueKey(projectId: string, scheduleTargetId: string): string {
  return `${projectId}\u0000${scheduleTargetId}`;
}

export const useAgentContinueStore = create<AgentContinueStore>((set) => ({
  byTarget: {},
  patch: (key, patch) =>
    set((state) => ({
      byTarget: { ...state.byTarget, [key]: { ...(state.byTarget[key] ?? BLANK), ...patch } },
    })),
  forget: (key) =>
    set((state) => {
      if (!(key in state.byTarget)) return {};
      const byTarget = { ...state.byTarget };
      delete byTarget[key];
      return { byTarget };
    }),
}));

export function _resetAgentContinueForTest(): void {
  useAgentContinueStore.setState({ byTarget: {} });
}
