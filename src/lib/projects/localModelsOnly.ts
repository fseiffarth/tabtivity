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

/** Whether Cut network is recorded on the project (the backend refuses to
 *  store it until the cut is enforced, so this is `false` today). */
export function isCutNetwork(project: Pick<ProjectEntry, "agent_privacy"> | null | undefined): boolean {
  const value: unknown = project?.agent_privacy;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = (value as Record<string, unknown>).cut_network;
  return !(v === undefined || v === null || v === false);
}

/** What `set_project_agent_privacy` answers. */
export interface AgentPrivacyChange {
  local_models_only: boolean;
  cut_network: boolean;
  /** The running agent tabs the backend ended because they were not a verified local launch. */
  closed_tabs: string[];
}
