/**
 * Stopping idle agent tabs (`docs/agent_tab_stop_plan.md`): the pure half.
 * A stopped tab keeps its place, its label and its conversation; its process
 * is ended and the tab respawns with its CLI's resume when it is shown again.
 * The settings readers here say when the sweep (`AgentTabStopHost`) stops a
 * tab; everything in this file is pure, so the policy is tested on its own.
 */
import type { Settings } from "../../types";

/** Live agent tabs kept before the least recently used are stopped. */
export const STOP_AGENT_TABS_CAP_DEFAULT = 30;
export const STOP_AGENT_TABS_CAP_CHOICES = [10, 20, 30, 50, 80] as const;
/** Minutes unused before a tab is stopped. */
export const STOP_AGENT_TABS_IDLE_DEFAULT_MIN = 120;
export const STOP_AGENT_TABS_IDLE_CHOICES_MIN = [30, 60, 120, 240, 480] as const;
/** Free memory (MiB) under which tabs are stopped. */
export const STOP_AGENT_TABS_MIN_FREE_DEFAULT_MB = 4096;
export const STOP_AGENT_TABS_MIN_FREE_CHOICES_MB = [2048, 4096, 8192] as const;

type StopSettings = Pick<Settings, "stop_agent_tabs_cap" | "stop_agent_tabs_idle_min" | "stop_agent_tabs_min_free_mb">;

/** A stored count: absent or junk → `fallback`, `0` → off (null). */
function stored(value: unknown, fallback: number): number | null {
  const n = typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
  return n === 0 ? null : n;
}

/** The cap on live agent tabs, or null when that trigger is off. */
export function stopAgentTabsCap(settings: StopSettings | null | undefined): number | null {
  return stored(settings?.stop_agent_tabs_cap, STOP_AGENT_TABS_CAP_DEFAULT);
}

/** How long a tab may sit unused before it is stopped, or null when off. */
export function stopAgentTabsIdleMs(settings: StopSettings | null | undefined): number | null {
  const min = stored(settings?.stop_agent_tabs_idle_min, STOP_AGENT_TABS_IDLE_DEFAULT_MIN);
  return min === null ? null : min * 60_000;
}

/** The free-memory floor in bytes, or null when that trigger is off. */
export function stopAgentTabsMinFreeBytes(settings: StopSettings | null | undefined): number | null {
  const mb = stored(settings?.stop_agent_tabs_min_free_mb, STOP_AGENT_TABS_MIN_FREE_DEFAULT_MB);
  return mb === null ? null : mb * 1024 * 1024;
}
