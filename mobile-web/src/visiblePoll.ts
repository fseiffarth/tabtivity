import { useEffect, useRef } from "react";

/**
 * The phone's one "read this while the page is visible" poll — the twenty
 * hand-written copies of `setInterval` + `document.visibilityState` +
 * `visibilitychange` + an `AbortController` it replaces. (The desktop's is
 * `src/lib/usePoll.ts`; the phone has no window blur, power store or pane
 * context to consult, only whether the page is on screen.)
 *
 * A run starts at once (unless `immediate: false`), then every `intervalMs`,
 * and again when the page comes back to the screen (`catchUp`, default on).
 * A tick that fires while the page is hidden does nothing, so a phone left
 * with the screen off keeps no desktop round trip going.
 *
 * Latest wins: a tick that starts while the previous run is still in flight
 * aborts that run's `signal` and starts afresh. A request that hangs on a
 * flaky link is therefore retried every interval instead of blocking the poll
 * for good, and its late answer is dropped by the same `signal.aborted` check
 * the callers already make (`signal.aborted` is also true once the poll is
 * stopped — it stands in for the old `stopped` flag).
 */

export interface VisiblePollOptions {
  /** Run once when the poll starts. Default true. */
  immediate?: boolean;
  /** Run again when the page becomes visible. Default true. */
  catchUp?: boolean;
}

export interface VisiblePoll {
  /** Run now (still skipped while the page is hidden): the "read again" a
   *  caller wants after it changed something the poll shows. */
  now: () => void;
  /** Stop for good, aborting a run in flight. */
  stop: () => void;
}

/** A poll's body. A returned promise's rejection is swallowed — a read that
 *  fails keeps what is shown, and the next tick retries. */
export type VisiblePollRun = (signal: AbortSignal) => unknown;

/** Start a poll outside a hook (an effect with its own per-run state). Pair with `stop()`. */
export function startVisiblePoll(run: VisiblePollRun, intervalMs: number, options: VisiblePollOptions = {}): VisiblePoll {
  let stopped = false;
  let controller: AbortController | undefined;
  const tick = () => {
    if (stopped || document.visibilityState === "hidden") return;
    controller?.abort();
    const mine = new AbortController();
    controller = mine;
    try {
      void Promise.resolve(run(mine.signal)).catch(() => {});
    } catch {
      // A throwing run is a failed read like a rejected one.
    }
  };
  if (options.immediate !== false) tick();
  const timer = window.setInterval(tick, intervalMs);
  const onVisible = () => tick();
  if (options.catchUp !== false) document.addEventListener("visibilitychange", onVisible);
  return {
    now: tick,
    stop: () => {
      stopped = true;
      controller?.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    },
  };
}

export interface UseVisiblePollOptions extends VisiblePollOptions {
  /** The caller's own gate; turning it on starts afresh. Default true. */
  enabled?: boolean;
}

/**
 * `startVisiblePoll` as a hook. `run` is read through a ref, so a new closure
 * each render does not restart the poll; the poll restarts only when
 * `intervalMs`, `enabled`, or an entry of `deps` changes (the inputs `run`
 * reads that mean "a different thing to poll"). Returns the poll's `now`.
 */
export function useVisiblePoll(
  run: VisiblePollRun,
  intervalMs: number,
  options: UseVisiblePollOptions = {},
  deps: readonly unknown[] = [],
): () => void {
  const latest = useRef(run);
  latest.current = run;
  const poll = useRef<VisiblePoll | null>(null);
  const { enabled = true, immediate, catchUp } = options;
  useEffect(() => {
    if (!enabled) return;
    const started = startVisiblePoll((signal) => latest.current(signal), intervalMs, { immediate, catchUp });
    poll.current = started;
    return () => {
      started.stop();
      if (poll.current === started) poll.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `deps` is the caller's restart list
  }, [enabled, intervalMs, immediate, catchUp, ...deps]);
  return useRef(() => poll.current?.now()).current;
}
