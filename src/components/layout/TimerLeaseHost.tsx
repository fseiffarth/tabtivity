import { useEffect } from "react";
import { HEARTBEAT_MS, useTimerLeaseStore } from "../../stores/timerLease";

/**
 * Keeps this window's timer lease alive (see `stores/timerLease`): one probe
 * on mount, then a heartbeat, and a release on unmount so another window
 * takes over at once. Renders nothing. Mounted once, at the shell, before the
 * hosts it gates.
 */
export function TimerLeaseHost() {
  useEffect(() => {
    const probe = useTimerLeaseStore.getState().probe;
    void probe();
    const timer = window.setInterval(() => void probe(), HEARTBEAT_MS);
    return () => {
      window.clearInterval(timer);
      void useTimerLeaseStore.getState().release();
    };
  }, []);
  return null;
}
