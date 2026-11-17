import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { runWithProgress } from "../lib/runWithProgress";

/**
 * Headless installer runs (`install_agent` / `update_agent` / `install_ollama`
 * / `install_vibe`), held at module level and keyed by what they install, so
 * the run outlives the view that started it: Settings → Manage CLIs and the
 * intro both read it, a page that is left and opened again mid-install shows
 * the same run, and a second start while one runs joins it instead of asking
 * the backend again (single flight across every view of this window).
 *
 * The backend holds the same lock per key (`agent_install::begin_install`);
 * its refusal means a run this window did not start (another window, a
 * browser client) is going on. That is never shown as a failure: the run
 * waits on `detect` until the thing is there or the wait gives up quietly.
 */
export interface InstallRun {
  /** A run is going on (here, or elsewhere and this one waits on it). */
  running: boolean;
  /** The backend refused because another run holds the lock; no log here. */
  elsewhere: boolean;
  /** The live installer output. */
  log: string;
  /** The last failure, or a note a view set (a recheck miss). */
  error: string | null;
  /** Bumped when a run ends successfully, so a view mounted later can react. */
  succeeded: number;
}

interface InstallRunsState {
  runs: Record<string, InstallRun>;
}

export const useInstallRunsStore = create<InstallRunsState>(() => ({ runs: {} }));

const EMPTY: InstallRun = { running: false, elsewhere: false, log: "", error: null, succeeded: 0 };

/** `agent_install::begin_install`'s refusal: another run holds the key. */
export const INSTALL_LOCK_REFUSAL = /already being installed or updated/i;

/** Re-detect cadence and patience while another run holds the lock. */
export const ELSEWHERE_POLL_MS = 3000;
const ELSEWHERE_MAX_POLLS = 200;

export function installRun(key: string): InstallRun {
  return useInstallRunsStore.getState().runs[key] ?? EMPTY;
}

export function patchInstallRun(key: string, patch: Partial<InstallRun>): void {
  useInstallRunsStore.setState((s) => ({ runs: { ...s.runs, [key]: { ...(s.runs[key] ?? EMPTY), ...patch } } }));
}

const inflight = new Map<string, Promise<boolean>>();

export interface InstallJob<P> {
  /** The progress event the backend streams lines on. */
  event: string;
  /** The line a payload carries, or null when it belongs to another run. */
  line: (payload: P) => string | null;
  /** The command and its arguments. */
  command: string;
  args?: Record<string, unknown>;
  /** Whether the thing is there now; polled while another run holds the lock. */
  detect: () => Promise<boolean>;
  /** Called once when the run succeeds (or the waited-on one turns up). */
  onSuccess?: () => void;
  /** Keep the log after a success (an update clears it, an install keeps it). */
  keepLog?: boolean;
}

/** Start the run for `key`, or join the one already going. Resolves to
 *  whether it ended with the thing installed. */
export function startInstallRun<P>(key: string, job: InstallJob<P>): Promise<boolean> {
  const going = inflight.get(key);
  if (going) return going;
  const run = (async () => {
    patchInstallRun(key, { running: true, elsewhere: false, error: null, log: "" });
    try {
      await runWithProgress<P, unknown>(
        job.event,
        (p) => {
          const line = job.line(p);
          if (line === null) return;
          const log = installRun(key).log;
          patchInstallRun(key, { log: log ? `${log}\n${line}` : line });
        },
        () => invoke(job.command, job.args),
      );
      succeed(key, job);
      return true;
    } catch (err) {
      const message = String(err);
      if (!INSTALL_LOCK_REFUSAL.test(message)) {
        patchInstallRun(key, { running: false, elsewhere: false, error: message });
        return false;
      }
      // Someone else's run: wait for it, never offer a second one.
      patchInstallRun(key, { elsewhere: true });
      for (let i = 0; i < ELSEWHERE_MAX_POLLS; i++) {
        await new Promise((r) => setTimeout(r, ELSEWHERE_POLL_MS));
        if (await job.detect().catch(() => false)) {
          succeed(key, job);
          return true;
        }
      }
      patchInstallRun(key, { running: false, elsewhere: false });
      return false;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, run);
  return run;
}

function succeed<P>(key: string, job: InstallJob<P>): void {
  const prev = installRun(key);
  patchInstallRun(key, {
    running: false,
    elsewhere: false,
    error: null,
    log: job.keepLog === false ? "" : prev.log,
    succeeded: prev.succeeded + 1,
  });
  job.onSuccess?.();
}

/** Tests only: forget every run. */
export function resetInstallRuns(): void {
  inflight.clear();
  useInstallRunsStore.setState({ runs: {} });
}
