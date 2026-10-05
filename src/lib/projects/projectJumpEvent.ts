import type { SteeringBaseLevel } from "../../stores/keyboardSteering";

/** What `requestProjectJump` sends: the steering level to return to once a
 *  project is picked (or the search is cancelled), and whether a header
 *  project search answered. */
export interface ProjectJumpDetail {
  level: SteeringBaseLevel;
  handled: boolean;
}

/** Window event the header's `ProjectSearch` answers by taking the keyboard in
 *  jump mode — open projects listed too, not only the inactive ones — so
 *  steering can switch to any project by name. The search box is that bar's
 *  local state, hence an event rather than a store. */
export const PROJECT_JUMP_EVENT = "app:project-jump";

/** Ask the project search to take the keyboard; false when none is mounted. */
export function requestProjectJump(level: SteeringBaseLevel): boolean {
  const detail: ProjectJumpDetail = { level, handled: false };
  window.dispatchEvent(new CustomEvent<ProjectJumpDetail>(PROJECT_JUMP_EVENT, { detail }));
  return detail.handled;
}
