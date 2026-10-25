import { create } from "zustand";

/**
 * What the next message of a just-resumed Claude tab will cost, while it is
 * more than the usual.
 *
 * Claude Code 2.1.30x reports it in the resume's `SessionStart` payload
 * (`seconds_since_last_response`, `context_tokens`, `estimated_cache_write_usd`,
 * `prompt_cache_likely_expired`); the hook records it beside the session
 * record and `agent-session-roll` carries it here. Only an expired cache is
 * kept — a warm resume costs what any message does — and it is dropped when the
 * first prompt goes in (`agent-turn` → `working`), which is what spends it.
 * The figures are Claude's own estimates; nothing here prices anything.
 */
export interface ResumeCost {
  secondsIdle: number;
  contextTokens: number;
  cacheWriteUsd: number;
  cacheExpired: boolean;
}

interface AgentResumeCostStore {
  /** Composed PTY id → the cold-cache cost its last resume reported. */
  byPty: Record<string, ResumeCost>;
  /** A session (re)start the hook relayed, with the cost it carried, if any. */
  noteRoll: (ptyId: string, source: string, resume?: ResumeCost | null) => void;
  /** The tab's next prompt went in, or the card was dismissed. */
  dismiss: (ptyId: string) => void;
}

export const useAgentResumeCostStore = create<AgentResumeCostStore>((set, get) => ({
  byPty: {},
  noteRoll: (ptyId, source, resume) => {
    if (source === "resume" && resume?.cacheExpired) {
      set((state) => ({ byPty: { ...state.byPty, [ptyId]: resume } }));
    } else {
      get().dismiss(ptyId);
    }
  },
  dismiss: (ptyId) => {
    if (!(ptyId in get().byPty)) return;
    set((state) => {
      const { [ptyId]: _gone, ...rest } = state.byPty;
      return { byPty: rest };
    });
  },
}));

/** `$0.42`, `$12` — the dollar sign and separators of the user's locale. */
export function formatCacheWriteUsd(usd: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: usd < 10 ? 2 : 0,
  }).format(usd);
}

/** The idle time as one whole unit — `3 days`, `5 hours`, `40 minutes` — in the
 * user's locale. */
export function formatIdleTime(seconds: number): string {
  const [value, unit] =
    seconds >= 86_400 ? [Math.round(seconds / 86_400), "day"]
    : seconds >= 3_600 ? [Math.round(seconds / 3_600), "hour"]
    : [Math.max(1, Math.round(seconds / 60)), "minute"];
  return new Intl.NumberFormat(undefined, { style: "unit", unit, unitDisplay: "long" }).format(value);
}
