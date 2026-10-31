import { useEffect, useRef, useState } from "react";
import { agentDeliveryTurn, agentTurnStartedAt, useActivityStore, type AgentTurnState } from "../../stores/activity";

// When an agent's turn ends, for the Chat's read-aloud and hands-free loop
// (docs/desktop_voice_plan.md step 4). The agent's hook verdict decides
// (`noteAgentTurn`: `done` or `decision`); only a tab with no hook record —
// an agent without turn hooks, or a popout window, which gets no verdicts —
// falls back to its busy lamp going idle. That lamp reads the terminal's
// output, so a long quiet tool call can look idle; the hooks cannot.

/** What one look at the tab says. */
export interface TurnReading {
  /** The last hook verdict on record, if the agent reports any. */
  hook: { state: AgentTurnState; at: number; startedAt?: number } | undefined;
  /** The busy lamp (`busyByTab`). */
  busy: boolean;
  /** When the current or last turn began: tool calls and answered approvals
   * do not move it. */
  turnStart?: number;
}

export function readTurn(ptyId: string): TurnReading {
  return { hook: agentDeliveryTurn(ptyId), busy: !!useActivityStore.getState().busyByTab[ptyId], turnStart: agentTurnStartedAt(ptyId) };
}

/** Whether the agent is at work now. */
export function turnWorking(reading: TurnReading): boolean {
  return reading.hook ? reading.hook.state === "working" : reading.busy;
}

/** A finished turn's identity: changes with each turn that ends, `null` while
 * one runs (or nothing is known). With hooks, a `done` or a `decision` is an
 * end; without, the lamp going idle after it was lit is (`litSince`: the time
 * it was last seen lit, which the caller keeps). */
export function turnEndKey(reading: TurnReading, litSince: number | null): string | null {
  const { hook } = reading;
  if (hook) return hook.state === "done" || hook.state === "decision" ? `${hook.state}@${hook.at}` : null;
  return !reading.busy && litSince !== null ? `idle@${litSince}` : null;
}

/** A turn's identity for announcing it: only a hook record can tell one. The
 * lamp can't: it dims between tool calls, and it lights before the first
 * hook of a tab, so one turn would count twice. */
export function turnStartKey(reading: TurnReading): number | null {
  return reading.hook ? reading.turnStart ?? null : null;
}

/**
 * Whether the turn a send at `sentAt` started is over — what hands-free waits
 * for before it opens the mic again. A prompt typed while the agent works
 * waits in its CLI's queue, so the `done` of the turn already running is not
 * this one's: with hooks, the end must be of a turn begun after the send, or
 * follow a new answer. A `decision` always is one — the agent waits on the
 * user. Without hooks, the lamp must have lit since the send and gone out.
 */
export function sentTurnOver(reading: TurnReading, sentAt: number, litSince: number | null, newAnswer: boolean): boolean {
  const { hook } = reading;
  if (hook) {
    if (hook.at < sentAt) return false;
    if (hook.state === "decision") return true;
    if (hook.state === "idle") return true;
    return hook.state === "done" && ((hook.startedAt ?? 0) >= sentAt || newAnswer);
  }
  return !reading.busy && litSince !== null && litSince >= sentAt;
}

/** How often the hook record is looked at while someone waits on it: the
 * activity store does not publish every verdict it records. */
const TURN_POLL_MS = 400;

/**
 * The tab's turn as it moves, while `watching`: whether it works, the key of
 * the last turn that ended (`turnEndKey`; what was ended before watching
 * began is in it too, so compare against a first value), the key of the last
 * turn begun since watching began (`turnStartKey`, `null` until one has), and
 * when the lamp was last seen lit. Reads the tab every `TURN_POLL_MS` and on
 * every store change.
 */
export function useAgentTurn(ptyId: string, watching: boolean) {
  const [state, setState] = useState<{ working: boolean; endKey: string | null; startKey: number | null; reading: TurnReading; litSince: number | null }>(
    () => ({ working: false, endKey: null, startKey: null, reading: { hook: undefined, busy: false }, litSince: null }),
  );
  const lit = useRef<number | null>(null);
  /** The turn on record when watching began; `undefined` until the first look. */
  const firstStart = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    if (!watching) return;
    firstStart.current = undefined;
    const look = () => {
      const reading = readTurn(ptyId);
      if (reading.busy) lit.current = Date.now();
      const working = turnWorking(reading);
      const endKey = turnEndKey(reading, lit.current);
      const start = turnStartKey(reading);
      if (firstStart.current === undefined) firstStart.current = start;
      const startKey = start === firstStart.current ? null : start;
      // `agentDeliveryTurn` may hand back a fresh object for the same verdict.
      const same = (a: TurnReading, b: TurnReading) =>
        a.busy === b.busy && a.hook?.state === b.hook?.state && a.hook?.at === b.hook?.at && a.hook?.startedAt === b.hook?.startedAt;
      // `litSince` moves on every look while lit; it is published with the
      // lamp's edges only, which is when it is read.
      setState((prev) => (prev.working === working && prev.endKey === endKey && prev.startKey === startKey && same(prev.reading, reading)
        ? prev
        : { working, endKey, startKey, reading, litSince: lit.current }));
    };
    look();
    const timer = setInterval(look, TURN_POLL_MS);
    const unsubscribe = useActivityStore.subscribe(look);
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }, [ptyId, watching]);
  return state;
}
