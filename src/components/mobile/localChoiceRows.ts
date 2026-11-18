import type { ProjectEntry } from "../../types";
import type { LocalDriverInfo } from "../../lib/agents/localDrivers";
import { isCutNetwork, isLocalModelsOnly, offeredLocalAgents } from "../../lib/projects/localModelsOnly";

/** One row of the phone's ＋ sheet "local model" group: `driver` is the registry id, absent for Mistral. */
export interface LocalChoiceRow {
  key: string;
  label: string;
  caution: boolean;
  driver: string | undefined;
}

/**
 * The rows the phone offers for the local model, in the desktop's order: the
 * light-harness drivers (OpenCode), Mistral when installed and enabled, then the
 * other available drivers. In a Local models only project the same rule as the
 * desktop menus applies (`offeredLocalAgents`): OpenCode is hidden with the network
 * on and offered again with Cut network on, where only the drivers verified with
 * the network cut are listed. The backend refuses the rest either way.
 */
export function localChoiceRows(
  drivers: readonly LocalDriverInfo[],
  withVibe: boolean,
  project: Pick<ProjectEntry, "agent_privacy"> | undefined,
): LocalChoiceRow[] {
  const row = (d: LocalDriverInfo): LocalChoiceRow => ({ key: d.id, label: d.label, caution: d.heavy_harness, driver: d.id });
  const offered = offeredLocalAgents(drivers, isLocalModelsOnly(project), isCutNetwork(project));
  const available = offered.drivers.filter((d) => d.available);
  return [
    ...available.filter((d) => !d.heavy_harness).map(row),
    ...(withVibe && offered.vibe ? [{ key: "vibe", label: "Mistral", caution: false, driver: undefined }] : []),
    ...available.filter((d) => d.heavy_harness).map(row),
  ];
}
