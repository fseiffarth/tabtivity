import { useEffect } from "react";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

/**
 * The Mobile host's runtime status (`mobile_host_status`) as ONE shared
 * reading, the pattern of `stores/remote/hostSessions`.
 *
 * The header's Mobile indicator and every Files view showing its phone toggle
 * (side panel, Files tabs, docked columns) each used to poll the sidecar's
 * admin socket every 15 s and on every window focus. The host is machine-wide,
 * so its status is one fact: subscribers are refcounted (`retain`/`release`,
 * via `useMobileHostStatus`), and one interval plus one focus listener exist
 * only while at least one surface is showing.
 *
 * Unlike the sessions list, the reading is dropped when the last subscriber
 * leaves: every surface used to start from "no reading" on mount, and a stale
 * `running` must not light a phone toggle before the first answer lands.
 */

/** Mirrors the backend `mobile_host_status` answer. */
export interface MobileHostRuntimeStatus {
  configured: boolean;
  running: boolean;
  port?: number;
  origin?: string;
  error?: string | null;
  installed_version?: string | null;
  update_available: boolean;
}

/** How often the shared poll re-reads the host. */
export const MOBILE_HOST_POLL_MS = 15_000;
// `systemctl --user restart` acknowledges the job before the replacement
// sidecar has necessarily rebound its admin socket. A short bounded wait keeps
// that expected hand-off from being rendered as a failed reconnect.
const READY_ATTEMPTS = 20;
const READY_RETRY_MS = 250;

interface MobileHostStatusStore {
  status: MobileHostRuntimeStatus | null;
  /** A status read is in flight (the indicator shows "checking"). */
  refreshing: boolean;
  /** Why the last status read failed (`status` is then null). */
  error: string | null;
  retain: () => void;
  release: () => void;
  /**
   * Read the status now. A plain refresh is skipped while one is already in
   * flight or a restart holds the reading (`beginRestart`); `waitForHost`
   * (the restart's own read) retries until the host answers `running`.
   */
  refresh: (waitForHost?: boolean) => Promise<void>;
  /** Write a reading taken elsewhere; any read in flight is superseded. */
  publish: (status: MobileHostRuntimeStatus) => void;
  /** Hold off plain refreshes and drop answers in flight while the sidecar is
   *  replaced: an old `ECONNREFUSED` landing after the restart's successful
   *  read would repaint the indicator red. Paired with `endRestart`. */
  beginRestart: () => void;
  endRestart: () => void;
}

let refs = 0;
let poll: { iv: ReturnType<typeof setInterval>; onFocus: () => void } | null = null;
/** Bumped per read and by `publish`/`beginRestart`/last `release`: only the
 *  newest read may write. */
let request = 0;
let inFlight = 0;
let restarting = 0;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const useMobileHostStatusStore = create<MobileHostStatusStore>((set, get) => ({
  status: null,
  refreshing: false,
  error: null,

  retain: () => {
    refs += 1;
    if (refs > 1) return;
    void get().refresh();
    const onFocus = () => void get().refresh();
    window.addEventListener("focus", onFocus);
    poll = { iv: setInterval(() => void get().refresh(), MOBILE_HOST_POLL_MS), onFocus };
  },

  release: () => {
    refs = Math.max(0, refs - 1);
    if (refs > 0) return;
    if (poll) {
      clearInterval(poll.iv);
      window.removeEventListener("focus", poll.onFocus);
      poll = null;
    }
    request += 1;
    set({ status: null, refreshing: false, error: null });
  },

  refresh: async (waitForHost = false) => {
    if (!waitForHost && (restarting > 0 || inFlight > 0)) return;
    const mine = ++request;
    inFlight += 1;
    set({ refreshing: true, error: null });
    try {
      let next: MobileHostRuntimeStatus | null = null;
      for (let attempt = 0; attempt < (waitForHost ? READY_ATTEMPTS : 1); attempt += 1) {
        next = await invoke<MobileHostRuntimeStatus>("mobile_host_status");
        if (next.running || !waitForHost || attempt === READY_ATTEMPTS - 1) break;
        await pause(READY_RETRY_MS);
      }
      if (mine === request) set({ status: next });
    } catch (reason) {
      if (mine === request) set({ status: null, error: String(reason) });
    } finally {
      inFlight -= 1;
      if (mine === request) set({ refreshing: false });
    }
  },

  publish: (status) => {
    request += 1;
    set({ status, refreshing: false, error: null });
  },

  beginRestart: () => {
    restarting += 1;
    request += 1;
  },

  endRestart: () => {
    restarting = Math.max(0, restarting - 1);
    // A read superseded by `beginRestart` never clears its own flag.
    if (inFlight === 0) set({ refreshing: false });
  },
}));

/** Subscribe a surface to the shared reading while `enabled`; returns it. */
export function useMobileHostStatus(enabled: boolean): MobileHostRuntimeStatus | null {
  useEffect(() => {
    if (!enabled) return;
    const { retain, release } = useMobileHostStatusStore.getState();
    retain();
    return release;
  }, [enabled]);
  return useMobileHostStatusStore((s) => s.status);
}

/** Tests only: forget every subscriber, timer and reading. */
export function __resetMobileHostStatusForTests(): void {
  if (poll) {
    clearInterval(poll.iv);
    window.removeEventListener("focus", poll.onFocus);
    poll = null;
  }
  refs = 0;
  inFlight = 0;
  restarting = 0;
  request += 1;
  useMobileHostStatusStore.setState({ status: null, refreshing: false, error: null });
}
