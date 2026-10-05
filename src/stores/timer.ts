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
      const appElapsed = s.appStartedAt != null ? (now - s.appStartedAt) / 1000 : 0;
      const projElapsed =
        s.projectStartedAt != null && s.activeProjectId
          ? (now - s.projectStartedAt) / 1000
          : 0;
      await Promise.all([
        invoke("timer_flush_app", { secs: appElapsed }).catch(() => {}),
        s.activeProjectId && projElapsed > 0
          ? invoke("timer_flush_project", {
              projectId: s.activeProjectId,
              secs: projElapsed,
            }).catch(() => {})
          : Promise.resolve(),
      ]);
      set({
        paused: true,
        appStartedAt: null,
        appCommittedSecs: s.appCommittedSecs + appElapsed,
        projectStartedAt: null,
        projectCommittedSecs: s.projectCommittedSecs + projElapsed,
      });
    } else {
      set({ paused: false, appStartedAt: Date.now(), projectStartedAt: Date.now() });
    }
  },

  setProject: async (newId) => {
    const s = get();
    const now = Date.now();
    if (s.activeProjectId && !s.paused && s.projectStartedAt != null) {
      const elapsed = (now - s.projectStartedAt) / 1000;
      if (elapsed > 0) {
        await invoke("timer_flush_project", {
          projectId: s.activeProjectId,
          secs: elapsed,
        }).catch(() => {});
      }
    }
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
    // Never attribute more seconds to today than have actually elapsed since
    // UTC midnight. This prevents overnight gaps (app started yesterday, first
    // flush fires today) from bloating today's total.
    const todayStartMs = Math.floor(now / 86400000) * 86400000;
    const appElapsed = !s.paused && s.appStartedAt != null
      ? Math.min((now - s.appStartedAt) / 1000, (now - todayStartMs) / 1000) : 0;
    const projElapsed = !s.paused && s.projectStartedAt != null && s.activeProjectId
      ? Math.min((now - s.projectStartedAt) / 1000, (now - todayStartMs) / 1000) : 0;
    await Promise.all([
      appElapsed > 0
        ? invoke("timer_flush_app", { secs: appElapsed }).catch(() => {})
        : Promise.resolve(),
      projElapsed > 0 && s.activeProjectId
        ? invoke("timer_flush_project", { projectId: s.activeProjectId, secs: projElapsed }).catch(() => {})
        : Promise.resolve(),
    ]);
    // Reload committed secs from the backend so day-boundary crossings are
    // handled correctly (in-memory accumulation would carry yesterday's total
    // into today once Tabtivity runs past midnight).
    if (!s.paused) {
      const [newAppSecs, newProjSecs] = await Promise.all([
        invoke<number>("get_time_today", { projectId: APP_TIMER_ID }).catch(
          () => s.appCommittedSecs + appElapsed,
        ),
        s.activeProjectId
          ? invoke<number>("get_time_today", { projectId: s.activeProjectId }).catch(
              () => s.projectCommittedSecs + projElapsed,
            )
          : Promise.resolve(s.projectCommittedSecs + projElapsed),
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
    const elapsed =
      !s.paused && s.appStartedAt != null ? (Date.now() - s.appStartedAt) / 1000 : 0;
    return s.appCommittedSecs + elapsed;
  },

  getProjectSecs: () => {
    const s = get();
    const elapsed =
      !s.paused && s.projectStartedAt != null
        ? (Date.now() - s.projectStartedAt) / 1000
        : 0;
    return s.projectCommittedSecs + elapsed;
  },
}));
