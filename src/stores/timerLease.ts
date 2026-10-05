import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

/**
 * The single-client timer lease (headless owner plan, H2, interim).
 *
 * Scheduled prompts, auto-continue, the warm-up cron, calendar alarms and the
 * CalDAV sync are still fired by hosts in this window. Two Tabtivity processes on
 * one state dir would each fire them, so a host ticks only while this window
 * holds the lease the backend grants to one client at a time
 * (`services::timer_lease`). The lease is renewed by heartbeat and expires on
 * its own, so a window that died hands over within the backend's TTL.
 *
 * Granted, never assumed: a window holds nothing until the backend grants it
 * the lease, and a grant authorizes only until it would lapse — a renewal that
 * fails extends nothing, so a window that cannot reach the backend stops
 * firing once another window could have taken over. Until the first grant the
 * hosts skip their ticks; what came due meanwhile fires on their next one.
 *
 * The one exception is explicit: a backend without the command (an older
 * binary under a hot-reloaded `src/`) is the old single-process world, and the
 * window fires its timers there without expiry, exactly as before the lease.
 *
 * The expiry is this window's own clock, `Date.now()` at the request plus the
 * TTL, not the backend's `expiresAt`: the grant is made after the request
 * started, so the lease can only end later than that — except that the
 * backend counts in whole seconds, which `EXPIRY_SLACK_MS` covers. Both
 * sides read the same wall clock on the same machine, so a clock step moves
 * them alike (a monotonic clock here would not follow the backend's).
 */

/** This window's identity for the lease: fresh per page load, never persisted. */
export const TIMER_LEASE_CLIENT = crypto.randomUUID();

/** Well inside the backend's 30 s TTL. */
export const HEARTBEAT_MS = 10_000;

/** The backend's `timer_lease::TTL_SECS`; keep the two in step. */
export const LEASE_TTL_MS = 30_000;

/** The backend stamps the expiry in whole seconds from its own `now`,
 *  truncated, so its lease can end up to a second before request + TTL. */
const EXPIRY_SLACK_MS = 1_000;

export interface TimerLeaseState {
  /** The last answer was a grant (or the no-lease fallback). Says nothing
   *  about now on its own — `holdsTimerLease` also checks `validUntil`. */
  held: boolean;
  /** Who holds it when this window does not. */
  holder?: string;
  /** `Date.now()` from which this window's grant no longer authorizes:
   *  0 before any grant, `Infinity` on a backend without the lease. */
  validUntil: number;
}

interface TimerLeaseStore extends TimerLeaseState {
  /** One heartbeat: ask the backend, record the answer. */
  probe: () => Promise<void>;
  /** Hand the lease back on the way out. */
  release: () => Promise<void>;
}

function isUnknownCommand(error: unknown): boolean {
  return /(?:command\b.*\bnot found|unknown command|not allowed)/i.test(String(error));
}

export const useTimerLeaseStore = create<TimerLeaseStore>((set, get) => ({
  held: false,
  holder: undefined,
  validUntil: 0,

  probe: async () => {
    const requestedAt = Date.now();
    try {
      const state = await invoke<{ held: boolean; holder?: string } | undefined>("timer_lease_acquire", {
        clientId: TIMER_LEASE_CLIENT,
      });
      if (!state) throw new Error("no lease state");
      if (state.held) set({ held: true, holder: undefined, validUntil: requestedAt + LEASE_TTL_MS - EXPIRY_SLACK_MS });
      else set({ held: false, holder: state.holder, validUntil: 0 });
    } catch (error) {
      // No lease command: the old single-process world, where this window
      // fires its timers. Any other failure extends nothing: the last grant
      // runs out on its own, and the record says so once it has.
      if (isUnknownCommand(error)) set({ held: true, holder: undefined, validUntil: Infinity });
      else if (get().held && Date.now() >= get().validUntil) set({ held: false, holder: undefined });
    }
  },

  release: async () => {
    set({ held: false, holder: undefined, validUntil: 0 });
    try {
      await invoke("timer_lease_release", { clientId: TIMER_LEASE_CLIENT });
    } catch {
      // Best effort: the TTL hands it over anyway.
    }
  },
}));

/** Whether a timer host in this window may fire right now: a confirmed grant
 *  that has not lapsed. Asked at every tick, never cached. */
export function holdsTimerLease(): boolean {
  const { held, validUntil } = useTimerLeaseStore.getState();
  return held && Date.now() < validUntil;
}

/** For the timer hosts' tests: this window holds the lease, with no expiry. */
export function _grantTimerLeaseForTest(): void {
  useTimerLeaseStore.setState({ held: true, holder: undefined, validUntil: Infinity });
}
