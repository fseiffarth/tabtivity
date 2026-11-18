import { useMemo, useState } from "react";
import { scheduleCacheKey, useAgentSchedulesStore } from "../../stores/agents/agentSchedules";
import { nextScheduleOccurrence } from "./agentSchedule";

/** This tab's own enabled schedules: how many, and the soonest next run
 * (none for a non-agent or an unscheduled tab). Shared by the tab strip's
 * clock mark and the Chat's Schedule button. */
export function useTabSchedule(scope: string, targetId: string | undefined, isAgent: boolean) {
  // A store reference, so the next-occurrence sort below runs once per change
  // of the list rather than per render of the caller.
  const schedules = useAgentSchedulesStore((s) =>
    isAgent && targetId ? s.byTarget[scheduleCacheKey(scope, targetId)] : undefined,
  );
  // Recomputed against a fresh "now" on every list change, and again (via the
  // epoch) when the indicator is hovered after the shown occurrence has
  // passed: a cached one must refresh itself once the clock crosses it — a
  // run or an edit republishes the list, a skipped slot does not.
  const [epoch, setEpoch] = useState(0);
  const schedule = useMemo(() => {
    const enabled = (schedules ?? []).filter((item) => item.enabled);
    const now = new Date();
    const next = enabled
      .map((item) => nextScheduleOccurrence(item, now)?.at)
      .filter((at): at is Date => !!at)
      .sort((a, b) => a.getTime() - b.getTime())[0];
    return { count: enabled.length, next };
    // `epoch` looks unnecessary to the linter because the body reads the
    // clock, which it cannot see — the bump is what re-reads it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schedules, epoch]);
  const refreshNext = () => {
    if (schedule.next && schedule.next.getTime() <= Date.now()) setEpoch((n) => n + 1);
  };
  return { ...schedule, refreshNext };
}
