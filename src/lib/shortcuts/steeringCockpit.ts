import type { SteeringAction } from "./steeringBindings";
import { wrapStep } from "../wrapStep";
import { placeRegionCursor, pointRegionCursor, regionCursor, regionTargets } from "./steeringRegion";

/** The mounted roster owns its actions and current filtered rows. */
let rosterAction: ((action: SteeringAction, ptyId?: string) => string | null | void) | null = null;
export function registerCockpitRoster(action: (action: SteeringAction, ptyId?: string) => string | null | void): () => void {
  rosterAction = action;
  return () => { if (rosterAction === action) rosterAction = null; };
}
export function runCockpitRoster(action: SteeringAction): string | null | void {
  return rosterAction?.(action, regionCursor()?.closest<HTMLElement>("[data-pty]")?.dataset.pty);
}

export function inCockpitRoster(): boolean {
  return !!regionCursor()?.closest(".cockpit-roster-list");
}

/** Move between the actually mounted areas, including the frame's view tabs. */
export function stepCockpitArea(root: HTMLElement, backwards: boolean): void {
  const areas = [...root.querySelectorAll<HTMLElement>(
    ".root-overlay-bar, .cockpit-now-rail, .cockpit-now-icons, .cockpit-now-roster, .cockpit-now-detail, .cockpit-view:not(.cockpit-view-now)",
  )].filter((el) => regionTargets(el).length > 0);
  const current = regionCursor();
  const at = areas.findIndex((area) => current && area.contains(current));
  const next = areas[wrapStep(at, backwards ? -1 : 1, areas.length)];
  if (next) placeRegionCursor(next);
}

export function selectCockpitCursor(root: HTMLElement, ptyId?: string): void {
  const list = root.querySelector<HTMLElement>(".cockpit-roster-list");
  const row = ptyId
    ? [...(list?.querySelectorAll<HTMLElement>("[data-pty]") ?? [])].find((el) => el.dataset.pty === ptyId)
    : list?.querySelector<HTMLElement>('[aria-selected="true"]') ?? list?.querySelector<HTMLElement>('[role="option"]');
  if (row) pointRegionCursor(root, row);
}
