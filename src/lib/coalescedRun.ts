/**
 * A refresh that a burst of triggers runs at most once per `delayMs`, and
 * never twice at the same time (perf plan §3.4: `fs-change` used to start a
 * pair of git subprocesses 120 ms after every event an agent's writes caused).
 *
 * The first `request()` arms a timer; later requests before it fires are
 * absorbed. A request (or the timer) landing while `run`'s promise is still
 * pending is remembered as ONE follow-up run, armed when it settles, so the
 * last change is never lost and runs never stack. Unlike a trailing debounce,
 * a steady stream of triggers still runs every `delayMs` instead of never.
 */
export interface CoalescedRun {
  request: () => void;
  /** Drop a pending timer and follow-up for good (unmount, the question
   *  changed); later requests are ignored. */
  cancel: () => void;
}

export function coalescedRun(run: () => Promise<unknown> | void, delayMs: number): CoalescedRun {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let again = false;
  let cancelled = false;

  const fire = () => {
    timer = null;
    if (cancelled) return;
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = true;
    let pending: Promise<unknown>;
    try {
      pending = Promise.resolve(run());
    } catch (error) {
      pending = Promise.reject(error);
    }
    void pending
      .catch(() => {})
      .finally(() => {
        inFlight = false;
        if (again && !cancelled) {
          again = false;
          request();
        }
      });
  };

  const request = () => {
    if (cancelled) return;
    if (inFlight) {
      again = true;
      return;
    }
    if (timer !== null) return;
    timer = setTimeout(fire, delayMs);
  };

  return {
    request,
    cancel: () => {
      cancelled = true;
      again = false;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
