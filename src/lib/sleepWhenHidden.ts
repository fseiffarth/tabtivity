import { useEffect, useState } from "react";

/**
 * The sleep/wake seam for a pane that releases what it holds after a while off
 * screen (performance plan §4.3; §5.3's `<SleepingPane>` generalises it).
 *
 * `asleep` turns true once the pane has been `hidden` for `afterMs` with no
 * `hold`, and false the moment it is shown again — in the same render, so the
 * host remounts its body before the user sees the empty slot. A hold (unsaved
 * work, a build in flight, a popout mirroring the tab) cancels the countdown;
 * when it lifts while the pane is still hidden, the countdown starts over. A
 * hold raised while already asleep changes nothing: there is nothing left to
 * keep, and the wake reload serves it as a fresh mount would.
 *
 * The host decides what sleeping means — unmounting a viewer body so its own
 * teardown releases documents, workers and timers, and so its mount path
 * restores the persisted position. No timer runs while the pane is shown.
 */
export function useSleepWhenHidden({
  hidden,
  afterMs,
  hold = false,
}: {
  hidden: boolean;
  afterMs: number;
  hold?: boolean;
}): boolean {
  const [asleep, setAsleep] = useState(false);
  useEffect(() => {
    if (!hidden) {
      setAsleep(false);
      return;
    }
    if (hold) return;
    const id = window.setTimeout(() => setAsleep(true), afterMs);
    return () => window.clearTimeout(id);
  }, [hidden, hold, afterMs]);
  return asleep && hidden;
}
