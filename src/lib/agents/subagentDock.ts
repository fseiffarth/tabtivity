/**
 * What the Chat's subagent dock shows (`ReaderSubagentDock`): one pill per
 * subagent at work at the level on screen, crowded by count — never by
 * measuring — and the finished ones folded into one "✓ N done" pill.
 */

/** One subagent of the level the dock shows: the session's own, or the open
 *  subagent's siblings, or an open workflow run's agents. */
export interface DockAgent {
  /** Stable across reads, for React. */
  key: string;
  /** The handle that opens it; absent until its CLI has said where its
   *  conversation lives — a disabled "waiting" pill. */
  token?: string;
  /** Its kind (`Explore`); in a workflow run, its phase. */
  role?: string;
  task: string;
  /** The task was bounded by the desktop. */
  cut?: boolean;
  /** When it was spawned, which its pill's time counts from. */
  at?: string;
  /** At work (`subagentAtWork` or its open-path twin). */
  atWork: boolean;
  /** The subagent open in the chat: it keeps its pill once finished, so the
   *  selection stays visible. */
  selected?: boolean;
  /** A Claude `Workflow` run. */
  workflow?: boolean;
}

export interface DockPill {
  agent: DockAgent;
  /** In a workflow run: the phase label drawn before its phase's first pill. */
  phase?: string;
}

export interface DockModel {
  /** The pills drawn, in order. */
  pills: DockPill[];
  /** At-work pills folded into the `+N` pill, which opens the list. */
  more: number;
  /** More than `DOCK_COMPACT_AFTER` pills: each shows its kind only. */
  compact: boolean;
  /** The done pill's count: the finished ones, and those only earlier turns
   *  hold. Zero: no done pill. */
  done: number;
  /** The list's groups, in the level's own order. */
  running: DockAgent[];
  finished: DockAgent[];
  /** Whether a drawn pill shows a time, so the dock's clock must tick. */
  timed: boolean;
}

/** More pills than this and every pill turns compact. */
export const DOCK_COMPACT_AFTER = 3;
/** More pills than this and only `DOCK_FOLD_SHOWN` are drawn, then `+N`. */
export const DOCK_FOLD_AFTER = 6;
export const DOCK_FOLD_SHOWN = 5;

/** Whether `at` is a start stamp a pill can count from. */
export function dockTimed(agent: Pick<DockAgent, "at" | "atWork">): boolean {
  return agent.atWork && !!agent.at && Number.isFinite(Date.parse(agent.at));
}

/** The dock's pills for `agents`. `phases` labels a workflow run's phases;
 *  `earlier` counts the subagents only earlier turns hold, into the done
 *  pill. */
export function dockModel(agents: readonly DockAgent[], { phases = false, earlier = 0 }: { phases?: boolean; earlier?: number } = {}): DockModel {
  const running = agents.filter((agent) => agent.atWork);
  const finished = agents.filter((agent) => !agent.atWork);
  const shown = agents.filter((agent) => agent.atWork || agent.selected);
  let drawn = shown;
  if (shown.length > DOCK_FOLD_AFTER) {
    drawn = shown.slice(0, DOCK_FOLD_SHOWN);
    // The open one is never folded away.
    const selected = shown.findIndex((agent) => agent.selected);
    if (selected >= DOCK_FOLD_SHOWN) drawn = [...shown.slice(0, DOCK_FOLD_SHOWN - 1), shown[selected]];
  }
  const pills = drawn.map((agent, index): DockPill => {
    const phase = phases && agent.role && (index === 0 || drawn[index - 1].role !== agent.role) ? agent.role : undefined;
    return phase ? { agent, phase } : { agent };
  });
  return {
    pills,
    more: shown.length - drawn.length,
    compact: shown.length > DOCK_COMPACT_AFTER,
    done: finished.length + Math.max(0, earlier),
    running,
    finished,
    timed: drawn.some((agent) => dockTimed(agent)),
  };
}
