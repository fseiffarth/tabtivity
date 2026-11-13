import type { SteeringBaseLevel } from "../../stores/keyboardSteering";

/** What `requestProjectJump` sends: the steering level to return to once a
 *  project is picked (or the jump is cancelled), and whether the jump box
 *  answered. */
export interface ProjectJumpDetail {
  level: SteeringBaseLevel;
  handled: boolean;
}

/** Window event `SteeringProjectJump` answers by opening its box over the
 *  window, so steering can switch to any project by name or ring digit. The
 *  box's state is its own, hence an event rather than a store. */
export const PROJECT_JUMP_EVENT = "app:project-jump";

/** Ask the jump box to take the keyboard; false when none is mounted. */
export function requestProjectJump(level: SteeringBaseLevel): boolean {
  const detail: ProjectJumpDetail = { level, handled: false };
  window.dispatchEvent(new CustomEvent<ProjectJumpDetail>(PROJECT_JUMP_EVENT, { detail }));
  return detail.handled;
}
