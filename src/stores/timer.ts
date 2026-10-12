import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { NAMES } from "../lib/brand";

export const APP_TIMER_ID = NAMES.appTimerId;

/**
 * The root terminal's own bucket in `time_log.json`. Time spent there is
 * tracked exactly as a project's is — it is a scope with a folder and tabs, and
 * work done in it is work done. It used to fall into the app total and into no
 * project at all, so an afternoon in the root terminal read as an afternoon
 * where nothing was worked on; the recap has always had a *name* for this id
 * (`stats.rootTerminal`), it just never had a row to put it on.
 *
 * The literal is the tabs/usage scope id (`stores/tabs`' `ROOT_SCOPE`),
 * restated rather than imported so this store keeps its single dependency on
 * the invoke surface.
 */
export const ROOT_TIMER_ID = "root";

interface TimerStore {
  paused: boolean;
  appStartedAt: number | null;
  appCommittedSecs: number;
  projectStartedAt: number | null;
  projectCommittedSecs: number;
  activeProjectId: string | null;

  /**
   * Call once after projects are loaded. `null` — no project is current — is
   * the ROOT scope and is tracked under {@link ROOT_TIMER_ID}, not dropped.
   */
  init: (projectId: string | null) => Promise<void>;
  /** Pause both app + project timers (flush to backend) or resume them. */
  toggle: () => Promise<void>;
  /**
   * Flush the old project, load committed secs for the new one, restart timer.
   * `null` is the root scope ({@link ROOT_TIMER_ID}) — the mapping lives here
   * rather than at the call sites so no future caller can spend an afternoon's
   * work on a scope that quietly records nothing.
   */
  setProject: (newId: string | null) => Promise<void>;
  /** Flush elapsed (uncommitted) time to the backend without changing state. */
  flush: () => Promise<void>;
  /** Live app-usage seconds today (committed + current interval). */
  getAppSecs: () => number;
  /** Live project seconds today (committed + current interval). */
  getProjectSecs: () => number;
}

const DAY_MS = 86_400_000;

/** Start of the UTC day `now` falls on — the backend's `time_log.json` day. */
function todayStartMs(now: number): number {
  return Math.floor(now / DAY_MS) * DAY_MS;
}

/**
 * Seconds of a run that started at `startedAt` and is still going at `now`
 * which fall on today (UTC). A run started before midnight books only the
 * part since midnight: the rest belonged to a day that is already closed, and
 * booking it now would bloat today's total (an overnight gap, or a pause or
 * project switch in the morning after a run left going overnight).
 */
export function elapsedToday(startedAt: number | null, now: number): number {
  if (startedAt == null) return 0;
  return Math.max(0, (now - Math.max(startedAt, todayStartMs(now))) / 1000);
}

/**
 * Today's total for a counter: `committedSecs` (today's as of `startedAt`)
 * plus the run since. A run that began before midnight means the committed
 * figure is yesterday's, so today's total is just the part since midnight.
 */
function totalToday(committedSecs: number, startedAt: number | null, now: number): number {
  const elapsed = elapsedToday(startedAt, now);
  return startedAt != null && startedAt < todayStartMs(now) ? elapsed : committedSecs + elapsed;
}

type TimerState = Pick<
  TimerStore,
  "paused" | "appStartedAt" | "projectStartedAt" | "activeProjectId"
>;

/**
 * Book the running counters' time since their start (today's part only) on the
 * backend. `app: false` leaves the app counter
 * running — a project switch only closes the project's run. A paused store
 * has nothing running and books nothing.
 */
async function flushRunning(
  s: TimerState,
  now: number,
  { app }: { app: boolean },
): Promise<void> {
  const appElapsed = app && !s.paused ? elapsedToday(s.appStartedAt, now) : 0;
  const projectId = s.activeProjectId;
  const projElapsed = !s.paused && projectId ? elapsedToday(s.projectStartedAt, now) : 0;
  await Promise.all([
    appElapsed > 0
      ? invoke("timer_flush_app", { secs: appElapsed }).catch(() => {})
      : Promise.resolve(),
    projectId && projElapsed > 0
      ? invoke("timer_flush_project", { projectId, secs: projElapsed }).catch(() => {})
      : Promise.resolve(),
  ]);
}

export const useTimerStore = create<TimerStore>((set, get) => ({
  paused: false,
  appStartedAt: null,
  appCommittedSecs: 0,
  projectStartedAt: null,
  projectCommittedSecs: 0,
  activeProjectId: null,

  init: async (projectId) => {
    const now = Date.now();
    const scopeId = projectId ?? ROOT_TIMER_ID;
    const [appSecs, projSecs] = await Promise.all([
      invoke<number>("get_time_today", { projectId: APP_TIMER_ID }).catch(() => 0),
      invoke<number>("get_time_today", { projectId: scopeId }).catch(() => 0),
    ]);
    set({
      paused: false,
      appStartedAt: now,
      appCommittedSecs: appSecs,
      projectStartedAt: now,
      projectCommittedSecs: projSecs,
      activeProjectId: scopeId,
    });
  },

  toggle: async () => {
    const s = get();
    const now = Date.now();
    if (!s.paused) {
      await flushRunning(s, now, { app: true });
      set({
        paused: true,
        appStartedAt: null,
        appCommittedSecs: totalToday(s.appCommittedSecs, s.appStartedAt, now),
        projectStartedAt: null,
        projectCommittedSecs: s.activeProjectId
          ? totalToday(s.projectCommittedSecs, s.projectStartedAt, now)
          : s.projectCommittedSecs,
      });
    } else {
      set({ paused: false, appStartedAt: Date.now(), projectStartedAt: Date.now() });
    }
  },

  setProject: async (newId) => {
    const s = get();
    const now = Date.now();
    await flushRunning(s, now, { app: false });
    const scopeId = newId ?? ROOT_TIMER_ID;
    const newCommitted = await invoke<number>("get_time_today", {
      projectId: scopeId,
    }).catch(() => 0);
    set({
      activeProjectId: scopeId,
      projectCommittedSecs: newCommitted,
      projectStartedAt: s.paused ? null : now,
    });
  },

  flush: async () => {
    const s = get();
    const now = Date.now();
    await flushRunning(s, now, { app: true });
    // Reload committed secs from the backend so day-boundary crossings are
    // handled correctly (in-memory accumulation would carry yesterday's total
    // into today once Tabtivity runs past midnight).
    if (!s.paused) {
      const [newAppSecs, newProjSecs] = await Promise.all([
        invoke<number>("get_time_today", { projectId: APP_TIMER_ID }).catch(
          () => totalToday(s.appCommittedSecs, s.appStartedAt, now),
        ),
        s.activeProjectId
          ? invoke<number>("get_time_today", { projectId: s.activeProjectId }).catch(
              () => totalToday(s.projectCommittedSecs, s.projectStartedAt, now),
            )
          : Promise.resolve(s.projectCommittedSecs),
      ]);
      set({
        appStartedAt: now,
        appCommittedSecs: newAppSecs,
        projectStartedAt: now,
        projectCommittedSecs: newProjSecs,
      });
    }
  },

  getAppSecs: () => {
    const s = get();
    return s.paused ? s.appCommittedSecs : totalToday(s.appCommittedSecs, s.appStartedAt, Date.now());
  },

  getProjectSecs: () => {
    const s = get();
    return s.paused
      ? s.projectCommittedSecs
      : totalToday(s.projectCommittedSecs, s.projectStartedAt, Date.now());
  },
}));
