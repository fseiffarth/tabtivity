/**
 * How long an agent tab has been at work on its current turn, or was on its
 * last one — the reading the phone's tab cards and the desktop cockpit's
 * roster print ("4m so far", "took 12m"). Shared so the two cannot disagree.
 *
 * `running` while the turn is not over: working, paused on a question, or
 * stopped with subagents still at work (they wake it when they finish). Every
 * number is the desktop's own clock — for a working tab, or one with subagents
 * at work, `workingAt` is the desktop's "now" — so no other clock enters it.
 * Nothing where the end is unknown: an interrupted turn fires no finish.
 * `end` is when the turn stopped, or the desktop's now while it runs.
 */
export interface TurnReading {
  status: "working" | "question" | "interrupted" | "done" | "idle" | undefined;
  turnStartedAt?: number;
  workingAt?: number;
  doneAt?: number;
  subagents?: number;
}

export interface TurnDuration {
  ms: number;
  running: boolean;
  end: number;
}

export function turnDurationOf(reading: TurnReading): TurnDuration | undefined {
  const start = reading.turnStartedAt;
  if (start === undefined) return undefined;
  const working = reading.status === "working" || (reading.subagents ?? 0) > 0;
  const running = working || reading.status === "question";
  const end = working
    ? reading.workingAt
    : [reading.doneAt, reading.workingAt].find((at) => at !== undefined && at >= start);
  if (end === undefined || end < start) return undefined;
  return { ms: end - start, running, end };
}
