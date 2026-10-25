import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { ScheduledAgentPrompt } from "../../lib/agents/agentSchedule";
import { useProjectsStore } from "../projects";
import { ROOT_SCOPE, useTabsStore } from "../tabs";

/**
 * Write one scope's tab layout to disk now, resolving the project.json it
 * exports to (none for the root scope or a box, whose layouts live in the state
 * dir only). CenterPanel's debounce saves the ACTIVE scope alone, so every
 * caller that edits a scope the desktop may not be showing needs this.
 *
 * Its first caller is the one this file is named for: a schedule is only as
 * durable as the tab binding it hangs off. The target id is minted in memory
 * when a layout written before schedules existed is restored, and the layout
 * otherwise reaches disk only when a tab is added, closed or moved — so a
 * schedule saved against a freshly minted id, followed by a quit with no tab
 * change, came back orphaned and was swept at the next launch. Writing the
 * scope after every schedule write pins the binding.
 */
export function persistScopeLayout(projectId: string): Promise<void> {
  const localFile = projectId === ROOT_SCOPE
    ? ""
    : useProjectsStore.getState().projects.find((project) => project.id === projectId)?.local_file ?? "";
  return useTabsStore.getState().persistScope(projectId, localFile).catch(() => {});
}

export function scheduleCacheKey(projectId: string, scheduleTargetId: string): string {
  return `${projectId}\u0000${scheduleTargetId}`;
}

/** The backend's refusal of a guarded edit (`expectExistingOn` /
 *  `expectUndelivered`) whose rule is gone, or was a one-time rule already
 *  delivered. The rejection is this exact string. */
export const SCHEDULE_GONE_ERROR = "schedule_gone";
/** The refusal while a delivery of the rule is claimed and not yet complete. */
export const SCHEDULE_BUSY_ERROR = "schedule_busy";

interface AgentSchedulesStore {
  byTarget: Record<string, ScheduledAgentPrompt[]>;
  loading: Record<string, boolean>;
  load: (projectId: string, scheduleTargetId: string) => Promise<ScheduledAgentPrompt[]>;
  /** `expectExistingOn`: the target an edited rule was drawn from — the write
   *  is refused rather than re-creating a rule the scheduler has delivered or
   *  is delivering since. Omitted, a plain write (a create, the phone). */
  upsert: (
    projectId: string,
    scheduleTargetId: string,
    schedule: ScheduledAgentPrompt,
    opts?: { expectExistingOn?: string },
  ) => Promise<ScheduledAgentPrompt[]>;
  /** `expectUndelivered`: refuse the same way instead of dropping a rule
   *  whose delivery already happened or is in flight. */
  remove: (
    projectId: string,
    scheduleTargetId: string,
    scheduleId: string,
    opts?: { expectUndelivered?: boolean },
  ) => Promise<void>;
  refreshLoaded: () => Promise<void>;
}

/** Per cache key: bumped each time a write stores a list, so a `list` that left
 *  before it cannot paint its older answer over it. */
const writeEpoch = new Map<string, number>();

export const useAgentSchedulesStore = create<AgentSchedulesStore>((set, get) => ({
  byTarget: {},
  loading: {},

  load: async (projectId, scheduleTargetId) => {
    const key = scheduleCacheKey(projectId, scheduleTargetId);
    set((state) => ({ loading: { ...state.loading, [key]: true } }));
    const epoch = writeEpoch.get(key) ?? 0;
    try {
      const schedules = await invoke<ScheduledAgentPrompt[]>("agent_schedules_list", {
        projectId,
        scheduleTargetId,
      });
      if ((writeEpoch.get(key) ?? 0) !== epoch) return get().byTarget[key] ?? schedules;
      set((state) => ({ byTarget: { ...state.byTarget, [key]: schedules } }));
      return schedules;
    } finally {
      set((state) => ({ loading: { ...state.loading, [key]: false } }));
    }
  },

  upsert: async (projectId, scheduleTargetId, schedule, opts) => {
    // The guard key is sent only when set, so every plain write keeps exactly
    // the shape a backend predating it accepts.
    const schedules = await invoke<ScheduledAgentPrompt[]>("agent_schedule_upsert", {
      projectId,
      scheduleTargetId,
      schedule,
      ...(opts?.expectExistingOn ? { expectExistingOn: opts.expectExistingOn } : {}),
    });
    const key = scheduleCacheKey(projectId, scheduleTargetId);
    writeEpoch.set(key, (writeEpoch.get(key) ?? 0) + 1);
    set((state) => ({ byTarget: { ...state.byTarget, [key]: schedules } }));
    void persistScopeLayout(projectId);
    return schedules;
  },

  remove: async (projectId, scheduleTargetId, scheduleId, opts) => {
    await invoke("agent_schedule_delete", {
      projectId,
      scheduleTargetId,
      scheduleId,
      ...(opts?.expectUndelivered ? { expectUndelivered: true } : {}),
    });
    const key = scheduleCacheKey(projectId, scheduleTargetId);
    writeEpoch.set(key, (writeEpoch.get(key) ?? 0) + 1);
    set((state) => ({
      byTarget: {
        ...state.byTarget,
        [key]: (state.byTarget[key] ?? []).filter((item) => item.id !== scheduleId),
      },
    }));
  },

  refreshLoaded: async () => {
    const keys = Object.keys(get().byTarget);
    await Promise.all(keys.map((key) => {
      const [projectId, scheduleTargetId] = key.split("\u0000");
      return get().load(projectId, scheduleTargetId).catch(() => []);
    }));
  },
}));
