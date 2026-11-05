/**
 * Who is in front when the console window and the Machines / Models overlay are
 * both up (`stores/consoleCover`). The window is in front unless an overlay was
 * opened from it; the overlay's and the window's Escape handlers ask here so one
 * Escape closes only the front one.
 */
import { useConsoleCover } from "../../stores/consoleCover";
import { useMachinesOverlayStore } from "../../stores/machinesOverlay";
import { useModelsOverlayStore } from "../../stores/modelsOverlay";
import { useRootOverlayStore } from "../../stores/rootOverlay";

/** An overlay opened from the window is up over it. */
export function consoleUnderOverlay(): boolean {
  return (
    useConsoleCover.getState().covered &&
    (useMachinesOverlayStore.getState().open || useModelsOverlayStore.getState().open)
  );
}

/** The console window is up and nothing opened from it covers it. */
export function consoleInFront(): boolean {
  return useRootOverlayStore.getState().open && !consoleUnderOverlay();
}

/** The same fact for rendering: the window steps below the overlay's layer. */
export function useConsoleUnderOverlay(): boolean {
  const covered = useConsoleCover((s) => s.covered);
  const machines = useMachinesOverlayStore((s) => s.open);
  const models = useModelsOverlayStore((s) => s.open);
  return covered && (machines || models);
}
