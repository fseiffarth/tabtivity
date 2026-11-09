import type { ProjectEntry } from "../../types";

/**
 * Local-models-only projects (`services::agent_privacy` on the backend): the
 * setting sits on the project's trusted record as
 * `agent_privacy: { local_models_only, cut_network }`, and the backend gate is
 * what enforces it. This is the frontend's reading of the same record, for the
 * lock badge and for hiding the cloud rows of the ＋ menu; hiding is a courtesy,
 * the spawn is refused by the backend either way.
 */

/** Same rule as the backend's `privacy_of`: absent or `null` is off, a
 *  malformed record reads as on. */
export function isLocalModelsOnly(project: Pick<ProjectEntry, "agent_privacy"> | null | undefined): boolean {
  const value: unknown = project?.agent_privacy;
  if (value === undefined || value === null) return false;
  if (typeof value !== "object" || Array.isArray(value)) return true;
  const on = (v: unknown) => !(v === undefined || v === null || v === false);
  return on((value as Record<string, unknown>).local_models_only);
}

/** Whether Cut network is recorded on the project (Linux: the backend accepts it
 *  and cuts the sandbox's network; elsewhere it refuses to store it). */
export function isCutNetwork(project: Pick<ProjectEntry, "agent_privacy"> | null | undefined): boolean {
  const value: unknown = project?.agent_privacy;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = (value as Record<string, unknown>).cut_network;
  return !(v === undefined || v === null || v === false);
}

/**
 * The local drivers (`list_local_drivers` ids) the backend gate refuses in a Local
 * models only project that keeps its network (`agent_privacy::vet`): OpenCode
 * re-reads a project config the agent writes mid-session and merges its provider and
 * model lists over the launch settings. With Cut network on its only way out is the
 * local lane, which judges every model, so it starts there. Hiding is a courtesy;
 * the spawn is refused either way.
 */
export const LOCKED_REFUSED_DRIVERS: readonly string[] = ["opencode"];

/**
 * The drivers that were run with the network cut (`agent_privacy::CUT_VERIFIED_DRIVERS`;
 * the table is in `docs/context/local_models_only.md`). With Cut network on the backend
 * refuses every other local driver, Mistral (`vibe`) included, naming it.
 */
export const CUT_VERIFIED_DRIVERS: readonly string[] = ["opencode", "claude", "codex"];

/** `drivers` without the ones a Local models only project refuses; with `cut`, only
 *  the ones verified with the network cut. */
export function driversForLockedProject<T extends { id: string }>(drivers: readonly T[], cut = false): T[] {
  return drivers.filter((d) => (cut ? CUT_VERIFIED_DRIVERS.includes(d.id) : !LOCKED_REFUSED_DRIVERS.includes(d.id)));
}

/** Whether the Mistral (vibe) row is offered: not with Cut network on (not verified there). */
export function vibeOfferedInLockedProject(cut: boolean): boolean {
  return !cut || CUT_VERIFIED_DRIVERS.includes("vibe");
}

/** What `set_project_agent_privacy` answers. */
export interface AgentPrivacyChange {
  local_models_only: boolean;
  cut_network: boolean;
  /** The running agent tabs the backend ended because they were not a verified local launch. */
  closed_tabs: string[];
  /** Agent tmux sessions ended although no window held a PTY on them (a phone-started headless tab, a session that outlived a crash). */
  closed_sessions?: string[];
  /** Running verified local tabs whose sandbox was built under the other Cut network
   *  setting (`<scope>:<tab key>`): they keep it until reopened. Offered, never restarted silently. */
  restart_tabs?: string[];
}
