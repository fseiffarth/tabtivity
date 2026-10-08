import { useEffect } from "react";
import { usePaneVisible } from "../components/embed/fileAccess";
import { energySaverActive, saverInterval, usePowerStore } from "../stores/power";
import { useSettingsStore } from "../stores/settings";

/**
 * The one quiesce-aware periodic poll (performance plan §2, §3.3).
 *
 * A UI poll exists to keep something on screen current, so it has no reason to
 * run while nobody can be looking at it: it stops while this window is blurred
 * (`stores/power`'s `blurred`, fed per window by `startFocusTracking`) or
 * hidden (`document.hidden`), and — for the hook — while its pane is hidden
 * (`PaneVisibleContext`) or the caller's own gate (`enabled`) is off. When the
 * window comes back the run that fell due while it was away happens at once
 * (the catch-up), then the cadence resumes from it. Energy Saver widens the
 * interval (`saverInterval`, ×3) instead of stopping it.
 *
 * Runs never overlap: the next one is armed only once the previous one's
 * promise settles, on the cadence counted from its start (a fixed rate, not
 * `interval + run time`). A run that outlasts its interval skips the ticks it
 * covered — `setInterval` with an in-flight guard — so a slow or wedged
 * backend is asked once per interval, never back to back.
 *
 * NOT for the hosts that must run unfocused by construction — schedulers
 * (`AgentScheduleHost`, `AgentContinueHost`, `AgentCronHost`), calendar alarms,
 * CalDAV sync and the timer-lease heartbeat (`TimerLeaseHost`): stopping those
 * when another window is focused would stop scheduled prompts, cron, reminders,
 * sync and the lease. They keep their own timers.
 */

export interface PollOptions {
  /** Stop while this window is blurred or hidden. Default true; false keeps
   *  only the overlap guard and the cadence (a poll that must run unfocused). */
  quiesce?: boolean;
  /** Run once when the poll starts. Default true. With false the first run is
   *  one interval after the start (the caller has just read). A start inside a
   *  hidden window defers that first run to the catch-up when it is shown. */
  immediate?: boolean;
  /** On resume (focus, the window shown) run at once if the last run started
   *  at least this long ago; otherwise the cadence just carries on. Default
   *  `intervalMs` (catch up only on a run that fell due); 0 re-reads on every
   *  return to the window. */
  catchUpAfterMs?: number;
  /** When the shared reading last started, if other paths read it too (a
   *  store's forced refresh): the catch-up and the next tick count from the
   *  later of this and the poll's own last run. */
  lastRunAt?: () => number;
  /** Energy Saver widens the interval by this factor. Default 3; 1 = never. */
  saverFactor?: number;
}

export interface Poll {
  /** Change the cadence (the next run is re-armed from the last one's start). */
  setIntervalMs: (ms: number) => void;
  /** Stop for good: no further run, an in-flight one arms nothing. */
  stop: () => void;
}

const now = () => Date.now();

function windowHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/**
 * Start a poll outside React (a refcounted store's shared reading). Pair with
 * `stop()`. See the module comment for what pauses it.
 */
export function startPoll(
  run: () => unknown,
  intervalMs: number,
  options: PollOptions = {},
): Poll {
  const quiesce = options.quiesce ?? true;
  const factor = options.saverFactor ?? 3;
  let interval = intervalMs;
  let lastStart = Number.NEGATIVE_INFINITY;
  let inFlight = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let saver = energySaverActive();

  const paused = () => stopped || (quiesce && (usePowerStore.getState().blurred || windowHidden()));
  const since = () => Math.max(lastStart, options.lastRunAt?.() ?? Number.NEGATIVE_INFINITY);
  const period = () => saverInterval(interval, saver, factor);

  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const fire = () => {
    clear();
    inFlight = true;
    lastStart = now();
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
        arm();
      });
  };

  /** Arm the next tick on the cadence of the last run's start (never two at
   *  once; ticks a slow run covered are skipped, not made up). */
  const arm = () => {
    clear();
    if (inFlight || paused()) return;
    const p = period();
    const elapsed = now() - since();
    const delay = !Number.isFinite(elapsed) ? 0 : elapsed < p ? p - elapsed : p - (elapsed % p);
    timer = setTimeout(() => {
      timer = null;
      if (!inFlight && !paused()) fire();
    }, delay);
  };

  /** Back on screen (or a gate moved): the catch-up if one is due, else re-arm. */
  const resume = () => {
    if (inFlight || paused()) {
      if (paused()) clear();
      return;
    }
    const catchUp = options.catchUpAfterMs ?? interval;
    if (now() - since() >= catchUp) fire();
    else arm();
  };

  if (options.immediate === false) lastStart = now();
  if (options.immediate !== false && !(quiesce && windowHidden())) fire();
  else arm();

  // Pause/resume on this window's blur and Energy Saver; `focus` itself also
  // resumes (a window whose focus tracking never ran still re-reads on return).
  let blurred = usePowerStore.getState().blurred;
  const unsubPower = usePowerStore.subscribe((s) => {
    const nextSaver = energySaverActive();
    if (s.blurred === blurred && nextSaver === saver) return;
    const blurChanged = s.blurred !== blurred;
    blurred = s.blurred;
    saver = nextSaver;
    if (blurChanged) resume();
    else arm();
  });
  const unsubSettings = useSettingsStore.subscribe(() => {
    const nextSaver = energySaverActive();
    if (nextSaver === saver) return;
    saver = nextSaver;
    arm();
  });
  const onFocus = () => resume();
  const onVisibility = () => resume();
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisibility);

  return {
    setIntervalMs: (ms) => {
      if (ms === interval) return;
      interval = ms;
      arm();
    },
    stop: () => {
      stopped = true;
      clear();
      unsubPower();
      unsubSettings();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    },
  };
}

export interface UsePollOptions extends PollOptions {
  /** The caller's own gate (a menu open, the right view, a connection up).
   *  Default true. Turning it on starts afresh, like an effect re-running. */
  enabled?: boolean;
}

/**
 * Run `run` every `intervalMs` while the caller is on screen (see the module
 * comment). Also stops while the surrounding viewer pane is hidden
 * (`PaneVisibleContext`; true outside a gated pane, so a pane that only has a
 * `visible` prop passes it as `enabled`).
 *
 * `run` is a dependency like an effect's: pass a stable `useCallback`. A new
 * `run` — its inputs changed — restarts the poll with an immediate run, which
 * is how the effects this replaces behaved.
 */
export function usePoll(run: () => unknown, intervalMs: number, options: UsePollOptions = {}): void {
  const paneVisible = usePaneVisible();
  const active = (options.enabled ?? true) && paneVisible;
  const { quiesce, immediate, catchUpAfterMs, saverFactor, lastRunAt } = options;
  useEffect(() => {
    if (!active) return;
    const poll = startPoll(run, intervalMs, { quiesce, immediate, catchUpAfterMs, saverFactor, lastRunAt });
    return poll.stop;
  }, [active, run, intervalMs, quiesce, immediate, catchUpAfterMs, saverFactor, lastRunAt]);
}
