/**
 * Steering in a popout window: which keys it cannot run there.
 *
 * A popout steers its own subwindows and tabs (`useSteering`, surface
 * `"popout"`). Some keys have no target in it: the projects and the project
 * jump, mail / calendar / to-do, the cockpit, settings, the side panel and the
 * panels live only in the main window — those hand the keyboard over and run
 * there. Others cross windows by nature: J walks the popouts and the main
 * window, the status jumps and Back land on a tab wherever it lives. The main
 * window owns all of that (the status lists, the Back record, the popout order),
 * so a popout asks it rather than computing them from its own empty store.
 */
import type { SteeringAction } from "./steeringBindings";

/** Keys whose target exists only in the main window. The popout's bar lists
 *  them in their own "Main window" group. */
export const POPOUT_MAIN_ONLY: ReadonlySet<SteeringAction> = new Set<SteeringAction>([
  "newProject",
  "jumpProject",
  "mail",
  "calendar",
  "todo",
  "cockpit",
  "sidePanel",
  "panels",
  "settings",
]);

/** Keys that move between windows: J, the status jumps and Back. */
export const POPOUT_CROSS_WINDOW: ReadonlySet<SteeringAction> = new Set<SteeringAction>([
  "popout",
  "nextDecision",
  "nextWorking",
  "nextDone",
  "jumpBack",
]);

/** Every key a popout does not run itself: it hands them to the main window. */
export const POPOUT_HANDS_OVER: ReadonlySet<SteeringAction> = new Set<SteeringAction>([
  ...POPOUT_MAIN_ONLY,
  ...POPOUT_CROSS_WINDOW,
]);
